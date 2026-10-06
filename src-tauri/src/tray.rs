//! Menu bar item: icon, context menu, panel toggling.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_positioner::{Position, WindowExt as _};

/// A click on the icon blurs the panel (hiding it) just before the click event arrives;
/// without this, that click would immediately show it again.
const REOPEN_GUARD: Duration = Duration::from_millis(300);

/// When the panel was last hidden, for [`REOPEN_GUARD`].
pub struct TrayState {
    last_hidden: Mutex<Option<Instant>>,
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
    let login_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Launch at login", true, login_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &login, &PredefinedMenuItem::separator(app)?, &quit])?;

    let login_item = login.clone();
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))?)
        .icon_as_template(true)
        .tooltip("Stretch")
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
            "open" => show_panel(app),
            "login" => {
                let al = app.autolaunch();
                let want = !al.is_enabled().unwrap_or(false);
                let res = if want { al.enable() } else { al.disable() };
                if let Err(e) = res {
                    eprintln!("stretch: launch at login: {e}");
                }
                let _ = login_item.set_checked(al.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    app.manage(TrayState { last_hidden: Mutex::new(None) });
    Ok(())
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
            *app.state::<TrayState>().last_hidden.lock().unwrap() = Some(Instant::now());
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
        .last_hidden
        .lock()
        .unwrap()
        .is_some_and(|t| t.elapsed() < REOPEN_GUARD);
    if !just_hidden {
        show_panel(app);
    }
}
