/**
 * Module D — Filesystem Watcher Integration
 *
 * Scans a user-chosen folder for recently created or modified files.
 *
 * §11 hard boundary (data minimization):
 *   - Captures filename and modified time ONLY — never file contents.
 *   - Raw filenames are never logged to the memory store or sent to any LLM;
 *     only the normalized metadata object leaves this module.
 *
 * Requirements (§6):
 * - Normalized output: FileActivity[]  ({ name, path, modifiedAt, type })
 * - Read-only on chosen folder, no content parsing in v1
 * - Error handling: any failure returns [] (never throws uncaught)
 * - 5-minute in-memory cache
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────

/** File type category — never a raw extension that leaks content details */
export type FileType = 'document' | 'image' | 'video' | 'audio' | 'code' | 'data' | 'other';

export interface FileActivity {
  name: string;         // filename (basename only — not full path, for display)
  path: string;         // absolute path (for deduplication/state tracking)
  modifiedAt: string;   // ISO 8601 timestamp of last modification
  type: FileType;       // normalized category — never raw MIME or extension
  // NEVER: contents, size >metadata, owner, permissions — §11 hard boundary
}

export interface WatcherOptions {
  folder?: string;           // absolute path to watch (required for live use; defaults to cwd in tests)
  lookbackMs?: number;       // how far back to look for recent files (default: 15 min)
  maxFiles?: number;         // max files to return (default: 20)
  ttlMs?: number;            // cache TTL (default: 5 min)
  forceRefresh?: boolean;
}

// ── Extension → FileType mapping ──────────────────────────────────────
// Mapping here prevents raw extensions leaking up the stack as raw strings.

const EXT_MAP: Record<string, FileType> = {
  // Documents
  '.pdf': 'document', '.doc': 'document', '.docx': 'document',
  '.txt': 'document', '.md': 'document', '.rtf': 'document',
  '.odt': 'document', '.pages': 'document',
  // Images
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.svg': 'image', '.heic': 'image', '.bmp': 'image',
  // Video
  '.mp4': 'video', '.mov': 'video', '.avi': 'video', '.mkv': 'video',
  '.webm': 'video',
  // Audio
  '.mp3': 'audio', '.flac': 'audio', '.wav': 'audio', '.aac': 'audio',
  '.ogg': 'audio', '.m4a': 'audio',
  // Code
  '.ts': 'code', '.js': 'code', '.tsx': 'code', '.jsx': 'code',
  '.py': 'code', '.rs': 'code', '.go': 'code', '.java': 'code',
  '.c': 'code', '.cpp': 'code', '.h': 'code', '.rb': 'code',
  '.swift': 'code', '.kt': 'code', '.css': 'code', '.html': 'code',
  '.json': 'code', '.yaml': 'code', '.toml': 'code', '.xml': 'code',
  '.sh': 'code', '.ps1': 'code',
  // Data
  '.csv': 'data', '.xlsx': 'data', '.xls': 'data', '.parquet': 'data',
  '.db': 'data', '.sqlite': 'data',
};

export function classifyFile(filename: string): FileType {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MAP[ext] ?? 'other';
}

// ── In-memory cache ────────────────────────────────────────────────────

interface CacheEntry {
  files: FileActivity[];
  fetchedAt: number;
  folder: string;
}

let cache: CacheEntry | null = null;

// ── Filesystem scanner ────────────────────────────────────────────────

/**
 * Reads directory entries using an injectable readdir function so tests
 * can pass fake filesystem data without touching disk.
 */
export interface DirEntry {
  name: string;
  modifiedAtMs: number; // unix ms
}

export type ReadDirFn = (folder: string) => Promise<DirEntry[]>;

/** Default implementation: real fs.readdir + fs.stat */
export async function defaultReadDir(folder: string): Promise<DirEntry[]> {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const results: DirEntry[] = [];

  for (const entry of entries) {
    // Skip directories, hidden files, and system files — metadata only
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;

    try {
      const fullPath = path.join(folder, entry.name);
      // stat gives us mtime — the ONLY metadata we read (§11)
      const stat = await fs.promises.stat(fullPath);
      results.push({
        name: entry.name,
        modifiedAtMs: stat.mtimeMs,
      });
    } catch {
      // Skip files we can't stat (permissions, deleted between readdir and stat)
    }
  }

  return results;
}

/**
 * Single normalized function to get recently modified files in a folder.
 *
 * Returns `FileActivity[]` sorted by most-recently-modified first.
 * Returns `[]` on any error — never throws uncaught.
 * Never reads file contents (§11 hard boundary).
 */
export async function getRecentFiles(
  options: WatcherOptions = {},
  readDirFn: ReadDirFn = defaultReadDir,
): Promise<FileActivity[]> {
  const folder = options.folder ?? process.cwd();
  const lookbackMs = options.lookbackMs ?? 15 * 60 * 1000;  // 15 minutes
  const maxFiles = options.maxFiles ?? 20;
  const ttlMs = options.ttlMs ?? 5 * 60 * 1000;             // 5-minute cache
  const forceRefresh = options.forceRefresh ?? false;

  const now = Date.now();

  // Return cached result if valid and for the same folder
  if (!forceRefresh && cache && cache.folder === folder && (now - cache.fetchedAt) < ttlMs) {
    return cache.files;
  }

  try {
    const entries = await readDirFn(folder);
    const cutoff = now - lookbackMs;

    const recent: FileActivity[] = entries
      .filter(e => e.modifiedAtMs >= cutoff)
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs)
      .slice(0, maxFiles)
      .map(e => ({
        name: e.name,
        path: path.join(folder, e.name),
        modifiedAt: new Date(e.modifiedAtMs).toISOString(),
        type: classifyFile(e.name),
      }));

    cache = { files: recent, fetchedAt: now, folder };
    return recent;
  } catch (err: any) {
    console.warn(`[Flora/files] Failed to scan folder "${folder}": ${err?.message}`);
    // Degrade gracefully — return stale cache if available, else empty
    return cache && cache.folder === folder ? cache.files : [];
  }
}

// ── Cache helpers ─────────────────────────────────────────────────────

export function clearFilesCache(): void {
  cache = null;
}

export function getFilesCacheState(): { cached: boolean; ageMs?: number; fileCount?: number } {
  if (!cache) return { cached: false };
  return {
    cached: true,
    ageMs: Date.now() - cache.fetchedAt,
    fileCount: cache.files.length,
  };
}
