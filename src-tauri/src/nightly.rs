//! Nightly summary job — Module C
//!
//! §5: "LLM summarizes the day's raw event log into 2–3 sentences,
//! raw log then discarded/archived."
//!
//! Error handling (§5):
//! 1. Try LLM summary (Module E — not wired in v1)
//! 2. On failure → retry once
//! 3. On second failure → stats-only fallback (task counts + mood trend)
//! 4. Never skip the day entirely
//!
//! For v1 (no LLM), the job always uses the stats-only fallback.
//! Module E will inject a `SummaryGenerator` trait later.

use crate::memory::{DailySummary, MemoryStore, NightlyResult, RawEvent};

// ── Public API ──────────────────────────────────────────────────────

/// Run the nightly summary for a given date.
///
/// 1. Reads all raw_events for the date
/// 2. Produces a summary (stats-only in v1)
/// 3. Writes the summary to daily_summary
/// 4. Deletes processed raw_events
///
/// Returns the summary + metadata about what happened.
pub fn run_nightly(store: &MemoryStore, date: &str) -> Result<NightlyResult, String> {
    let events = store.get_events_for_date(date)?;
    let event_count = events.len();

    // v1: always use stats-only fallback.
    // When Module E is wired, this becomes:
    //   try LLM → retry once → fallback
    let summary = build_stats_summary(date, &events);

    store.write_summary(&summary)?;

    // Archive = delete processed events (§5: "raw log then discarded")
    if event_count > 0 {
        store.delete_events_for_date(date)?;
    }

    Ok(NightlyResult {
        date: date.to_string(),
        summary,
        events_processed: event_count,
        used_fallback: true, // always true in v1
    })
}

// ── Stats-only fallback ─────────────────────────────────────────────

/// Build a summary from raw event counts and mood transitions.
/// This is the §5 fallback: "raw stats-only summary (task counts, no prose)"
fn build_stats_summary(date: &str, events: &[RawEvent]) -> DailySummary {
    let mut tasks_done: i32 = 0;
    let mut tasks_missed: i32 = 0;
    let mut moods: Vec<String> = Vec::new();

    for event in events {
        match event.event_type.as_str() {
            "task_completed" => tasks_done += 1,
            "task_missed" => tasks_missed += 1,
            "state_change" => {
                // Extract mood from JSON payload: {"mood": "focused", ...}
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&event.payload)
                {
                    if let Some(mood) = val.get("mood").and_then(|m| m.as_str()) {
                        // Only add if different from the last recorded mood
                        if moods.last().map_or(true, |last| last != mood) {
                            moods.push(mood.to_string());
                        }
                    }
                }
            }
            _ => {} // future event types silently ignored
        }
    }

    let mood_trend = if moods.is_empty() {
        "no data".to_string()
    } else {
        moods.join("→")
    };

    let summary = if events.is_empty() {
        "No activity recorded.".to_string()
    } else {
        format!(
            "{tasks_done} task{} completed, {tasks_missed} missed. \
             Mood trend: {mood_trend}.",
            if tasks_done == 1 { "" } else { "s" }
        )
    };

    DailySummary {
        date: date.to_string(),
        tasks_done,
        tasks_missed,
        summary,
        mood_trend,
    }
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryStore;

    fn store_with_events(date: &str) -> MemoryStore {
        let s = MemoryStore::open_in_memory().unwrap();
        s.insert_event(
            &format!("{date}T09:00:00"),
            "state_change",
            r#"{"mood":"idle"}"#,
        )
        .unwrap();
        s.insert_event(
            &format!("{date}T10:30:00"),
            "task_completed",
            r#"{"task":"read chapter"}"#,
        )
        .unwrap();
        s.insert_event(
            &format!("{date}T11:00:00"),
            "state_change",
            r#"{"mood":"focused"}"#,
        )
        .unwrap();
        s.insert_event(
            &format!("{date}T14:00:00"),
            "task_completed",
            r#"{"task":"write notes"}"#,
        )
        .unwrap();
        s.insert_event(
            &format!("{date}T15:00:00"),
            "task_missed",
            r#"{"task":"exercise"}"#,
        )
        .unwrap();
        s.insert_event(
            &format!("{date}T17:00:00"),
            "state_change",
            r#"{"mood":"sleepy"}"#,
        )
        .unwrap();
        s
    }

    #[test]
    fn nightly_produces_correct_stats() {
        let date = "2026-08-08";
        let s = store_with_events(date);

        let result = run_nightly(&s, date).unwrap();

        assert_eq!(result.summary.tasks_done, 2);
        assert_eq!(result.summary.tasks_missed, 1);
        assert_eq!(result.summary.mood_trend, "idle→focused→sleepy");
        assert_eq!(result.events_processed, 6);
        assert!(result.used_fallback);
    }

    #[test]
    fn nightly_clears_processed_events() {
        let date = "2026-08-08";
        let s = store_with_events(date);

        run_nightly(&s, date).unwrap();

        let remaining = s.get_events_for_date(date).unwrap();
        assert!(remaining.is_empty(), "events should be archived after nightly");
    }

    #[test]
    fn nightly_writes_retrievable_summary() {
        let date = "2026-08-08";
        let s = store_with_events(date);

        run_nightly(&s, date).unwrap();

        let summaries = s.get_summaries(date, date).unwrap();
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].tasks_done, 2);
        assert_eq!(summaries[0].mood_trend, "idle→focused→sleepy");
    }

    #[test]
    fn nightly_empty_day_produces_no_activity_summary() {
        let s = MemoryStore::open_in_memory().unwrap();

        let result = run_nightly(&s, "2026-08-08").unwrap();

        assert_eq!(result.summary.summary, "No activity recorded.");
        assert_eq!(result.events_processed, 0);
    }

    #[test]
    fn nightly_does_not_touch_other_dates() {
        let s = MemoryStore::open_in_memory().unwrap();
        s.insert_event("2026-08-07T10:00:00", "task_completed", "").unwrap();
        s.insert_event("2026-08-08T10:00:00", "task_completed", "").unwrap();
        s.insert_event("2026-08-09T10:00:00", "task_completed", "").unwrap();

        run_nightly(&s, "2026-08-08").unwrap();

        // Day 7 and 9 events should still exist
        assert_eq!(s.get_events_for_date("2026-08-07").unwrap().len(), 1);
        assert_eq!(s.get_events_for_date("2026-08-09").unwrap().len(), 1);
        assert_eq!(s.get_events_for_date("2026-08-08").unwrap().len(), 0);
    }

    #[test]
    fn stats_summary_singular_task() {
        let s = MemoryStore::open_in_memory().unwrap();
        s.insert_event("2026-08-08T10:00:00", "task_completed", "").unwrap();

        let result = run_nightly(&s, "2026-08-08").unwrap();
        assert!(
            result.summary.summary.contains("1 task completed"),
            "should use singular: {}",
            result.summary.summary
        );
    }

    #[test]
    fn stats_summary_plural_tasks() {
        let s = MemoryStore::open_in_memory().unwrap();
        s.insert_event("2026-08-08T10:00:00", "task_completed", "").unwrap();
        s.insert_event("2026-08-08T11:00:00", "task_completed", "").unwrap();

        let result = run_nightly(&s, "2026-08-08").unwrap();
        assert!(
            result.summary.summary.contains("2 tasks completed"),
            "should use plural: {}",
            result.summary.summary
        );
    }
}
