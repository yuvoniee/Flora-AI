/**
 * Memory Store — TypeScript interface for Module C
 *
 * Thin wrappers around Tauri commands.  Each function maps 1:1 to a
 * Rust command in lib.rs.  All types match the Rust serde structs.
 *
 * Usage from browser console (CLI-testable per §5 acceptance criteria):
 *
 *   import { insertEvent, getEvents, runNightly, getStatus } from './memory'
 *   await insertEvent('task_completed', { task: 'read chapter' })
 *   await getStatus()
 */

import { invoke } from '@tauri-apps/api/core';

// ── Types (mirror Rust serde structs) ───────────────────────────────

export interface RawEvent {
  id: number;
  timestamp: string;
  event_type: string;
  payload: string;
}

export interface DailySummary {
  date: string;
  tasks_done: number;
  tasks_missed: number;
  summary: string;
  mood_trend: string;
}

export interface MemoryStatus {
  db_path: string;
  db_size_bytes: number;
  event_count: number;
  summary_count: number;
  schema_version: number;
}

export interface NightlyResult {
  date: string;
  summary: DailySummary;
  events_processed: number;
  used_fallback: boolean;
}

// ── Commands ────────────────────────────────────────────────────────

/**
 * Insert a raw event into the memory store.
 * Timestamp is auto-generated as ISO 8601 (local time).
 */
export async function insertEvent(
  eventType: string,
  payload: object = {},
): Promise<number> {
  const timestamp = new Date().toISOString().replace('Z', '');
  return invoke<number>('memory_insert_event', {
    timestamp,
    eventType,
    payload: JSON.stringify(payload),
  });
}

/**
 * Get raw events in a date range.
 * @param from ISO timestamp (inclusive)
 * @param to   ISO timestamp (exclusive)
 */
export async function getEvents(
  from: string,
  to: string,
): Promise<RawEvent[]> {
  return invoke<RawEvent[]>('memory_get_events', { from, to });
}

/** Write or update a daily summary. */
export async function writeSummary(
  summary: DailySummary,
): Promise<void> {
  return invoke<void>('memory_write_summary', {
    date: summary.date,
    tasksDone: summary.tasks_done,
    tasksMissed: summary.tasks_missed,
    summary: summary.summary,
    moodTrend: summary.mood_trend,
  });
}

/**
 * Get daily summaries in a date range.
 * @param from YYYY-MM-DD (inclusive)
 * @param to   YYYY-MM-DD (inclusive)
 */
export async function getSummaries(
  from: string,
  to: string,
): Promise<DailySummary[]> {
  return invoke<DailySummary[]>('memory_get_summaries', { from, to });
}

/**
 * Run the nightly summary job for a specific date.
 * In v1, always uses the stats-only fallback (no LLM).
 */
export async function runNightly(
  date: string,
): Promise<NightlyResult> {
  return invoke<NightlyResult>('memory_run_nightly', { date });
}

/**
 * Clear all memory — deletes the DB file and recreates.
 * §11: "must be a real delete, not a soft flag."
 */
export async function clearMemory(): Promise<void> {
  return invoke<void>('memory_clear');
}

/** Get diagnostic info: path, size, row counts. */
export async function getStatus(): Promise<MemoryStatus> {
  return invoke<MemoryStatus>('memory_status');
}
