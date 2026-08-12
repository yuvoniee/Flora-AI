import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as path from 'path';
import {
  getRecentFiles,
  clearFilesCache,
  getFilesCacheState,
  classifyFile,
  defaultReadDir,
  DirEntry,
} from './files';

// ── Helpers ────────────────────────────────────────────────────────────

const NOW = Date.now();
const MINS = (n: number) => n * 60 * 1000;

function makeDirFn(entries: DirEntry[]) {
  return vi.fn().mockResolvedValue(entries);
}

function recentEntry(name: string, minutesAgo = 5): DirEntry {
  return { name, modifiedAtMs: NOW - MINS(minutesAgo) };
}

function oldEntry(name: string, minutesAgo = 60): DirEntry {
  return { name, modifiedAtMs: NOW - MINS(minutesAgo) };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('Module D — Filesystem Watcher Integration', () => {
  beforeEach(() => {
    clearFilesCache();
    vi.restoreAllMocks();
  });

  // ── classifyFile ────────────────────────────────────────────────────

  describe('classifyFile (§11: type categories, never raw extension)', () => {
    it('classifies common document extensions', () => {
      expect(classifyFile('report.pdf')).toBe('document');
      expect(classifyFile('notes.md')).toBe('document');
      expect(classifyFile('letter.docx')).toBe('document');
    });

    it('classifies image files', () => {
      expect(classifyFile('photo.jpg')).toBe('image');
      expect(classifyFile('screenshot.png')).toBe('image');
      expect(classifyFile('design.svg')).toBe('image');
    });

    it('classifies code files', () => {
      expect(classifyFile('main.ts')).toBe('code');
      expect(classifyFile('lib.rs')).toBe('code');
      expect(classifyFile('app.py')).toBe('code');
    });

    it('classifies audio and video', () => {
      expect(classifyFile('track.mp3')).toBe('audio');
      expect(classifyFile('clip.mp4')).toBe('video');
    });

    it('falls back to "other" for unknown extensions', () => {
      expect(classifyFile('file.xyz')).toBe('other');
      expect(classifyFile('binary.bin')).toBe('other');
    });

    it('is case-insensitive for extensions', () => {
      expect(classifyFile('IMAGE.PNG')).toBe('image');
      expect(classifyFile('Doc.PDF')).toBe('document');
    });
  });

  // ── getRecentFiles — success ────────────────────────────────────────

  describe('getRecentFiles — success path', () => {
    it('returns files modified within the lookback window', async () => {
      const readDir = makeDirFn([
        recentEntry('notes.md', 3),
        recentEntry('report.pdf', 10),
        oldEntry('archive.zip', 120),
      ]);

      const files = await getRecentFiles(
        { folder: '/test/folder', lookbackMs: MINS(15) },
        readDir,
      );

      expect(files).toHaveLength(2);
      expect(files[0].name).toBe('notes.md');     // sorted most-recent first
      expect(files[1].name).toBe('report.pdf');
    });

    it('normalizes the FileActivity shape correctly', async () => {
      const readDir = makeDirFn([recentEntry('todo.txt', 2)]);
      const files = await getRecentFiles({ folder: '/home/user/docs' }, readDir);

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('todo.txt');
      expect(files[0].type).toBe('document');
      expect(files[0].path).toBe(path.join('/home/user/docs', 'todo.txt'));
      expect(files[0].modifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);  // ISO 8601
    });

    it('returns [] when no files modified within lookback window', async () => {
      const readDir = makeDirFn([oldEntry('old-file.pdf', 120)]);
      const files = await getRecentFiles({ folder: '/test', lookbackMs: MINS(15) }, readDir);
      expect(files).toEqual([]);
    });

    it('respects maxFiles limit', async () => {
      const many = Array.from({ length: 30 }, (_, i) => recentEntry(`file-${i}.md`, i + 1));
      const readDir = makeDirFn(many);
      const files = await getRecentFiles({ folder: '/test', maxFiles: 5 }, readDir);
      expect(files).toHaveLength(5);
    });

    it('sorts by most-recently-modified descending', async () => {
      const readDir = makeDirFn([
        recentEntry('oldest.txt', 14),
        recentEntry('newest.txt', 1),
        recentEntry('middle.txt', 7),
      ]);
      const files = await getRecentFiles({ folder: '/test', lookbackMs: MINS(15) }, readDir);
      expect(files[0].name).toBe('newest.txt');
      expect(files[1].name).toBe('middle.txt');
      expect(files[2].name).toBe('oldest.txt');
    });
  });

  // ── getRecentFiles — §11 boundary enforcement ───────────────────────

  describe('getRecentFiles — §11 data minimization boundary', () => {
    it('FileActivity objects contain NO file content fields', async () => {
      const readDir = makeDirFn([recentEntry('secret-doc.pdf', 2)]);
      const files = await getRecentFiles({ folder: '/test' }, readDir);
      const file = files[0];

      // Allowed fields
      expect(file.name).toBeDefined();
      expect(file.path).toBeDefined();
      expect(file.modifiedAt).toBeDefined();
      expect(file.type).toBeDefined();

      // §11 forbidden fields — must NOT exist on the object
      expect((file as any).content).toBeUndefined();
      expect((file as any).contents).toBeUndefined();
      expect((file as any).size).toBeUndefined();
      expect((file as any).owner).toBeUndefined();
      expect((file as any).permissions).toBeUndefined();
      expect((file as any).extension).toBeUndefined();  // raw ext must not leak
    });
  });

  // ── getRecentFiles — caching ────────────────────────────────────────

  describe('getRecentFiles — caching', () => {
    it('caches results and does not re-scan within TTL', async () => {
      const readDir = makeDirFn([recentEntry('doc.pdf', 3)]);

      const first = await getRecentFiles({ folder: '/test' }, readDir);
      const second = await getRecentFiles({ folder: '/test' }, readDir);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(readDir).toHaveBeenCalledTimes(1);
      expect(getFilesCacheState().cached).toBe(true);
    });

    it('bypasses cache when forceRefresh is true', async () => {
      const readDir = makeDirFn([recentEntry('doc.pdf', 3)]);
      await getRecentFiles({ folder: '/test' }, readDir);
      await getRecentFiles({ folder: '/test', forceRefresh: true }, readDir);
      expect(readDir).toHaveBeenCalledTimes(2);
    });

    it('does NOT use cache from a different folder', async () => {
      const readDir = makeDirFn([recentEntry('file.md', 1)]);
      await getRecentFiles({ folder: '/folder-a' }, readDir);
      await getRecentFiles({ folder: '/folder-b' }, readDir);
      expect(readDir).toHaveBeenCalledTimes(2);
    });
  });

  // ── getRecentFiles — error handling (§6) ───────────────────────────

  describe('getRecentFiles — error handling fallbacks', () => {
    it('returns [] and does not throw when folder is inaccessible', async () => {
      const brokenReadDir = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
      const files = await getRecentFiles({ folder: '/forbidden' }, brokenReadDir);
      expect(files).toEqual([]);
    });

    it('returns stale cache when scan fails but cache exists', async () => {
      const goodReadDir = makeDirFn([recentEntry('cached.pdf', 3)]);
      await getRecentFiles({ folder: '/test' }, goodReadDir);

      const brokenReadDir = vi.fn().mockRejectedValue(new Error('ENOENT: folder removed'));
      const files = await getRecentFiles({ folder: '/test', forceRefresh: true }, brokenReadDir);

      expect(files).toHaveLength(1);
      expect(files[0].name).toBe('cached.pdf');
    });

    it('returns [] and does not throw when readDir throws unexpectedly', async () => {
      const crashReadDir = vi.fn().mockImplementation(() => {
        throw new Error('Unexpected crash');
      });
      const files = await getRecentFiles({ folder: '/test' }, crashReadDir as any);
      expect(files).toEqual([]);
    });
  });
});
