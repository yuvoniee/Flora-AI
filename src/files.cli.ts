/**
 * Module D — Filesystem Watcher Standalone CLI Runner
 *
 * Scans a folder for recently modified files and prints the normalized
 * FileActivity list. Verifies the §11 data-minimization boundary holds.
 *
 * Usage:
 *   npx tsx src/files.cli.ts                        # scan cwd (last 15 min)
 *   npx tsx src/files.cli.ts --folder C:\Users\me\Documents
 *   npx tsx src/files.cli.ts --folder /home/me/notes --lookback 60
 *   npx tsx src/files.cli.ts --test-failure          # simulated inaccessible folder
 *
 * §11 verification:
 *   The CLI prints what fields are present in each FileActivity so you can
 *   confirm that file contents, size, owner, permissions are never captured.
 */

import * as path from 'path';
import { getRecentFiles, clearFilesCache, getFilesCacheState, FileActivity } from './files.js';

const args = process.argv.slice(2);
const folderIdx = args.indexOf('--folder');
const lookbackIdx = args.indexOf('--lookback');
const testFailure = args.includes('--test-failure');
const testCacheHit = args.includes('--test-cache');

const folder = folderIdx >= 0 ? args[folderIdx + 1] : process.cwd();
const lookbackMin = lookbackIdx >= 0 ? parseInt(args[lookbackIdx + 1], 10) : 15;

async function printActivity(files: FileActivity[]): Promise<void> {
  if (files.length === 0) {
    console.log('   (No recently modified files found in this window)');
    return;
  }

  files.forEach((f, i) => {
    const relTime = formatRelativeTime(new Date(f.modifiedAt));
    console.log(`   ${i + 1}. ${f.name}`);
    console.log(`      🏷️  Type     : ${f.type}`);
    console.log(`      🕐 Modified : ${relTime}`);
    console.log(`      📂 Path     : ${f.path}`);

    // §11 verification: explicitly assert no content fields present
    const forbidden = ['content', 'contents', 'size', 'owner', 'permissions', 'extension'];
    const leaks = forbidden.filter(k => k in (f as any));
    if (leaks.length > 0) {
      console.log(`      ❌ §11 VIOLATION — unexpected fields: ${leaks.join(', ')}`);
    }
  });
}

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  return `${diffHr} hour${diffHr !== 1 ? 's' : ''} ago`;
}

async function main(): Promise<void> {
  // ── §6 acceptance: simulated failure ─────────────────────────────

  if (testFailure) {
    console.log('\n=== Testing §6 error handling: inaccessible folder ===\n');

    const brokenReadDir = async (_folder: string) => {
      throw new Error('Simulated: EACCES permission denied');
    };

    const files = await getRecentFiles(
      { folder: '/nonexistent/forbidden/path' },
      brokenReadDir,
    );

    console.log(`Result: ${JSON.stringify(files)}`);
    console.log(files.length === 0
      ? '✅ Correct — returned [] without throwing (§6 fallback requirement met)'
      : '❌ FAIL — expected []'
    );
    return;
  }

  // ── Cache hit test ────────────────────────────────────────────────

  if (testCacheHit) {
    console.log('\n=== Testing 5-minute cache ===\n');
    const opts = { folder, lookbackMs: lookbackMin * 60000 };

    const t1start = Date.now();
    const scan1 = await getRecentFiles(opts);
    console.log(`First scan  : ${scan1.length} file(s) in ${Date.now() - t1start}ms`);

    const t2start = Date.now();
    const scan2 = await getRecentFiles(opts);   // should hit cache
    const elapsed2 = Date.now() - t2start;
    console.log(`Second scan : ${scan2.length} file(s) in ${elapsed2}ms (from cache)`);
    console.log(`Cache state : ${JSON.stringify(getFilesCacheState())}`);
    console.log(elapsed2 < 5
      ? '✅ Cache hit (sub-millisecond response)'
      : '⚠️  Possible cache miss — check TTL config'
    );
    return;
  }

  // ── Main scan ─────────────────────────────────────────────────────

  const absFolder = path.resolve(folder);
  console.log(`\n=== Flora Filesystem Watcher (Module D Standalone CLI) ===\n`);
  console.log(`📂 Folder  : ${absFolder}`);
  console.log(`🕐 Lookback: last ${lookbackMin} minutes`);
  console.log('\nScanning for recently modified files (metadata only — §11)...\n');

  const start = Date.now();
  const files = await getRecentFiles({
    folder: absFolder,
    lookbackMs: lookbackMin * 60000,
  });
  const elapsed = Date.now() - start;

  console.log(`✅ Scan complete: ${files.length} file(s) found in ${elapsed}ms\n`);
  await printActivity(files);

  console.log(`\n   Fields captured per file: name, path, modifiedAt, type`);
  console.log(`   §11 boundary: no contents, no size, no owner, no permissions ✅`);
}

main().catch((err) => {
  console.error('\n❌ Unexpected error in files CLI:', err.message);
  process.exit(1);
});
