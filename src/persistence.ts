/**
 * Window position/size persistence for Flora's floating widget.
 *
 * Saves to localStorage on move/resize, restores on launch.
 * Gracefully no-ops when Tauri APIs aren't available (browser dev).
 */

const STORAGE_KEY = 'flora_window';

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function save(patch: Partial<WindowState>): void {
  const existing = load();
  const merged = { ...existing, ...patch };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
}

function load(): WindowState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WindowState) : null;
  } catch {
    return null;
  }
}

/**
 * Restore saved position on startup, wire move/resize listeners
 * to persist future changes.  §3 acceptance criterion:
 * "Widget position/size persists across app restart."
 */
export async function initWindowPersistence(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { PhysicalPosition, PhysicalSize } = await import(
      '@tauri-apps/api/dpi'
    );
    const win = getCurrentWindow();

    // Restore
    const saved = load();
    if (saved) {
      if (saved.x != null && saved.y != null) {
        await win.setPosition(new PhysicalPosition(saved.x, saved.y));
      }
      if (saved.width != null && saved.height != null) {
        await win.setSize(new PhysicalSize(saved.width, saved.height));
      }
    }

    // Persist on move
    await win.onMoved(({ payload }) => {
      save({ x: payload.x, y: payload.y });
    });

    // Persist on resize
    await win.onResized(({ payload }) => {
      save({ width: payload.width, height: payload.height });
    });

    console.log('[Flora] Window persistence active');
  } catch {
    console.log('[Flora] Window persistence unavailable (not in Tauri)');
  }
}
