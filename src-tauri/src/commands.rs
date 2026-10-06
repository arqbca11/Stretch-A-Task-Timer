//! The page's only way to reach storage. The store is the single writer.

use crate::store::Store;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::State;

/// `Err` holds the reason the store couldn't open (e.g. a corrupt log). Every command then
/// reports it to the page instead of running on partial history.
pub struct StoreState(pub Mutex<Result<Store, String>>);

fn with_store<T>(
    state: &Mutex<Result<Store, String>>,
    f: impl FnOnce(&mut Store) -> crate::store::Result<T>,
) -> Result<T, String> {
    let mut guard = state.lock().map_err(|_| "storage lock poisoned".to_string())?;
    let store = guard.as_mut().map_err(|e| e.clone())?;
    f(store).map_err(|e| e.to_string())
}

/// Every saved day, `{ "YYYY-MM-DD": {..} }`.
#[tauri::command]
pub fn load(state: State<'_, StoreState>) -> Result<Value, String> {
    with_store(&state.0, |s| Ok(json!(s.days())))
}

/// Log the full image of one day; returns its `seq` once it's on stable storage.
#[tauri::command]
pub fn put_day(state: State<'_, StoreState>, day: Value) -> Result<u64, String> {
    with_store(&state.0, |s| s.put_day(day))
}
