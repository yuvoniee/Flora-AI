/**
 * Signal Coordinator — Module A+B bridge
 *
 * Polls raw sensor data (OS idle time) on a fixed interval (§13.6),
 * feeds each snapshot through the State Engine (Module B), and
 * applies the engine's output to the FloraStateMachine.
 *
 * Flow:  poll() → SignalSnapshot → evaluate() → sm.setState()
 *
 * This module contains NO mood-decision logic — that lives entirely
 * in engine.ts as a pure function.
 */

import { invoke } from '@tauri-apps/api/core';
import { FloraStateMachine } from './states';
import {
  evaluate,
  initialHistory,
  DEFAULT_CONFIG,
  SignalSnapshot,
  EngineHistory,
  EngineConfig,
} from './engine';

export interface SignalCoordinatorConfig {
  /** Poll interval in ms — §13.6: 30-60 s, not continuous */
  pollIntervalMs: number;
  /** Engine tuning overrides (thresholds, rate limits) */
  engine?: Partial<EngineConfig>;
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

    // ── 3. Apply output ──
    if (result.mood !== this.sm.getState()) {
      this.sm.setState(result.mood);
    }

    if (result.proactiveMessage) {
      console.log(
        `[Flora/engine] proactive: ${result.proactiveMessage} ` +
          `(reason: ${result.reason})`,
      );
      // Future: Module E feeds this to the LLM for text generation
    }

    this.history = result.history;
  }
}
