mod commands;
mod store;
mod tray;

use commands::StoreState;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::{App, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Open the store and run the one-time seed import before any command can be served.
fn open_store(app: &App) -> Result<store::Store, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut s = store::Store::open(&dir).map_err(|e| e.to_string())?;
    if s.needs_import() {
        let seed_path = app
            .path()
            .resolve("resources/seed-export.json", BaseDirectory::Resource)
            .map_err(|e| e.to_string())?;
        let seed = match std::fs::read(&seed_path) {
            Ok(bytes) => Some(
                serde_json::from_slice(&bytes)
                    .map_err(|e| format!("{} is not valid JSON: {e}", seed_path.display()))?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e.to_string()),
        };
        s.import_seed(seed.as_ref()).map_err(|e| e.to_string())?;
    }
    Ok(s)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let store = open_store(app);
            if let Err(e) = &store {
                eprintln!("switch-card: storage unavailable: {e}");
            }
            app.manage(StoreState(Mutex::new(store)));
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) => tray::hide_panel(window.app_handle()),
            WindowEvent::CloseRequested { api, .. } => {
                // Hide instead of closing so the page (timer, Tetris) stays alive.
                api.prevent_close();
                tray::hide_panel(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::load,
            commands::put_day,
            commands::put_game,
            commands::status
        ])
        .run(tauri::generate_context!())
        .expect("error while running Switch Card");
}
