/**
 * Flora Avatar State Machine
 *
 * Ported from flora-preview.html — same STATES config-object pattern,
 * same 7 states, same color vars.  Adding a new state = one entry here
 * + matching CSS rules.  No if/else anywhere.
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
    duration: 3000,
    nextState: 'idle',
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
    duration: 4000,
    nextState: 'idle',
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
];

export type StateChangeListener = (
  stateName: string,
  config: StateConfig,
  previousState: string,
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

  /** Direct set — used by debug panel, bypasses transition table */
  setState(stateName: string): void {
    if (!STATES[stateName] || stateName === this.current) return;
    const prev = this.current;
    this.clearAutoTimer();
    this.current = stateName;
    this.notify(prev);
    this.scheduleAutoTransition();
  }

  /** Trigger-based transition — table decides next state */
  trigger(triggerName: string): boolean {
    const match = TRANSITIONS.find(
      (t) =>
        (t.from === '*' || t.from === this.current) &&
        t.trigger === triggerName,
    );
    if (!match) return false;
    this.setState(match.to);
    return true;
  }

  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  private notify(prev: string): void {
    const config = STATES[this.current];
    for (const fn of this.listeners) fn(this.current, config, prev);
  }

  private scheduleAutoTransition(): void {
    const config = STATES[this.current];
    if (config.duration && config.nextState && STATES[config.nextState]) {
      this.autoTimer = setTimeout(() => {
        this.autoTimer = null;
        this.setState(config.nextState!);
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
