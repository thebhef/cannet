//! Cannet Tauri host. Wires file dialogs and the Phase-1 BLF / DBC stack
//! to the React frontend.
//!
//! For the scaffold commit this just brings up an empty window; commands
//! and event streaming land in the follow-up.

/// Boot the Tauri runtime.
///
/// # Panics
/// Panics if the platform runtime fails to start (no display, missing
/// `WebView`, etc.) — there's no recovery path, so we surface the error
/// loudly rather than silently exiting.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .run(tauri::generate_context!())
        .expect("error while running cannet");
}
