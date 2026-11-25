/**
 * Log-file pruning — TypeScript port of `servermanage/log_cleanup.py`.
 *
 * The oracle deletes rotated/expired `*.log` files from a single directory,
 * never descending into sub-directories and never touching names that a live
 * process may still hold open. Timestamps are compared against an injectable
 * clock so the behaviour is deterministic under test.
 *
 * Deviation from the Python oracle: the oracle's `Path.is_file()` follows
 * symlinks, so a symlinked log would have its *target* size tallied (while
 * `unlink()` removes only the link). This port deliberately refuses to follow
 * symlinks in any cleanup routine — a destructive maintenance job must never
 * reach outside the directory it was handed.
 */
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Number of files removed and bytes reclaimed. Matches the oracle's dict shape. */
export interface CleanupResult {
  deleted: number;
  bytes: number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Delete log files older than `retentionHours` from `logDir`.
 *
 * Port of `servermanage.log_cleanup.prune_log_files`:
 *
 * - a missing / non-directory path is a no-op (`{deleted: 0, bytes: 0}`);
 * - only the immediate children are considered (no recursion);
 * - a file qualifies when its name ends with `.log` or contains `.log.`
 *   (rotated names such as `servermonitor.log.1`), matching Python exactly;
 * - names in `protectedNames` are never removed;
 * - files whose mtime is `>=` the cutoff are kept (boundary is inclusive);
 * - a stat / unlink failure skips that entry instead of aborting the sweep.
 *
 * @param logDir          Directory holding the log files.
 * @param retentionHours  Retention window in hours (default 24). `0` expires
 *                        everything whose mtime is before `now`.
 * @param now             Clock injection. Defaults to `new Date()`.
 * @param protectedNames  File names that must never be deleted.
 */
export function pruneLogFiles(
  logDir: string,
  retentionHours = 24,
  now: Date | null = null,
  protectedNames: Iterable<string> = [],
): CleanupResult {
  // Python `Path.is_dir()` — false for missing paths, files, or unreadable dirs.
  try {
    if (!statSync(logDir).isDirectory()) {
      return { deleted: 0, bytes: 0 };
    }
  } catch {
    return { deleted: 0, bytes: 0 };
  }

  let entries;
  try {
    entries = readdirSync(logDir, { withFileTypes: true });
  } catch {
    return { deleted: 0, bytes: 0 };
  }

  const cutoff = (now ?? new Date()).getTime() - retentionHours * HOUR_MS;
  const protectedSet = new Set<string>();
  for (const name of protectedNames) {
    protectedSet.add(String(name));
  }

  let deleted = 0;
  let bytes = 0;
  for (const entry of entries) {
    const name = entry.name;
    if (protectedSet.has(name)) {
      continue;
    }
    if (!name.endsWith('.log') && !name.includes('.log.')) {
      continue;
    }
    // `Dirent.isFile()` is lstat-based: symlinks are never "files", so they are
    // skipped rather than followed.
    if (!entry.isFile()) {
      continue;
    }
    const filePath = join(logDir, name);
    let stats;
    try {
      stats = lstatSync(filePath);
    } catch {
      continue;
    }
    if (stats.mtimeMs >= cutoff) {
      continue;
    }
    try {
      rmSync(filePath, { force: true });
    } catch {
      continue;
    }
    deleted += 1;
    bytes += stats.size;
  }

  return { deleted, bytes };
}
