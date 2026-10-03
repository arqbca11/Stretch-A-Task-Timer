//! The page's only way to reach storage and the tray. The store is the single writer.

use crate::store::Store;
use crate::tray::{self, Status};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, State};

/// `Err` holds the reason the store couldn't open (e.g. a corrupt log). Every command then
/// reports it to the page instead of running on partial history.
pub struct StoreState(pub Mutex<Result<Store, String>>);

fn with_store<T>(state: &StoreState, f: impl FnOnce(&mut Store) -> crate::store::Result<T>) -> Result<T, String> {
    let mut guard = state.0.lock().map_err(|_| "storage lock poisoned".to_string())?;
    let store = guard.as_mut().map_err(|e| e.clone())?;
    f(store).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load(state: State<'_, StoreState>) -> Result<Value, String> {
    let r = with_store(&state, |s| Ok(json!({ "days": s.days(), "game": s.load_game()? })));
    #[cfg(debug_assertions)]
    eprintln!("stretch: load -> {}", match &r {
        Ok(v) => format!("{} days", v["days"].as_object().map_or(0, |d| d.len())),
        Err(e) => format!("error: {e}"),
    });
    r
}

#[tauri::command]
pub fn put_day(state: State<'_, StoreState>, day: Value) -> Result<u64, String> {
    with_store(&state, |s| s.put_day(day))
}

#[tauri::command]
pub fn put_game(state: State<'_, StoreState>, game: Value) -> Result<(), String> {
    with_store(&state, |s| s.put_game(&game))
}

#[tauri::command]
pub fn status(app: AppHandle, status: Status) {
    #[cfg(debug_assertions)]
    eprintln!("stretch: status {status:?}");
    tray::set_status(&app, status);
}
