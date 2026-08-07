/**
 * Idle / activity signal source
 *
 * Polls the Tauri `get_idle_seconds` command on a fixed interval (§13.6)
 * and fires state-machine triggers when thresholds are crossed.
 *
 * This module doesn't know about avatar states — it only fires named
 * triggers.  The TRANSITIONS table in states.ts decides what happens.
 *
 * Thresholds from SRS §3:
 *   idle >20 min  → trigger `idle_long`   (sleepy)
 *   return >30 min → trigger `user_returns` (greeting, then idle)
 *   return <30 min → trigger `activity_detected` (straight to idle)
 *
 * Error handling per §4:
 *   Tauri command fails → skip that poll, don't crash, don't change state.
 */

import { invoke } from '@tauri-apps/api/core';
import { FloraStateMachine } from './states';

export interface IdleSignalConfig {
  /** Poll interval in ms — §13.6 says 30–60s, not continuous */
  pollIntervalMs: number;
  /** Seconds idle before idle_long trigger — §3: >20 min */
  sleepyThresholdSec: number;
  /** Seconds away before return triggers greeting — §3: >30 min */
  greetingThresholdSec: number;
}

const DEFAULTS: IdleSignalConfig = {
  pollIntervalMs: 30_000,        // 30 s
  sleepyThresholdSec: 20 * 60,   // 20 min
  greetingThresholdSec: 30 * 60, // 30 min
};

/**
 * Isolated signal source the state engine consumes.
 * Start/stop controls the polling loop; nothing else in the app
 * needs to know about idle detection internals.
 */
export class IdleSignalSource {
  private sm: FloraStateMachine;
  private cfg: IdleSignalConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** true once the user has been idle past the sleepy threshold */
  private wasIdle = false;
  /** most-recent idle reading — used to estimate how long the user was away */
  private lastIdleSec = 0;

  constructor(sm: FloraStateMachine, overrides?: Partial<IdleSignalConfig>) {
    this.sm = sm;
    this.cfg = { ...DEFAULTS, ...overrides };
  }

  start(): void {
    if (this.timer) return;
    // First poll immediately, then on interval
    this.poll();
    this.timer = setInterval(() => this.poll(), this.cfg.pollIntervalMs);
    console.log(
      `[Flora/signals] idle polling started ` +
        `(every ${this.cfg.pollIntervalMs / 1000}s, ` +
        `sleepy at ${this.cfg.sleepyThresholdSec}s, ` +
        `greeting at ${this.cfg.greetingThresholdSec}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[Flora/signals] idle polling stopped');
    }
  }

  private async poll(): Promise<void> {
    let idleSec: number;
    try {
      idleSec = await invoke<number>('get_idle_seconds');
    } catch {
      // §4: missing/stale signal → skip, don't crash, don't change state
      return;
    }

    const crossedSleepy = idleSec >= this.cfg.sleepyThresholdSec;

    if (crossedSleepy && !this.wasIdle) {
      // ── Just crossed the sleepy threshold ──
      this.wasIdle = true;
      this.sm.trigger('idle_long');
    } else if (this.wasIdle && idleSec < 60) {
      // ── User returned (idle dropped below 1 min) ──
      // lastIdleSec is the peak from the previous poll, ≈ total away time
      if (this.lastIdleSec >= this.cfg.greetingThresholdSec) {
        this.sm.trigger('user_returns'); // away >30 min → greeting (auto→idle)
      } else {
        this.sm.trigger('activity_detected'); // away <30 min → idle
      }
      this.wasIdle = false;
    }

    this.lastIdleSec = idleSec;
  }
}
