/**
 * Flora — Main Entry Point (Modules A + B + E + Onboarding)
 *
 * Boot sequence:
 *   1. DOM ready
 *   2. If onboarding not complete → show OnboardingFlow
 *   3. Onboarding completes → FloraCoordinator starts
 *   4. FloraCoordinator triggers first greeting → morning brief
 *
 * §13.1: onboarding is skippable; zero-integration path works
 * §13.4: NetworkMonitor wired through FloraCoordinator
 * §13.2: confused + offline states handled by FloraCoordinator
 * §7:    all LLM failures are silent or show retry — never raw errors
 */

import { FloraStateMachine, STATES } from './states.js';
import { AvatarRenderer } from './avatar.js';
import { ChatPanel } from './chat.js';
import { OnboardingFlow } from './onboarding.js';
import { FloraCoordinator } from './flora.js';
import { initWindowPersistence } from './persistence.js';

// ── Debug panel ───────────────────────────────────────────────────────────────

function buildDebugPanel(container: HTMLElement, sm: FloraStateMachine): void {
  const keys = Object.keys(STATES);
  for (const key of keys) {
    const btn = document.createElement('button');
    btn.textContent = STATES[key].label;
    btn.dataset.state = key;
    if (key === sm.getState()) btn.classList.add('active');
    btn.addEventListener('click', () => sm.setState(key));
    container.appendChild(btn);
  }
  sm.onStateChange((stateName) => {
    container.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', (b as HTMLButtonElement).dataset.state === stateName);
    });
  });
}

// ── Clock ─────────────────────────────────────────────────────────────────────

function startClock(el: HTMLElement): void {
  function tick() {
    const now = new Date();
    el.textContent =
      String(now.getHours()).padStart(2, '0') + ':' +
      String(now.getMinutes()).padStart(2, '0');
  }
  tick();
  setInterval(tick, 15_000);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

window.addEventListener('DOMContentLoaded', async () => {
  // ── DOM refs ──
  const jar        = document.getElementById('jar')!;
  const stateName  = document.getElementById('stateName')!;
  const brief      = document.getElementById('brief')!;
  const toast      = document.getElementById('toast')!;
  const proactive  = document.getElementById('proactive')!;
  const controls   = document.getElementById('controls')!;
  const timeNow    = document.getElementById('timeNow')!;
  const chatPanel  = document.getElementById('chat-panel')!;
  const onboardEl  = document.getElementById('onboarding-overlay')!;

  // ── State machine + renderer ──
  const sm = new FloraStateMachine('idle');
  const renderer = new AvatarRenderer(jar, stateName, brief, toast, proactive);

  sm.onStateChange((name, config) => {
    renderer.update(name, config);

    // On greeting entry: request a morning brief (handled by coordinator)
    if (name === 'greeting' && coordinator) {
      const timeOfDay = getTimeOfDay();
      coordinator.onGreeting({ timeOfDay });
    }
  });

  // Apply initial state visually
  renderer.update('idle', STATES.idle);

  // ── Debug controls ──
  buildDebugPanel(controls, sm);

  // ── Clock ──
  startClock(timeNow);

  // ── Window persistence (Tauri-only, no-ops in browser) ──
  await initWindowPersistence();

  // ── Chat panel ──
  const chat = new ChatPanel(chatPanel);

  // Click the avatar jar to open chat
  renderer.setJarClickable(() => {
    if (chat.isOpen()) {
      chat.close();
    } else {
      chat.open();
    }
  });

  // ── Coordinator reference (set after onboarding) ──
  let coordinator: FloraCoordinator | null = null;

  // ── Onboarding ──
  const startApp = (result: import('./onboarding.js').OnboardingResult) => {
    coordinator = new FloraCoordinator({
      sm,
      renderer,
      chatPanel: chat,
      onboarding: result,
    });
    coordinator.start();

    // Trigger first greeting
    sm.trigger('app_launch');

    console.log('[Flora] All modules active — onboarding complete');
  };

  if (OnboardingFlow.isComplete()) {
    // Return visit — restore API key from session if available
    const savedKey = OnboardingFlow.getSessionApiKey();
    const savedLocation = localStorage.getItem('flora.location') ?? null;
    startApp({
      geminiApiKey: savedKey,
      location: savedLocation,
      calendarEnabled: true,
    });
  } else {
    // First run — show onboarding
    const flow = new OnboardingFlow(onboardEl, startApp);
    flow.start();
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function getTimeOfDay(): 'morning' | 'afternoon' | 'evening' {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}
