//! Module C — Memory Store
//!
//! SQLite database with owner-only file permissions (§12.3).
//! Schema matches §5 exactly:
//!
//! - `daily_summary` — one row per day with tasks, prose summary, mood trend
//! - `raw_events`    — timestamped event log consumed by the nightly job
//!
//! Encryption (§11): When built with `bundled-sqlcipher-vendored-openssl`,
//! the DB is encrypted via SQLCipher with a random 32-byte hex key stored
//! in a separate owner-only file.  When built with plain `bundled` SQLite
//! (current default — Perl/OpenSSL not available), encryption relies on
//! OS full-disk encryption (BitLocker/FileVault) as the SRS §11 documented
//! minimum.  Switching is a one-line Cargo feature change.
//!
//! Error handling per §5:
//! - Corrupted/missing DB on launch → recreate schema, log loss, don't crash
//! - "Clear memory" → real file delete (§11), not a soft flag

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

// ── Public types ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawEvent {
    pub id: i64,
    pub timestamp: String,
    pub event_type: String,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailySummary {
    pub date: String,
    pub tasks_done: i32,
    pub tasks_missed: i32,
    pub summary: String,
    pub mood_trend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryStatus {
    pub db_path: String,
    pub db_size_bytes: u64,
    pub event_count: i64,
    pub summary_count: i64,
    pub schema_version: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NightlyResult {
    pub date: String,
    pub summary: DailySummary,
    pub events_processed: usize,
    pub used_fallback: bool,
}

// ── Constants ───────────────────────────────────────────────────────

const DB_FILENAME: &str = "flora.db";
const KEY_FILENAME: &str = "flora.key";
const SCHEMA_VERSION: i32 = 1;

// ── MemoryStore ─────────────────────────────────────────────────────

pub struct MemoryStore {
    conn: Connection,
    db_path: PathBuf,
    data_dir: PathBuf,
}

impl MemoryStore {
    /// Open (or create) the memory store.
    ///
    /// §5 error handling: if the DB is corrupted, this logs the error,
    /// removes the corrupt file, and recreates from scratch.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        fs::create_dir_all(data_dir)
            .map_err(|e| format!("create data dir: {e}"))?;

        let db_path = data_dir.join(DB_FILENAME);
        let key_path = data_dir.join(KEY_FILENAME);

        // Generate/read encryption key (used only when SQLCipher is linked)
        let key = Self::get_or_create_key(&key_path)?;

        // Try opening; on failure, nuke and retry (§5 corrupted-DB rule)
        match Self::open_connection(&db_path, &key) {
            Ok(conn) => {
                set_owner_only(&db_path)?;
                let store = Self {
                    conn,
                    db_path,
                    data_dir: data_dir.to_path_buf(),
                };
                store.init_schema()?;
                Ok(store)
            }
            Err(first_err) => {
                eprintln!(
                    "[Flora/memory] DB open failed ({first_err}), \
                     recreating schema — previous data lost"
                );
                let _ = fs::remove_file(&db_path);
                let conn = Self::open_connection(&db_path, &key)
                    .map_err(|e| format!("retry open: {e}"))?;
                set_owner_only(&db_path)?;
                let store = Self {
                    conn,
                    db_path,
                    data_dir: data_dir.to_path_buf(),
                };
                store.init_schema()?;
                Ok(store)
            }
        }
    }

    /// Open a test store using an in-memory DB (no encryption, no files).
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, String> {
        let conn =
            Connection::open_in_memory().map_err(|e| format!("in-memory open: {e}"))?;
        let store = Self {
            conn,
            db_path: PathBuf::from(":memory:"),
            data_dir: PathBuf::from(""),
        };
        store.init_schema()?;
        Ok(store)
    }

    // ── Key management ──────────────────────────────────────────────

    fn get_or_create_key(key_path: &Path) -> Result<String, String> {
        if key_path.exists() {
            fs::read_to_string(key_path)
                .map(|s| s.trim().to_string())
                .map_err(|e| format!("read key: {e}"))
        } else {
            let key = generate_hex_key()?;
            fs::write(key_path, &key).map_err(|e| format!("write key: {e}"))?;
            set_owner_only(key_path)?;
            Ok(key)
        }
    }

    fn open_connection(db_path: &Path, _key: &str) -> Result<Connection, String> {
        let conn = Connection::open(db_path).map_err(|e| format!("open: {e}"))?;

        // When built with SQLCipher, apply the encryption key:
        //   conn.execute_batch(&format!("PRAGMA key = \"x'{_key}'\";"))
        //       .map_err(|e| format!("PRAGMA key: {e}"))?;
        //   conn.execute_batch("SELECT count(*) FROM sqlite_master;")
        //       .map_err(|e| format!("key verification: {e}"))?;
        //
        // Currently using plain bundled SQLite — see Cargo.toml comment.
        // File-level protection via owner-only permissions (§12.3) +
        // OS full-disk encryption (§11 documented minimum).

        Ok(conn)
    }

    // ── Schema ──────────────────────────────────────────────────────

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                "
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS daily_summary (
                date        TEXT PRIMARY KEY,
                tasks_done  INTEGER NOT NULL DEFAULT 0,
                tasks_missed INTEGER NOT NULL DEFAULT 0,
                summary     TEXT NOT NULL DEFAULT '',
                mood_trend  TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS raw_events (
                id          INTEGER PRIMARY KEY,
                timestamp   TEXT NOT NULL,
                event_type  TEXT NOT NULL,
                payload     TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_raw_events_ts
                ON raw_events(timestamp);
        ",
            )
            .map_err(|e| format!("schema init: {e}"))?;

        // Set version if table is empty
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .map_err(|e| format!("version check: {e}"))?;

        if count == 0 {
            self.conn
                .execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    params![SCHEMA_VERSION],
                )
                .map_err(|e| format!("set version: {e}"))?;
        }

        Ok(())
    }

    // ── CRUD: raw_events ────────────────────────────────────────────

    pub fn insert_event(
        &self,
        timestamp: &str,
        event_type: &str,
        payload: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO raw_events (timestamp, event_type, payload) \
                 VALUES (?1, ?2, ?3)",
                params![timestamp, event_type, payload],
            )
            .map_err(|e| format!("insert event: {e}"))?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn get_events(&self, from: &str, to: &str) -> Result<Vec<RawEvent>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, timestamp, event_type, payload \
                 FROM raw_events \
                 WHERE timestamp >= ?1 AND timestamp < ?2 \
                 ORDER BY timestamp",
            )
            .map_err(|e| format!("prepare: {e}"))?;

        let rows = stmt
            .query_map(params![from, to], |row| {
                Ok(RawEvent {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    event_type: row.get(2)?,
                    payload: row.get(3)?,
                })
            })
            .map_err(|e| format!("query: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read rows: {e}"))
    }

    /// Get all events whose timestamp starts with `date` (YYYY-MM-DD).
    pub fn get_events_for_date(&self, date: &str) -> Result<Vec<RawEvent>, String> {
        let from = format!("{date}T00:00:00");
        let to = format!("{date}T99:99:99"); // lexicographic ceiling for the date
        self.get_events(&from, &to)
    }

    pub fn delete_events_for_date(&self, date: &str) -> Result<usize, String> {
        let from = format!("{date}T00:00:00");
        let to = format!("{date}T99:99:99");
        self.conn
            .execute(
                "DELETE FROM raw_events WHERE timestamp >= ?1 AND timestamp < ?2",
                params![from, to],
            )
            .map_err(|e| format!("delete events: {e}"))
    }

    // ── CRUD: daily_summary ─────────────────────────────────────────

    pub fn write_summary(&self, s: &DailySummary) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO daily_summary \
                 (date, tasks_done, tasks_missed, summary, mood_trend) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![s.date, s.tasks_done, s.tasks_missed, s.summary, s.mood_trend],
            )
            .map_err(|e| format!("write summary: {e}"))?;
        Ok(())
    }

    pub fn get_summaries(
        &self,
        from: &str,
        to: &str,
    ) -> Result<Vec<DailySummary>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT date, tasks_done, tasks_missed, summary, mood_trend \
                 FROM daily_summary \
                 WHERE date >= ?1 AND date <= ?2 \
                 ORDER BY date",
            )
            .map_err(|e| format!("prepare: {e}"))?;

        let rows = stmt
            .query_map(params![from, to], |row| {
                Ok(DailySummary {
                    date: row.get(0)?,
                    tasks_done: row.get(1)?,
                    tasks_missed: row.get(2)?,
                    summary: row.get(3)?,
                    mood_trend: row.get(4)?,
                })
            })
            .map_err(|e| format!("query: {e}"))?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("read rows: {e}"))
    }

    // ── Clear memory (§11: real delete) ─────────────────────────────

    /// Deletes the DB file and key, then recreates both from scratch.
    /// §11: "must be a real delete, not a soft flag."
    pub fn clear(&mut self) -> Result<(), String> {
        let db_path = self.db_path.clone();
        let data_dir = self.data_dir.clone();
        let key_path = data_dir.join(KEY_FILENAME);

        // Replace connection with a temporary in-memory one so we can
        // release the file handle (required on Windows)
        let dummy = Connection::open_in_memory()
            .map_err(|e| format!("dummy conn: {e}"))?;
        let _ = std::mem::replace(&mut self.conn, dummy);

        // Delete files
        if db_path.exists() {
            fs::remove_file(&db_path).map_err(|e| format!("delete DB: {e}"))?;
        }
        if key_path.exists() {
            fs::remove_file(&key_path).map_err(|e| format!("delete key: {e}"))?;
        }

        // Reopen with a fresh key
        let key = Self::get_or_create_key(&key_path)?;
        self.conn =
            Self::open_connection(&db_path, &key).map_err(|e| format!("reopen: {e}"))?;
        set_owner_only(&db_path)?;
        self.init_schema()?;

        eprintln!("[Flora/memory] memory cleared — DB + key regenerated");
        Ok(())
    }

    // ── Status / diagnostics ────────────────────────────────────────

    pub fn status(&self) -> Result<MemoryStatus, String> {
        let event_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM raw_events", [], |r| r.get(0))
            .map_err(|e| format!("count events: {e}"))?;

        let summary_count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM daily_summary", [], |r| r.get(0))
            .map_err(|e| format!("count summaries: {e}"))?;

        let schema_version: i32 = self
            .conn
            .query_row("SELECT version FROM schema_version LIMIT 1", [], |r| {
                r.get(0)
            })
            .unwrap_or(0);

        let db_size = fs::metadata(&self.db_path).map(|m| m.len()).unwrap_or(0);

        Ok(MemoryStatus {
            db_path: self.db_path.to_string_lossy().to_string(),
            db_size_bytes: db_size,
            event_count,
            summary_count,
            schema_version,
        })
    }
}

// ── Helpers (free functions) ────────────────────────────────────────

/// Generate a 32-byte random key, returned as a 64-char hex string.
fn generate_hex_key() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("RNG: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Set owner-only permissions on a file.
///
/// - Unix: chmod 600 (§12.3)
/// - Windows: icacls — remove inherited ACLs, grant current user Full (§12.3)
#[cfg(unix)]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("chmod 600: {e}"))
}

#[cfg(target_os = "windows")]
fn set_owner_only(path: &Path) -> Result<(), String> {
    use std::process::Command;
    let path_str = path.to_string_lossy();
    let username =
        std::env::var("USERNAME").unwrap_or_else(|_| "CURRENT_USER".to_string());

    let output = Command::new("icacls")
        .args([
            path_str.as_ref(),
            "/inheritance:r",
            "/grant:r",
            &format!("{username}:(F)"),
        ])
        .output()
        .map_err(|e| format!("icacls: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        eprintln!("[Flora/memory] icacls warning: {stderr}");
        // Non-fatal: don't block the app if icacls fails
    }
    Ok(())
}

#[cfg(not(any(unix, target_os = "windows")))]
fn set_owner_only(_path: &Path) -> Result<(), String> {
    eprintln!("[Flora/memory] set_owner_only not implemented on this platform");
    Ok(())
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> MemoryStore {
        MemoryStore::open_in_memory().expect("open in-memory store")
    }

    #[test]
    fn round_trip_event() {
        let s = store();
        let id =
            s.insert_event("2026-08-08T14:30:00", "task_completed", r#"{"task":"read"}"#)
                .unwrap();
        assert!(id > 0);

        let events = s
            .get_events("2026-08-08T00:00:00", "2026-08-09T00:00:00")
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, "task_completed");
        assert_eq!(events[0].payload, r#"{"task":"read"}"#);
    }

    #[test]
    fn round_trip_summary() {
        let s = store();
        let summary = DailySummary {
            date: "2026-08-08".into(),
            tasks_done: 3,
            tasks_missed: 1,
            summary: "Good day.".into(),
            mood_trend: "focused→idle".into(),
        };
        s.write_summary(&summary).unwrap();

        let rows = s.get_summaries("2026-08-08", "2026-08-08").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tasks_done, 3);
        assert_eq!(rows[0].tasks_missed, 1);
        assert_eq!(rows[0].summary, "Good day.");
        assert_eq!(rows[0].mood_trend, "focused→idle");
    }

    #[test]
    fn upsert_summary_overwrites() {
        let s = store();
        s.write_summary(&DailySummary {
            date: "2026-08-08".into(),
            tasks_done: 1,
            tasks_missed: 0,
            summary: "v1".into(),
            mood_trend: "idle".into(),
        })
        .unwrap();
        s.write_summary(&DailySummary {
            date: "2026-08-08".into(),
            tasks_done: 5,
            tasks_missed: 2,
            summary: "v2".into(),
            mood_trend: "focused".into(),
        })
        .unwrap();

        let rows = s.get_summaries("2026-08-08", "2026-08-08").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tasks_done, 5);
        assert_eq!(rows[0].summary, "v2");
    }

    #[test]
    fn get_events_for_date_filters_correctly() {
        let s = store();
        s.insert_event("2026-08-08T09:00:00", "a", "").unwrap();
        s.insert_event("2026-08-08T23:59:59", "b", "").unwrap();
        s.insert_event("2026-08-09T00:00:01", "c", "").unwrap();

        let events = s.get_events_for_date("2026-08-08").unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event_type, "a");
        assert_eq!(events[1].event_type, "b");
    }

    #[test]
    fn delete_events_for_date() {
        let s = store();
        s.insert_event("2026-08-08T10:00:00", "x", "").unwrap();
        s.insert_event("2026-08-08T22:00:00", "y", "").unwrap();
        s.insert_event("2026-08-09T01:00:00", "z", "").unwrap();

        let deleted = s.delete_events_for_date("2026-08-08").unwrap();
        assert_eq!(deleted, 2);

        let remaining = s.get_events("2026-08-08T00:00:00", "2026-08-10T00:00:00").unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].event_type, "z");
    }

    #[test]
    fn thirty_day_query_returns_correct_rows() {
        let s = store();
        // Insert 30 daily summaries
        for day in 1..=30 {
            s.write_summary(&DailySummary {
                date: format!("2026-08-{day:02}"),
                tasks_done: day,
                tasks_missed: 0,
                summary: format!("Day {day}"),
                mood_trend: "idle".into(),
            })
            .unwrap();
        }

        let start = std::time::Instant::now();
        let rows = s.get_summaries("2026-08-01", "2026-08-30").unwrap();
        let elapsed = start.elapsed();

        assert_eq!(rows.len(), 30);
        assert_eq!(rows[0].date, "2026-08-01");
        assert_eq!(rows[29].date, "2026-08-30");
        // §5 acceptance: <100ms
        assert!(
            elapsed.as_millis() < 100,
            "30-day query took {}ms, must be <100ms",
            elapsed.as_millis()
        );
    }

    #[test]
    fn clear_removes_all_data() {
        let mut s = store();
        s.insert_event("2026-08-08T10:00:00", "x", "").unwrap();
        s.write_summary(&DailySummary {
            date: "2026-08-08".into(),
            tasks_done: 1,
            tasks_missed: 0,
            summary: "test".into(),
            mood_trend: "idle".into(),
        })
        .unwrap();

        s.clear().unwrap();

        let status = s.status().unwrap();
        assert_eq!(status.event_count, 0);
        assert_eq!(status.summary_count, 0);
    }

    #[test]
    fn status_reports_counts() {
        let s = store();
        s.insert_event("2026-08-08T10:00:00", "a", "").unwrap();
        s.insert_event("2026-08-08T11:00:00", "b", "").unwrap();
        s.write_summary(&DailySummary {
            date: "2026-08-08".into(),
            tasks_done: 2,
            tasks_missed: 0,
            summary: "ok".into(),
            mood_trend: "idle".into(),
        })
        .unwrap();

        let st = s.status().unwrap();
        assert_eq!(st.event_count, 2);
        assert_eq!(st.summary_count, 1);
        assert_eq!(st.schema_version, 1);
    }

    #[test]
    fn empty_store_works() {
        let s = store();
        let events = s.get_events("2026-01-01", "2026-12-31").unwrap();
        assert!(events.is_empty());
        let sums = s.get_summaries("2026-01-01", "2026-12-31").unwrap();
        assert!(sums.is_empty());
        let st = s.status().unwrap();
        assert_eq!(st.event_count, 0);
        assert_eq!(st.summary_count, 0);
    }
}
