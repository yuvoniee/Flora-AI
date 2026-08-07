// Flora — Tauri backend
//
// Module A: shell (no commands).
// Idle detection: get_idle_seconds command for the signals module.

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

// ── App entry ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_idle_seconds])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
