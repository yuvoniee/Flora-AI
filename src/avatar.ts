/**
 * Flora Avatar Renderer — Module A
 *
 * Mirrors the preview's setState() — swaps `is-*` classes on the jar
 * element, updates the --accent CSS variable, and controls the brief panel.
 * All visual behavior lives in CSS, not here.
 *
 * New in this version (Module E wiring + §13):
 *   setBriefText(text, stale)   — set brief panel content programmatically
 *   showBrief(visible)          — show/hide the brief panel independent of state
 *   showToast(message)          — §13.2 one-line integration-failure toast (3 s)
 *   showProactive(message)      — show a proactive message in the brief panel
 *   setJarClickable(onClick)    — wire avatar click → chat panel open
 */

import { STATES, type StateConfig } from './states.js';

export class AvatarRenderer {
  private jarEl: HTMLElement;
  private labelEl: HTMLElement;
  private briefEl: HTMLElement;
  private toastEl: HTMLElement;
  private proactiveEl: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private proactiveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    jarEl: HTMLElement,
    labelEl: HTMLElement,
    briefEl: HTMLElement,
    toastEl: HTMLElement,
    proactiveEl: HTMLElement,
  ) {
    this.jarEl = jarEl;
    this.labelEl = labelEl;
    this.briefEl = briefEl;
    this.toastEl = toastEl;
    this.proactiveEl = proactiveEl;
  }

  /** Apply a new state visually — same logic as preview's setState() */
  update(stateName: string, config: StateConfig): void {
    // Remove all is-* state classes
    for (const key of Object.keys(STATES)) {
      this.jarEl.classList.remove('is-' + key);
    }

    // Apply new state class
    this.jarEl.classList.add('is-' + stateName);

    // Update accent color driving glow, leaves, stem, head
    document.documentElement.style.setProperty('--accent', config.color);

    // Update label
    this.labelEl.textContent = config.label;

    // Show brief panel on greeting state; keep it visible if it was already showing
    // (stale brief in offline mode should persist across state changes)
    if (stateName === 'greeting') {
      this.briefEl.classList.add('show');
    }
  }

  // ── Brief panel ────────────────────────────────────────────────────────────

  /**
   * Set the text content of the brief panel.
   * @param text    The text to display (plain text or simple HTML)
   * @param stale   If true, adds a visual "stale" indicator class
   */
  setBriefText(text: string, stale = false): void {
    this.briefEl.innerHTML = text;
    this.briefEl.classList.toggle('brief--stale', stale);
  }

  /** Show or hide the brief panel, independent of state transitions */
  showBrief(visible: boolean): void {
    this.briefEl.classList.toggle('show', visible);
  }

  // ── §13.2 toast (confused state) ──────────────────────────────────────────

  /**
   * Show a one-line integration-failure toast below the avatar.
   * Auto-dismisses after 3 s (matching the confused state's duration).
   * §13.2: "shown briefly with a one-line text explanation"
   */
  showToast(message: string): void {
    // Clear any existing toast
    if (this.toastTimer !== null) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');

    this.toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('show');
      this.toastTimer = null;
    }, 3200); // 200 ms buffer over the confused state's 3 s auto-return
  }

  // ── §7 proactive message ───────────────────────────────────────────────────

  /**
   * Display a proactive message from Module E below the avatar.
   * Replaces any existing proactive message; auto-hides after 12 s.
   */
  showProactive(message: string): void {
    if (this.proactiveTimer !== null) {
      clearTimeout(this.proactiveTimer);
      this.proactiveTimer = null;
    }

    this.proactiveEl.textContent = message;
    this.proactiveEl.classList.add('show');

    this.proactiveTimer = setTimeout(() => {
      this.proactiveEl.classList.remove('show');
      this.proactiveTimer = null;
    }, 12_000);
  }

  // ── Avatar click (→ chat panel) ────────────────────────────────────────────

  /** Register a click handler on the jar — opens the chat panel */
  setJarClickable(onClick: () => void): void {
    this.jarEl.style.cursor = 'pointer';
    this.jarEl.addEventListener('click', onClick);
  }
}
