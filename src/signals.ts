 /**
 * Signal Coordinator — Module A+B+E bridge
 *
 * Polls raw sensor data (OS idle time) on a fixed interval (§13.6),
 * feeds each snapshot through the State Engine (Module B), and
 * applies the engine's output to the FloraStateMachine.
 *
 * Flow:  poll() → SignalSnapshot → evaluate() → sm.setState()
 *
 * Module E wiring (§7):
 *   When evaluate() emits a proactiveMessage category, the coordinator
 *   calls onProactiveMessage callbacks. FloraCoordinator listens and
 *   calls generateProactiveMessage() — result is fire-and-forget:
 *   null/failure is a silent skip per §7.
 *
 * This module contains NO mood-decision logic — that lives entirely
 * in engine.ts as a pure function.
 * This module contains NO LLM call logic — that lives in flora.ts.
 */

import { invoke } from '@tauri-apps/api/core';
import { FloraStateMachine } from './states.js';
import {
  evaluate,
  initialHistory,
  DEFAULT_CONFIG,
  type SignalSnapshot,
  type EngineHistory,
  type EngineConfig,
} from './engine.js';
import type { ReasoningEngine, SignalContext } from './llm/reasoning.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProactiveMessageCallback = (
  trigger: string,
  signals: SignalContext,
) => void;

export interface SignalCoordinatorConfig {
  /** Poll interval in ms — §13.6: 30-60 s, not continuous */
  pollIntervalMs: number;
  /** Engine tuning overrides (thresholds, rate limits) */
  engine?: Partial<EngineConfig>;
  /** Reasoning engine — passed in so coordinator can build signal context */
  reasoningEngine?: ReasoningEngine;
}

const SIGNAL_DEFAULTS: SignalCoordinatorConfig = {
  pollIntervalMs: 30_000,
};

export class SignalCoordinator {
  private sm: FloraStateMachine;
  private pollMs: number;
  private engineCfg: EngineConfig;
  private history: EngineHistory;
  private timer: ReturnType<typeof setInterval> | null = null;
  private proactiveCallbacks: ProactiveMessageCallback[] = [];

  constructor(
    sm: FloraStateMachine,
    overrides?: Partial<SignalCoordinatorConfig>,
  ) {
    const cfg = { ...SIGNAL_DEFAULTS, ...overrides };
    this.sm = sm;
    this.pollMs = cfg.pollIntervalMs;
    this.engineCfg = { ...DEFAULT_CONFIG, ...cfg.engine };
    this.history = initialHistory(Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    console.log(
      `[Flora/signals] polling started (every ${this.pollMs / 1000}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Flora/signals] polling stopped');
    }
  }

  /** Mute proactive messages for durationMs (§4 mute rule) */
  mute(durationMs: number): void {
    this.history = {
      ...this.history,
      mutedUntil: Date.now() + durationMs,
    };
  }

  unmute(): void {
    this.history = { ...this.history, mutedUntil: null };
  }

  /**
   * Register a callback that fires when Module B emits a proactive trigger.
   * The callback receives the trigger name and current SignalContext.
   * FloraCoordinator uses this to call Module E's generateProactiveMessage().
   */
  onProactiveMessage(cb: ProactiveMessageCallback): void {
    this.proactiveCallbacks.push(cb);
  }

  private async poll(): Promise<void> {
    // ── 1. Collect raw signals ──
    let idleSeconds: number | null;
    try {
      idleSeconds = await invoke<number>('get_idle_seconds');
    } catch {
      idleSeconds = null; // §4: missing signal → null, engine defaults to 0
    }

    // Sync history.currentMood with the SM's actual state
    // (accounts for auto-transitions like greeting→idle after 3s)
    this.history = { ...this.history, currentMood: this.sm.getState() };

    // ── 2. Evaluate through the pure engine ──
    const signals: SignalSnapshot = {
      idleSeconds,
      timestamp: Date.now(),
    };
    const result = evaluate(signals, this.history, this.engineCfg);

    // ── 3. Apply mood output ──
    if (result.mood !== this.sm.getState()) {
      this.sm.setState(result.mood);
    }

    // ── 4. Fire proactive callbacks (Module E wiring) ──
    if (result.proactiveMessage) {
      console.log(
        `[Flora/signals] proactive trigger: ${result.proactiveMessage} ` +
          `(reason: ${result.reason})`,
      );

      // Build SignalContext from current signals (§11: category labels only)
      const signalCtx: SignalContext = {
        idleDurationMs: idleSeconds ? idleSeconds * 1000 : undefined,
        timeOfDay: this.getTimeOfDay(),
      };

      for (const cb of this.proactiveCallbacks) {
        cb(result.proactiveMessage, signalCtx);
      }
    }

    this.history = result.history;
  }

  private getTimeOfDay(): 'morning' | 'afternoon' | 'evening' {
    const hour = new Date().getHours();
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
  }
}
