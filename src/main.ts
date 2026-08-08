/**
 * Flora — Module A entry point
 *
 * Wires the state machine, avatar renderer, debug panel, clock,
 * and window persistence.  Same logic as flora-preview.html's <script>,
 * split into typed modules.
 */

import { FloraStateMachine, STATES } from './states';
import { AvatarRenderer } from './avatar';
import { initWindowPersistence } from './persistence';
import { SignalCoordinator } from './signals';

/** Build the debug-button grid — same layout as the preview */
function buildDebugPanel(
  container: HTMLElement,
  sm: FloraStateMachine,
): void {
  const keys = Object.keys(STATES);
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.textContent = STATES[key].label;
    btn.dataset.state = key;
    if (key === sm.getState()) btn.classList.add('active');
    btn.addEventListener('click', () => sm.setState(key));
    container.appendChild(btn);
  }

  // Keep the active highlight in sync
  sm.onStateChange((stateName) => {
    container.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.state === stateName);
    });
  });
}

/** Live clock in the readout — same as preview */
function startClock(el: HTMLElement): void {
  function tick() {
    const now = new Date();
    el.textContent =
      String(now.getHours()).padStart(2, '0') +
      ':' +
      String(now.getMinutes()).padStart(2, '0');
  }
  tick();
  setInterval(tick, 15_000);
}

/* ---- bootstrap ---- */

window.addEventListener('DOMContentLoaded', async () => {
  const jar = document.getElementById('jar')!;
  const stateName = document.getElementById('stateName')!;
  const brief = document.getElementById('brief')!;
  const controls = document.getElementById('controls')!;
  const timeNow = document.getElementById('timeNow')!;

  // State machine + renderer
  const sm = new FloraStateMachine('idle');
  const renderer = new AvatarRenderer(jar, stateName, brief);

  sm.onStateChange((name, config) => renderer.update(name, config));

  // Apply initial state visually
  renderer.update('idle', STATES.idle);

  // Debug controls
  buildDebugPanel(controls, sm);

  // Clock
  startClock(timeNow);

  // Window persistence (Tauri-only, no-ops in browser)
  await initWindowPersistence();

  // Signal coordinator — polls OS idle time → State Engine → state machine.
  // Fails silently outside Tauri (invoke rejects, engine gets null signal).
  const signals = new SignalCoordinator(sm);
  signals.start();

  console.log('[Flora] Modules A+B ready — shell, engine, idle signals active');
});
