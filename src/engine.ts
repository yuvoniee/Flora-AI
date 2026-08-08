/**
 * State Engine — Module B
 *
 * Pure function: (signals, history, config) → FloraState.
 *
 * §4 contract:
 *   - Deterministic: same inputs always produce same output
 *   - No side effects, no API calls, no imports from Tauri
 *   - Proactivity rate-limited (max 1 per config.proactiveIntervalMs)
 *   - Never interrupts "focused" unless calendar signal is urgent (<5 min)
 *   - Respects user mute
 *   - Missing/stale signal (null) → treated as 0 (active), never crash
 *
 * Independently testable with fake signal snapshots.
 */

// ── Types ──────────────────────────────────────────────────────────

/** Raw sensor readings collected by the signal coordinator */
export interface SignalSnapshot {
  /** Seconds since last keyboard/mouse input, or null if unavailable */
  idleSeconds: number | null;
  /** Current wall-clock timestamp in ms (injected, not read from Date.now) */
  timestamp: number;
  // Future signals (Module D):
  // calendarEvents?: CalendarEvent[];
  // activeWindowCategory?: string;
}

/** Accumulated state the engine carries between evaluations */
export interface EngineHistory {
  /** Flora's current mood (may lag engine due to auto-transitions) */
  currentMood: string;
  /** When the engine last changed the mood (ms) */
  moodSetAt: number;
  /** When the last proactive message was emitted (ms), or null */
  lastProactiveAt: number | null;
  /** Proactive messages suppressed until this timestamp, or null */
  mutedUntil: number | null;
  /** True if the user was physically idle/away on last evaluation */
  wasIdle: boolean;
  /** Highest idle reading during the current away period */
  peakIdleSec: number;
}

/** Tuning knobs — all thresholds live here, nothing hardcoded */
export interface EngineConfig {
  /** Seconds idle before sleepy (§3: 20 min = 1200) */
  sleepyThresholdSec: number;
  /** Seconds away before greeting on return (§3: 30 min = 1800) */
  greetingThresholdSec: number;
  /** Minimum ms between proactive messages (§4: 20 min) */
  proactiveIntervalMs: number;
  /** Idle drops below this = user is back (seconds) */
  returnThresholdSec: number;
}

/** Output of a single engine evaluation */
export interface FloraState {
  /** New mood to apply (key from STATES table) */
  mood: string;
  /** Why this mood was chosen — for debugging & logging */
  reason: string;
  /** Non-null if Flora should proactively speak; value = category */
  proactiveMessage: string | null;
  /** Updated history — pass to next evaluate() call */
  history: EngineHistory;
}

// ── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: EngineConfig = {
  sleepyThresholdSec: 20 * 60,          // 20 min
  greetingThresholdSec: 30 * 60,        // 30 min
  proactiveIntervalMs: 20 * 60 * 1000,  // 20 min
  returnThresholdSec: 60,               // 1 min
};

export function initialHistory(now: number = 0): EngineHistory {
  return {
    currentMood: 'idle',
    moodSetAt: now,
    lastProactiveAt: null,
    mutedUntil: null,
    wasIdle: false,
    peakIdleSec: 0,
  };
}

// ── Core evaluation ────────────────────────────────────────────────

/**
 * Pure state engine.  Given a signal snapshot, accumulated history,
 * and config, returns the next FloraState.
 *
 * This is the single function the §4 deterministic test targets.
 */
export function evaluate(
  signals: SignalSnapshot,
  history: EngineHistory,
  config: EngineConfig = DEFAULT_CONFIG,
): FloraState {
  // §4 error handling: missing signal → 0 (active)
  const idleSec = signals.idleSeconds ?? 0;
  const now = signals.timestamp;

  let mood = history.currentMood;
  let reason = 'no_change';
  let proactiveMessage: string | null = null;
  let wasIdle = history.wasIdle;
  let peakIdleSec = history.peakIdleSec;

  // Track peak idle during an away period
  if (wasIdle && idleSec > peakIdleSec) {
    peakIdleSec = idleSec;
  }

  // ── Mood determination ──────────────────────────────────────────

  if (idleSec >= config.sleepyThresholdSec && !wasIdle) {
    // Just crossed the sleepy threshold
    mood = 'sleepy';
    reason = 'idle_timeout';
    wasIdle = true;
    peakIdleSec = idleSec;
  } else if (wasIdle && idleSec < config.returnThresholdSec) {
    // User returned from being away
    if (peakIdleSec >= config.greetingThresholdSec) {
      mood = 'greeting';
      reason = 'user_returned_long';
    } else {
      mood = 'idle';
      reason = 'user_returned_short';
    }
    wasIdle = false;
    peakIdleSec = 0;
  }

  // ── Proactivity gating (§4 rules) ──────────────────────────────

  if (reason !== 'no_change') {
    const isMuted = history.mutedUntil !== null && now < history.mutedUntil;

    const cooldownElapsed =
      history.lastProactiveAt === null ||
      now - history.lastProactiveAt >= config.proactiveIntervalMs;

    // §4: "Never interrupt during focused unless calendar urgent (<5 min)"
    // No calendar signals in current scope → never interrupt focused.
    const inFocus = history.currentMood === 'focused';

    if (!isMuted && cooldownElapsed && !inFocus) {
      if (reason === 'user_returned_long') {
        proactiveMessage = 'welcome_back';
      }
      // Future triggers: 'meeting_soon', 'end_of_day', etc.
    }
  }

  // ── Build output ────────────────────────────────────────────────

  const moodChanged = mood !== history.currentMood;

  return {
    mood,
    reason,
    proactiveMessage,
    history: {
      currentMood: mood,
      moodSetAt: moodChanged ? now : history.moodSetAt,
      lastProactiveAt: proactiveMessage !== null
        ? now
        : history.lastProactiveAt,
      mutedUntil: history.mutedUntil,
      wasIdle,
      peakIdleSec,
    },
  };
}
