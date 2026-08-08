/**
 * State Engine tests — Module B §4 acceptance criteria
 *
 * 1. Deterministic sequence: fixed fake signals → expected mood sequence
 * 2. Proactivity rate-limit: 100 rapid-fire signals → never exceeds window
 * 3. Focus-interrupt protection
 * 4. Mute respect
 * 5. Missing-signal handling
 */

import { describe, it, expect } from 'vitest';
import {
  evaluate,
  initialHistory,
  EngineConfig,
  EngineHistory,
  SignalSnapshot,
  DEFAULT_CONFIG,
} from './engine';

/* ── Shared test config ──────────────────────────────────────────── */

const CFG: EngineConfig = {
  sleepyThresholdSec: 1200,          // 20 min
  greetingThresholdSec: 1800,        // 30 min
  proactiveIntervalMs: 1_200_000,    // 20 min
  returnThresholdSec: 60,            // 1 min
};

const T0 = 1_000_000; // arbitrary epoch for test timestamps

/* ── Helpers ─────────────────────────────────────────────────────── */

function snap(idleSec: number | null, t: number): SignalSnapshot {
  return { idleSeconds: idleSec, timestamp: t };
}

/** Run a sequence of (idleSec, dt) pairs through the engine, return moods */
function runSequence(
  steps: { idleSec: number | null; dt: number }[],
  config: EngineConfig = CFG,
  startHistory?: EngineHistory,
): { moods: string[]; reasons: string[]; proactive: (string | null)[] } {
  let history = startHistory ?? initialHistory(T0);
  const moods: string[] = [];
  const reasons: string[] = [];
  const proactive: (string | null)[] = [];
  let t = T0;

  for (const step of steps) {
    t += step.dt;
    const result = evaluate(snap(step.idleSec, t), history, config);
    moods.push(result.mood);
    reasons.push(result.reason);
    proactive.push(result.proactiveMessage);
    history = result.history;
  }

  return { moods, reasons, proactive };
}

/* ================================================================
   §4 ACCEPTANCE CRITERION 1
   Deterministic sequence: fixed signals → exact mood table
   ================================================================ */

describe('deterministic sequence (§4 acceptance criterion)', () => {
  it('produces the expected mood+reason for every step', () => {
    const steps: {
      idleSec: number | null;
      dt: number;
      mood: string;
      reason: string;
    }[] = [
      //                                        ── expected ──
      { idleSec: 0,    dt: 30_000, mood: 'idle',     reason: 'no_change'           },
      { idleSec: 300,  dt: 30_000, mood: 'idle',     reason: 'no_change'           }, // 5 min
      { idleSec: 600,  dt: 30_000, mood: 'idle',     reason: 'no_change'           }, // 10 min
      { idleSec: 1200, dt: 30_000, mood: 'sleepy',   reason: 'idle_timeout'        }, // 20 min → sleepy
      { idleSec: 1500, dt: 30_000, mood: 'sleepy',   reason: 'no_change'           }, // 25 min still
      { idleSec: 0,    dt: 30_000, mood: 'idle',     reason: 'user_returned_short' }, // back <30 min
      { idleSec: 0,    dt: 30_000, mood: 'idle',     reason: 'no_change'           }, // still active
      { idleSec: 1200, dt: 30_000, mood: 'sleepy',   reason: 'idle_timeout'        }, // gone again
      { idleSec: 1800, dt: 30_000, mood: 'sleepy',   reason: 'no_change'           }, // 30 min
      { idleSec: 2400, dt: 30_000, mood: 'sleepy',   reason: 'no_change'           }, // 40 min
      { idleSec: 0,    dt: 30_000, mood: 'greeting', reason: 'user_returned_long'  }, // back >30 min
    ];

    let history = initialHistory(T0);
    let t = T0;

    for (let i = 0; i < steps.length; i++) {
      const { idleSec, dt, mood, reason } = steps[i];
      t += dt;
      const result = evaluate(snap(idleSec, t), history, CFG);
      expect(result.mood, `step ${i}: mood`).toBe(mood);
      expect(result.reason, `step ${i}: reason`).toBe(reason);
      history = result.history;
    }
  });

  it('is deterministic — same inputs always produce same outputs', () => {
    const run1 = runSequence([
      { idleSec: 0, dt: 30_000 },
      { idleSec: 1200, dt: 30_000 },
      { idleSec: 2000, dt: 30_000 },
      { idleSec: 0, dt: 30_000 },
    ]);
    const run2 = runSequence([
      { idleSec: 0, dt: 30_000 },
      { idleSec: 1200, dt: 30_000 },
      { idleSec: 2000, dt: 30_000 },
      { idleSec: 0, dt: 30_000 },
    ]);
    expect(run1.moods).toEqual(run2.moods);
    expect(run1.reasons).toEqual(run2.reasons);
    expect(run1.proactive).toEqual(run2.proactive);
  });
});

/* ================================================================
   §4 ACCEPTANCE CRITERION 2
   Proactivity rate-limit: 100 rapid-fire signals in ~1 min
   ================================================================ */

describe('proactivity rate-limit (§4 acceptance criterion)', () => {
  it('never exceeds 1 proactive message per configured window under 100 rapid signals', () => {
    // Short proactive interval for testability
    const config: EngineConfig = { ...CFG, proactiveIntervalMs: 60_000 };

    let history = initialHistory(T0);
    let proactiveCount = 0;
    let t = T0;

    for (let i = 0; i < 100; i++) {
      // 4-phase cycle: active → sleepy → peak>30min → return
      const phase = i % 4;
      let idleSec: number;
      if (phase === 0) idleSec = 0;          // active
      else if (phase === 1) idleSec = 1200;  // crosses sleepy
      else if (phase === 2) idleSec = 2000;  // peak > greeting
      else idleSec = 0;                      // return → proactive attempt

      t += 1000; // 1 signal per second
      const result = evaluate(snap(idleSec, t), history, config);
      if (result.proactiveMessage) proactiveCount++;
      history = result.history;
    }

    // 100 signals in ~100s, 60s rate-limit window →
    // at most ceil(100_000/60_000) + 1 = 3 proactive messages
    const maxAllowed = Math.ceil(100_000 / config.proactiveIntervalMs) + 1;
    expect(proactiveCount).toBeLessThanOrEqual(maxAllowed);
    // But also confirm at least 1 fired (sanity check)
    expect(proactiveCount).toBeGreaterThanOrEqual(1);
  });

  it('respects the rate-limit exactly at the boundary', () => {
    const config: EngineConfig = { ...CFG, proactiveIntervalMs: 100_000 };

    // First return at T0+30k → proactive fires
    let history = initialHistory(T0);
    history = evaluate(snap(1200, T0 + 10_000), history, config).history; // sleepy
    history = evaluate(snap(2000, T0 + 20_000), history, config).history; // peak
    const r1 = evaluate(snap(0, T0 + 30_000), history, config);
    expect(r1.proactiveMessage).toBe('welcome_back');
    history = r1.history;

    // Second return at T0+30k+90k = T0+120k → still within 100k window
    history = evaluate(snap(1200, T0 + 80_000), history, config).history;
    history = evaluate(snap(2000, T0 + 100_000), history, config).history;
    const r2 = evaluate(snap(0, T0 + 120_000), history, config);
    expect(r2.proactiveMessage).toBeNull(); // rate-limited

    // Third return at T0+30k+110k = T0+140k → past the 100k window
    history = r2.history;
    history = evaluate(snap(1200, T0 + 125_000), history, config).history;
    history = evaluate(snap(2000, T0 + 130_000), history, config).history;
    const r3 = evaluate(snap(0, T0 + 140_000), history, config);
    expect(r3.proactiveMessage).toBe('welcome_back'); // cooldown elapsed
  });
});

/* ================================================================
   §4 RULE: Never interrupt focused
   ================================================================ */

describe('focus-interrupt protection (§4)', () => {
  it('suppresses proactive when previous mood was focused', () => {
    const history: EngineHistory = {
      currentMood: 'focused',
      moodSetAt: T0,
      lastProactiveAt: null,
      mutedUntil: null,
      wasIdle: true,
      peakIdleSec: 2000, // was away >30 min
    };

    const result = evaluate(snap(0, T0 + 100_000), history, CFG);
    expect(result.mood).toBe('greeting');
    expect(result.reason).toBe('user_returned_long');
    expect(result.proactiveMessage).toBeNull(); // suppressed — was focused
  });

  it('allows proactive after mood leaves focused', () => {
    // Start focused, go sleepy, then return
    let history: EngineHistory = {
      currentMood: 'focused',
      moodSetAt: T0,
      lastProactiveAt: null,
      mutedUntil: null,
      wasIdle: false,
      peakIdleSec: 0,
    };

    // Cross sleepy threshold while focused
    const r1 = evaluate(snap(1200, T0 + 60_000), history, CFG);
    expect(r1.mood).toBe('sleepy');
    history = r1.history;

    // Accumulate peak > greeting threshold
    const r2 = evaluate(snap(2000, T0 + 120_000), history, CFG);
    history = r2.history;

    // Return — history.currentMood is now 'sleepy', not 'focused'
    const r3 = evaluate(snap(0, T0 + 180_000), history, CFG);
    expect(r3.mood).toBe('greeting');
    expect(r3.proactiveMessage).toBe('welcome_back'); // allowed
  });
});

/* ================================================================
   §4 RULE: Mute
   ================================================================ */

describe('mute (§4)', () => {
  it('suppresses proactive while muted, allows after expiry', () => {
    let history: EngineHistory = {
      ...initialHistory(T0),
      mutedUntil: T0 + 200_000, // muted for 200s
    };

    // Trigger a proactive-eligible return WHILE muted
    history = evaluate(snap(1200, T0 + 10_000), history, CFG).history;
    history = evaluate(snap(2000, T0 + 20_000), history, CFG).history;
    const r1 = evaluate(snap(0, T0 + 30_000), history, CFG);
    expect(r1.mood).toBe('greeting');
    expect(r1.proactiveMessage).toBeNull(); // muted
    history = r1.history;

    // Trigger another return AFTER mute expired
    history = evaluate(snap(1200, T0 + 300_000), history, CFG).history;
    history = evaluate(snap(2000, T0 + 400_000), history, CFG).history;
    const r2 = evaluate(snap(0, T0 + 500_000), history, CFG);
    expect(r2.mood).toBe('greeting');
    expect(r2.proactiveMessage).toBe('welcome_back'); // unmuted
  });
});

/* ================================================================
   §4 ERROR HANDLING: Missing signal
   ================================================================ */

describe('missing signal (§4 error handling)', () => {
  it('treats null idleSeconds as 0 (active)', () => {
    const history = initialHistory(T0);
    const result = evaluate(snap(null, T0 + 30_000), history, CFG);
    expect(result.mood).toBe('idle');
    expect(result.reason).toBe('no_change');
  });

  it('does not transition to sleepy on null', () => {
    let history = initialHistory(T0);
    // Even many null readings in a row should not trigger sleepy
    for (let i = 0; i < 50; i++) {
      const r = evaluate(snap(null, T0 + i * 30_000), history, CFG);
      expect(r.mood).not.toBe('sleepy');
      history = r.history;
    }
  });
});
