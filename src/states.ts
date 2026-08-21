/**
 * Flora State Definitions — Module A
 *
 * This file is the ONLY place where states and transitions are declared.
 * FloraStateMachine reads from these tables — zero domain logic here,
 * just data (labels, colors, durations, transitions).
 *
 * §3 compliance: all mood states defined here.
 * §4 compliance: all transition rules live in TRANSITIONS,
 * + matching CSS rules.  No if/else anywhere.
 *
 * §13.2 failure states:
 *   confused — single integration failed (3 s flash → idle)
 *   offline  — no network (§13.4; existing)
 */

/** Per-state config stored in the STATES table */
export interface StateConfig {
  /** Display label */
  label: string;
  /** CSS class suffix — applied as `is-{key}` on the jar element */
  jarClass: string;
  /** CSS variable value for --accent (drives glow, leaves, stem, head) */
  color: string;
  /** If set, auto-return to nextState after this many ms */
  duration?: number;
  /** State to transition to after duration expires */
  nextState?: string;
}

/** A row in the transition table */
export interface Transition {
  from: string | '*';
  trigger: string;
  to: string;
}

/**
 * STATES — the single source of truth, ported verbatim from the preview.
 * Colors reference CSS custom properties defined in styles.css.
 */
export const STATES: Record<string, StateConfig> = {
  idle: {
    label: 'Idle',
    jarClass: 'is-idle',
    color: 'var(--c-idle)',
  },
  greeting: {
    label: 'Greeting',
    jarClass: 'is-greeting',
    color: 'var(--c-greeting)',
  },
  focused: {
    label: 'Focused',
    jarClass: 'is-focused',
    color: 'var(--c-focused)',
  },
  celebrating: {
    label: 'Celebrating',
    jarClass: 'is-celebrating',
    color: 'var(--c-celebrating)',
  },
  sleepy: {
    label: 'Sleepy',
    jarClass: 'is-sleepy',
    color: 'var(--c-sleepy)',
  },
  thinking: {
    label: 'Thinking',
    jarClass: 'is-thinking',
    color: 'var(--c-thinking)',
  },
  offline: {
    label: 'Offline',
    jarClass: 'is-offline',
    color: 'var(--c-offline)',
  },
  // §13.2: confused — one integration failed; flashes 3 s then returns to idle
  confused: {
    label: 'Confused',
    jarClass: 'is-confused',
    color: 'var(--c-confused)',
    duration: 3000,
    nextState: 'idle',
  },
};

/**
 * State-transition table.
 * (from, trigger) → to.  '*' = any source state.  First match wins.
 * Debug-panel setState() calls bypass this table.
 */
export const TRANSITIONS: Transition[] = [
  { from: '*',           trigger: 'app_launch',        to: 'greeting'    },
  { from: '*',           trigger: 'user_returns',      to: 'greeting'    },
  { from: 'greeting',    trigger: 'greeting_done',     to: 'idle'        },
  { from: 'idle',        trigger: 'task_started',      to: 'focused'     },
  { from: 'focused',     trigger: 'task_completed',    to: 'celebrating' },
  { from: 'celebrating', trigger: 'celebration_done',  to: 'idle'        },
  { from: 'idle',        trigger: 'idle_long',         to: 'sleepy'      },
  { from: 'sleepy',      trigger: 'activity_detected', to: 'idle'        },
  { from: '*',           trigger: 'llm_request_start', to: 'thinking'    },
  { from: 'thinking',    trigger: 'llm_request_end',   to: 'idle'        },
  { from: '*',           trigger: 'network_lost',      to: 'offline'     },
  { from: 'offline',     trigger: 'network_restored',  to: 'idle'        },
  // §13.2: integration failure — flash confused for 3 s, auto-return to idle
  { from: 'idle',        trigger: 'integration_error', to: 'confused'    },
  { from: 'greeting',    trigger: 'integration_error', to: 'confused'    },
];

/** Source of a state change — lets listeners distinguish side-effect-free debug
 *  changes from production triggers and auto-transitions. */
export type StateChangeSource = 'debug' | 'trigger' | 'auto';

export type StateChangeListener = (
  stateName: string,
  config: StateConfig,
  previousState: string,
  source: StateChangeSource,
) => void;

/**
 * Pure data-driven state machine.
 * Zero domain-specific conditionals — all behavior comes from the
 * STATES and TRANSITIONS tables above.
 */
export class FloraStateMachine {
  private current: string;
  private listeners: StateChangeListener[] = [];
  private autoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(initialState: string = 'idle') {
    this.current = STATES[initialState] ? initialState : 'idle';
  }

  getState(): string {
    return this.current;
  }

  getConfig(): StateConfig {
    return STATES[this.current];
  }

  /**
   * Direct set — used by debug panel. Bypasses transition table.
   * Listeners receive source='debug' so they can skip side effects.
   */
  setDebugState(stateName: string): void {
    this.applyState(stateName, 'debug');
  }

  /**
   * Production state set — used internally by trigger() and auto-transitions.
   * Listeners receive the real source ('trigger' or 'auto').
   */
  setState(stateName: string, source: StateChangeSource = 'trigger'): void {
    this.applyState(stateName, source);
  }

  /** Trigger-based transition — table decides next state */
  trigger(triggerName: string): boolean {
    const match = TRANSITIONS.find(
      (t) =>
        (t.from === '*' || t.from === this.current) &&
        t.trigger === triggerName,
    );
    if (!match) return false;
    this.setState(match.to, 'trigger');
    return true;
  }

  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  private applyState(stateName: string, source: StateChangeSource): void {
    if (!STATES[stateName] || stateName === this.current) return;
    const prev = this.current;
    this.clearAutoTimer();
    this.current = stateName;
    this.notify(prev, source);
    this.scheduleAutoTransition();
  }

  private notify(prev: string, source: StateChangeSource): void {
    const config = STATES[this.current];
    for (const fn of this.listeners) fn(this.current, config, prev, source);
  }

  private scheduleAutoTransition(): void {
    const config = STATES[this.current];
    if (config.duration && config.nextState && STATES[config.nextState]) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        this.applyState(config.nextState!, 'auto');
      }, config.duration);
    }
  }

  private clearAutoTimer(): void {
    if (this.autoTimer !== null) {
      clearTimeout(this.autoTimer);
      this.autoTimer = null;
    }
  }
}
