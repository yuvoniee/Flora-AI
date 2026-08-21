/**
 * OnboardingFlow — §13.1
 *
 * 3-step skippable first-run flow:
 *   Step 0: Welcome — one-line explanation of what Flora does
 *   Step 1: Calendar permission — plain-language reason, skippable
 *   Step 2: Location (weather) — skippable (no weather if omitted)
 *   Step 3: Done — Flora's first greeting
 *
 * §13.1 contract: a user who skips everything gets a working (if minimal) Flora.
 * Zero-integration path: chat + avatar only, no morning brief data.
 *
 * LLM: Ollama runs locally — no API key needed, no cloud dependency.
 *
 * Completion flag: localStorage('flora.onboarding.complete') = '1'
 */

export interface OnboardingResult {
  /** City name for weather, or null if skipped */
  location: string | null;
  /** True if calendar permission was granted (mock for now — real OAuth in Module D) */
  calendarEnabled: boolean;
}

type OnboardingCompleteCallback = (result: OnboardingResult) => void;

const STORAGE_KEY = 'flora.onboarding.complete';

export class OnboardingFlow {
  private overlay: HTMLElement;
  private onComplete: OnboardingCompleteCallback;
  private result: OnboardingResult = {
    location: null,
    calendarEnabled: false,
  };

  constructor(overlayEl: HTMLElement, onComplete: OnboardingCompleteCallback) {
    this.overlay = overlayEl;
    this.onComplete = onComplete;
  }

  /** Returns true if onboarding has already been completed */
  static isComplete(): boolean {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }

  /** Begin the onboarding flow */
  start(): void {
    this.overlay.classList.add('active');
    this.renderStep(0);
  }

  /** Skip the entire flow immediately */
  private skipAll(): void {
    this.finish();
  }

  private renderStep(step: number): void {
    this.overlay.innerHTML = this.buildStep(step);
    this.attachStepListeners(step);
  }

  private buildStep(step: number): string {
    const skipAllBtn = `<button id="ob-skip-all" class="ob-link">Skip all setup →</button>`;
    const progress = this.buildProgress(step);

    switch (step) {
      case 0:
        return `
          <div class="ob-card">
            ${progress}
            <div class="ob-icon">🌱</div>
            <h1 class="ob-title">Hello, I'm Flora.</h1>
            <p class="ob-body">
              A quiet companion for your workday. I notice patterns in your day —
              meetings, focus sessions, what you're listening to — and surface
              what matters without getting in the way.
            </p>
            <p class="ob-body ob-body--dim">
              Everything stays on your device. Flora uses a local AI model
              (Ollama) — nothing is sent to the cloud.
            </p>
            <div class="ob-actions">
              <button id="ob-next" class="ob-btn ob-btn--primary">Let's set up →</button>
              ${skipAllBtn}
            </div>
          </div>`;

      case 1:
        return `
          <div class="ob-card">
            ${progress}
            <div class="ob-icon">📅</div>
            <h1 class="ob-title">Your calendar</h1>
            <p class="ob-body">
              Flora reads your Google Calendar to tell you about your day —
              upcoming meetings, what's coming up next, when you have a gap.
            </p>
            <p class="ob-body ob-body--dim">
              Nothing is shared beyond this device. Calendar data never leaves your machine.
            </p>
            <div class="ob-actions">
              <button id="ob-next" class="ob-btn ob-btn--primary">Connect calendar →</button>
              <button id="ob-skip" class="ob-link">Skip — I'll set this up later</button>
            </div>
          </div>`;

      case 2:
        return `
          <div class="ob-card">
            ${progress}
            <div class="ob-icon">🌤</div>
            <h1 class="ob-title">Weather</h1>
            <p class="ob-body">
              Flora shows current weather in your morning brief using Open-Meteo —
              no account or API key needed, just your city name.
            </p>
            <label class="ob-label" for="ob-location">Your city</label>
            <input
              id="ob-location"
              class="ob-input"
              type="text"
              placeholder="e.g. London, Tokyo, New York"
              autocomplete="off"
            />
            <div class="ob-actions">
              <button id="ob-next" class="ob-btn ob-btn--primary">Save and continue →</button>
              <button id="ob-skip" class="ob-link">Skip — no weather in brief</button>
            </div>
          </div>`;

      case 3:
        return `
          <div class="ob-card ob-card--done">
            ${progress}
            <div class="ob-icon ob-icon--done">🌿</div>
            <h1 class="ob-title">You're all set.</h1>
            <p class="ob-body">
              Flora will greet you each morning, let you know about your day,
              and check in when it seems helpful.
            </p>
            <p class="ob-body ob-body--dim">
              Make sure Ollama is running locally for Flora to chat.
            </p>
            <div class="ob-actions">
              <button id="ob-finish" class="ob-btn ob-btn--primary">Start →</button>
            </div>
          </div>`;

      default:
        return '';
    }
  }

  private buildProgress(step: number): string {
    const total = 3; // steps 0-2 (step 3 is "done")
    const dots = Array.from({ length: total }, (_, i) =>
      `<span class="ob-dot${i === step ? ' ob-dot--active' : i < step ? ' ob-dot--done' : ''}"></span>`
    ).join('');
    return `<div class="ob-progress">${dots}</div>`;
  }

  private attachStepListeners(step: number): void {
    const next = this.overlay.querySelector<HTMLButtonElement>('#ob-next');
    const skip = this.overlay.querySelector<HTMLButtonElement>('#ob-skip');
    const skipAll = this.overlay.querySelector<HTMLButtonElement>('#ob-skip-all');
    const finish = this.overlay.querySelector<HTMLButtonElement>('#ob-finish');

    skipAll?.addEventListener('click', () => this.skipAll());
    skip?.addEventListener('click', () => this.renderStep(step + 1));
    finish?.addEventListener('click', () => this.finish());

    next?.addEventListener('click', () => {
      // Collect step data before advancing
      if (step === 1) {
        // For now: mark calendar enabled without real OAuth (Module D wires the real flow)
        this.result.calendarEnabled = true;
      }
      if (step === 2) {
        const input = this.overlay.querySelector<HTMLInputElement>('#ob-location');
        const loc = input?.value.trim();
        if (loc) {
          this.result.location = loc;
          localStorage.setItem('flora.location', loc);
        }
      }

      if (step === 2) {
        this.renderStep(3);
      } else {
        this.renderStep(step + 1);
      }
    });
  }

  private finish(): void {
    localStorage.setItem(STORAGE_KEY, '1');
    this.overlay.classList.remove('active');
    this.overlay.innerHTML = '';
    this.onComplete(this.result);
  }
}
