mod commands;
mod store;
mod tray;

use commands::StoreState;
use std::sync::Mutex;
use tauri::{App, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

/// Open the store (recovering it from the snapshot and log) before any command can be served.
fn open_store(app: &App) -> Result<store::Store, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    store::Store::open(dir, store::STRETCH, store::Limits::default()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let store = open_store(app);
            if let Err(e) = &store {
                eprintln!("stretch: storage unavailable: {e}");
            }
            app.manage(StoreState(Mutex::new(store)));
            tray::setup(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(false) => tray::hide_panel(window.app_handle()),
            WindowEvent::CloseRequested { api, .. } => {
                // Hide instead of closing so the page and its state stay alive.
                api.prevent_close();
                tray::hide_panel(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![commands::load, commands::put_day])
        .run(tauri::generate_context!())
        .expect("error while running Stretch");
}
