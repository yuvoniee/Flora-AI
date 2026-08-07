// Flora — Tauri backend entry point (Module A)
//
// No Rust commands yet — all Module A logic lives in the frontend.
// The greet demo command has been removed; future modules (state engine,
// memory store, integrations) will add commands here.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
