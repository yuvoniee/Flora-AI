// Flora — Tauri backend
//
// Module A: shell + idle detection.
// Module C: memory store (SQLCipher) + nightly summary job.

mod memory;
mod nightly;

use memory::{DailySummary, MemoryStore};
use std::sync::Mutex;
use tauri::Manager;

// ── Idle detection (platform-specific) ──────────────────────────────

#[cfg(target_os = "windows")]
mod idle_impl {
    use std::mem;

    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
        fn GetTickCount() -> u32;
    }

    pub fn seconds() -> u64 {
        unsafe {
            let mut lii = LastInputInfo {
                cb_size: mem::size_of::<LastInputInfo>() as u32,
                dw_time: 0,
            };
            if GetLastInputInfo(&mut lii) != 0 {
                u64::from(GetTickCount().wrapping_sub(lii.dw_time) / 1000)
            } else {
                0
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod idle_impl {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    pub fn seconds() -> u64 {
        // kCGEventSourceStateCombinedSessionState = 0
        // kCGAnyInputEventType = ~0u32  (all input events)
        unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) as u64 }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod idle_impl {
    /// Unsupported platform — returns 0 (always active).
    /// Per §4: missing signal → default to safe behavior, never crash.
    pub fn seconds() -> u64 {
        0
    }
}

/// Returns seconds since last keyboard/mouse input.
/// Called by the frontend signals module on a 30s poll interval (§13.6).
#[tauri::command]
fn get_idle_seconds() -> u64 {
    idle_impl::seconds()
}

// ── Module C: Memory store commands ─────────────────────────────────

#[tauri::command]
fn memory_insert_event(
    store: tauri::State<'_, Mutex<MemoryStore>>,
    timestamp: String,
    event_type: String,
    payload: String,
) -> Result<i64, String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .insert_event(&timestamp, &event_type, &payload)
}

#[tauri::command]
fn memory_get_events(
    store: tauri::State<'_, Mutex<MemoryStore>>,
    from: String,
    to: String,
) -> Result<Vec<memory::RawEvent>, String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .get_events(&from, &to)
}

#[tauri::command]
fn memory_write_summary(
    store: tauri::State<'_, Mutex<MemoryStore>>,
    date: String,
    tasks_done: i32,
    tasks_missed: i32,
    summary: String,
    mood_trend: String,
) -> Result<(), String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .write_summary(&DailySummary {
            date,
            tasks_done,
            tasks_missed,
            summary,
            mood_trend,
        })
}

#[tauri::command]
fn memory_get_summaries(
    store: tauri::State<'_, Mutex<MemoryStore>>,
    from: String,
    to: String,
) -> Result<Vec<DailySummary>, String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .get_summaries(&from, &to)
}

#[tauri::command]
fn memory_run_nightly(
    store: tauri::State<'_, Mutex<MemoryStore>>,
    date: String,
) -> Result<memory::NightlyResult, String> {
    let guard = store.lock().map_err(|e| format!("lock: {e}"))?;
    nightly::run_nightly(&guard, &date)
}

#[tauri::command]
fn memory_clear(
    store: tauri::State<'_, Mutex<MemoryStore>>,
) -> Result<(), String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .clear()
}

#[tauri::command]
fn memory_status(
    store: tauri::State<'_, Mutex<MemoryStore>>,
) -> Result<memory::MemoryStatus, String> {
    store
        .lock()
        .map_err(|e| format!("lock: {e}"))?
        .status()
}

// ── App entry ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Module C: open the encrypted memory store
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;

            let store = MemoryStore::open(&data_dir).unwrap_or_else(|e| {
                eprintln!(
                    "[Flora/memory] first open failed ({e}), \
                     retrying after cleanup..."
                );
                // §5: corrupted/missing → recreate, don't crash
                let _ = std::fs::remove_file(data_dir.join("flora.db"));
                let _ = std::fs::remove_file(data_dir.join("flora.key"));
                MemoryStore::open(&data_dir)
                    .expect("[Flora] memory store failed on retry — cannot start")
            });

            app.manage(Mutex::new(store));
            eprintln!("[Flora/memory] store opened at {}", data_dir.display());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_idle_seconds,
            memory_insert_event,
            memory_get_events,
            memory_write_summary,
            memory_get_summaries,
            memory_run_nightly,
            memory_clear,
            memory_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
