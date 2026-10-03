//! Menu bar item: icon, live title, context menu, panel toggling, "time's up" notification.
//!
//! Rust owns the title. The page reports status changes through the `status` command; a 15 s
//! ticker recomputes elapsed minutes from wall-clock time, so the title stays right while the
//! webview is throttled or after the Mac wakes from sleep.

use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_notification::NotificationExt as _;
use tauri_plugin_positioner::{Position, WindowExt as _};

const TICK: Duration = Duration::from_secs(15);
const TASK_CHARS: usize = 18;
/// A click on the icon blurs the panel (hiding it) just before the click event arrives;
/// without this, that click would immediately show it again.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub id: Option<String>,
    pub task: Option<String>,
    /// Epoch milliseconds, as the page stores it.
    pub started_at: Option<f64>,
    pub planned: Option<u32>,
}

impl Status {
    fn elapsed_min(&self, now_ms: f64) -> Option<u32> {
        let start = self.started_at?;
        Some(((now_ms - start) / 60000.0).floor().max(0.0) as u32)
    }
}

/// The menu bar title for a status at `now_ms`, or `None` when only the icon should show.
pub fn title_for(status: &Status, now_ms: f64) -> Option<String> {
    if !status.running {
        return None;
    }
    let elapsed = status.elapsed_min(now_ms)?;
    let task = truncate(status.task.as_deref().unwrap_or("").trim());
    let task = if task.is_empty() { "Untitled".to_owned() } else { task };
    Some(match status.planned {
        Some(p) if elapsed > p => format!("{task} \u{b7} +{}", elapsed - p),
        Some(p) => format!("{task} \u{b7} {elapsed}/{p}"),
        None => format!("{task} \u{b7} {elapsed}"),
    })
}

fn truncate(s: &str) -> String {
    if s.chars().count() <= TASK_CHARS {
        s.to_owned()
    } else {
        let mut t: String = s.chars().take(TASK_CHARS - 1).collect::<String>().trim_end().to_owned();
        t.push('\u{2026}');
        t
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

struct Inner {
    status: Status,
    title: Option<String>,
    /// Block id whose "minutes up" notification has been sent.
    notified: Option<String>,
    last_hidden: Option<Instant>,
}

pub struct TrayState {
    inner: Mutex<Inner>,
    tray: TrayIcon,
    done: MenuItem<tauri::Wry>,
    keep_going: MenuItem<tauri::Wry>,
    roll: MenuItem<tauri::Wry>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let done = MenuItem::with_id(app, "done", "Done, log it", false, None::<&str>)?;
    let keep_going = MenuItem::with_id(app, "keepGoing", "Keep going", false, None::<&str>)?;
    let roll = MenuItem::with_id(app, "roll", "Roll a number", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let login_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Launch at login", true, login_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[&done, &keep_going, &roll, &sep()?, &open, &login, &sep()?, &quit],
    )?;

    let login_item = login.clone();
    let tray = TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))?)
        .icon_as_template(true)
        .tooltip("Switch Card")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_panel(tray.app_handle());
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "done" => {
                let _ = app.emit("tray-action", "done");
            }
            // Both start a roll, which waits for a tap on Stop, so they need the panel.
            "keepGoing" | "roll" => {
                show_panel(app);
                let _ = app.emit("tray-action", event.id().as_ref());
            }
            "open" => show_panel(app),
            "login" => {
                let al = app.autolaunch();
                let want = !al.is_enabled().unwrap_or(false);
                let res = if want { al.enable() } else { al.disable() };
                if let Err(e) = res {
                    eprintln!("switch-card: launch at login: {e}");
                }
                let _ = login_item.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayState {
        inner: Mutex::new(Inner { status: Status::default(), title: None, notified: None, last_hidden: None }),
        tray,
        done,
        keep_going,
        roll,
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            refresh(&handle);
        }
    });
    Ok(())
}

/// Called by the `status` command whenever the page's running block changes.
pub fn set_status(app: &AppHandle, status: Status) {
    let state = app.state::<TrayState>();
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.status == status {
            return;
        }
        inner.status = status;
        let running = inner.status.running;
        let _ = state.done.set_enabled(running);
        let _ = state.keep_going.set_enabled(running);
        let _ = state.roll.set_enabled(!running);
    }
    refresh(app);
}

/// Recompute the title from the wall clock; notify once when a block reaches its plan.
fn refresh(app: &AppHandle) {
    let state = app.state::<TrayState>();
    let now = now_ms();
    let mut notify = None;
    {
        let mut inner = state.inner.lock().unwrap();
        let title = title_for(&inner.status, now);
        if title != inner.title {
            let _ = state.tray.set_title(Some(title.as_deref().unwrap_or("")));
            inner.title = title;
        }
        let s = &inner.status;
        if let (true, Some(id), Some(p), Some(e)) = (s.running, s.id.clone(), s.planned, s.elapsed_min(now)) {
            if e >= p && inner.notified.as_deref() != Some(id.as_str()) {
                let task = s.task.clone().unwrap_or_else(|| "Block".into());
                notify = Some(format!("{task}: {p} minutes up"));
                inner.notified = Some(id);
            }
        }
    }
    if let Some(body) = notify {
        if let Err(e) = app.notification().builder().title("Switch Card").body(body).show() {
            eprintln!("switch-card: notification: {e}");
        }
    }
}

fn panel<R: Runtime>(app: &AppHandle<R>) -> Option<WebviewWindow<R>> {
    app.get_webview_window("panel")
}

pub fn show_panel(app: &AppHandle) {
    if let Some(w) = panel(app) {
        let _ = w.move_window(Position::TrayCenter);
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to("panel", "panel-visibility", true);
    }
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(w) = panel(app) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            app.state::<TrayState>().inner.lock().unwrap().last_hidden = Some(Instant::now());
            let _ = app.emit_to("panel", "panel-visibility", false);
        }
    }
}

fn toggle_panel(app: &AppHandle) {
    let Some(w) = panel(app) else { return };
    if w.is_visible().unwrap_or(false) {
        hide_panel(app);
        return;
    }
    let just_hidden = app
        .state::<TrayState>()
        .inner
        .lock()
        .unwrap()
        .last_hidden
        .is_some_and(|t| t.elapsed() < REOPEN_GUARD);
    if !just_hidden {
        show_panel(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: f64 = 1_790_000_000_000.0;

    fn running(task: &str, mins_ago: f64, planned: Option<u32>) -> (Status, f64) {
        let s = Status {
            running: true,
            id: Some("b1".into()),
            task: Some(task.into()),
            started_at: Some(T0),
            planned,
        };
        (s, T0 + mins_ago * 60000.0)
    }

    #[test]
    fn idle_shows_icon_only() {
        assert_eq!(title_for(&Status::default(), T0), None);
    }

    #[test]
    fn running_shows_elapsed_over_planned() {
        let (s, now) = running("Leetcode", 23.9, Some(75));
        assert_eq!(title_for(&s, now).unwrap(), "Leetcode \u{b7} 23/75");
        let (s, now) = running("Leetcode", 75.2, Some(75));
        assert_eq!(title_for(&s, now).unwrap(), "Leetcode \u{b7} 75/75");
    }

    #[test]
    fn over_plan_shows_minutes_over() {
        let (s, now) = running("Leetcode", 83.0, Some(75));
        assert_eq!(title_for(&s, now).unwrap(), "Leetcode \u{b7} +8");
    }

    #[test]
    fn long_task_names_are_truncated() {
        let (s, now) = running("Vector DB and Document Store Readings", 5.0, Some(40));
        let t = title_for(&s, now).unwrap();
        assert_eq!(t, "Vector DB and Doc\u{2026} \u{b7} 5/40");
        let (s, now) = running("Exactly eighteen c", 5.0, Some(40));
        assert_eq!(title_for(&s, now).unwrap(), "Exactly eighteen c \u{b7} 5/40");
        // Counts characters, not bytes.
        let (s, now) = running("Lecture française du soir", 1.0, Some(30));
        assert_eq!(title_for(&s, now).unwrap(), "Lecture française\u{2026} \u{b7} 1/30");
    }

    #[test]
    fn clock_skew_never_goes_negative() {
        let (s, _) = running("Leetcode", 0.0, Some(30));
        assert_eq!(title_for(&s, T0 - 120_000.0).unwrap(), "Leetcode \u{b7} 0/30");
    }
}
