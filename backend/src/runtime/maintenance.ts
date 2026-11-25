/**
 * Maintenance helpers — TypeScript port of `servermanage/maintenance.py`.
 *
 * Pure filesystem logic (no database handle required): directory sizing,
 * storage-usage snapshot, stale update-package cleanup, Electron renderer cache
 * cleanup, and the log-pruning wrapper that protects the live log files. All
 * time arithmetic goes through an injectable clock so tests never depend on the
 * wall clock.
 *
 * The four cleanup routines deliberately refuse to follow symlinks. The Python
 * oracle only differs for *file* symlinks (its `Path.is_file()` / `rglob`
 * follow the link and tally the target size); everything else — retention-hour
 * maths, recursive traversal order, error tolerance, and the `{deleted, bytes}`
 * result shape — is mirrored one-for-one. See {@link log-cleanup} for the full
 * rationale.
 */
import { lstatSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { pruneLogFiles, type CleanupResult } from './log-cleanup';

export type { CleanupResult };

const HOUR_MS = 60 * 60 * 1000;

/**
 * Electron renderer cache directory names removed by
 * {@link cleanupElectronCache} — copied verbatim from `maintenance.CACHE_DIRS`.
 */
export const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
] as const;

/**
 * Log files that a running backend / desktop process may still hold open and
 * that {@link cleanupLogs} must never delete.
 */
export const DEFAULT_PROTECTED_LOG_NAMES = ['servermonitor.log', 'desktop.log'] as const;

/** Byte sizes of the four storage areas plus the whole app directory. */
export interface StorageUsage {
  database: number;
  logs: number;
  updates: number;
  electron: number;
  total: number;
}

/**
 * Size in bytes of a file, or the recursive sum of a directory's regular files.
 *
 * Port of `maintenance.directory_size`:
 *
 * - missing / unreadable paths return `0` (an `OSError` is swallowed);
 * - a plain file returns its `st_size`;
 * - a directory is walked recursively; individual entries that cannot be
 *   stat-ed are skipped;
 * - directory symlinks are listed but never descended into,
 *   mirroring `os.walk(followlinks=False)` (this also prevents cycles).
 */
export function directorySize(target: string): number {
  let root;
  try {
    root = statSync(target);
  } catch {
    return 0;
  }
  if (root.isFile()) {
    return root.size;
  }
  if (!root.isDirectory()) {
    return 0;
  }

  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // `os.walk(followlinks=False)` lists a symlink-to-file among the files
        // and stats it (following to the target size), but never recurses into
        // a symlinked directory. Replicate exactly.
        try {
          const linkTarget = statSync(child);
          if (linkTarget.isFile()) {
            total += linkTarget.size;
          }
        } catch {
          // Broken / inaccessible link — ignore.
        }
        continue;
      }
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (entry.isFile()) {
        try {
          total += statSync(child).size;
        } catch {
          // Entry vanished mid-walk — ignore.
        }
      }
    }
  };
  walk(target);
  return total;
}

/**
 * Disk-usage snapshot — port of `maintenance.storage_usage`.
 *
 * `app_dir` is the grandparent of the database file, so the layout is
 * `{app_dir}/logs`, `{app_dir}/data/updates`, `{app_dir}/data/electron`, and
 * `total` measures the whole app directory.
 */
export function storageUsage(dbPath: string): StorageUsage {
  const appDir = dirname(dirname(dbPath));
  return {
    database: directorySize(dbPath),
    logs: directorySize(join(appDir, 'logs')),
    updates: directorySize(join(appDir, 'data', 'updates')),
    electron: directorySize(join(appDir, 'data', 'electron')),
    total: directorySize(appDir),
  };
}

/**
 * Delete expired log files, protecting the fixed live log names.
 *
 * Port of `maintenance.cleanup_logs`: a thin wrapper over
 * {@link pruneLogFiles} with `protectedNames = ('servermonitor.log',
 * 'desktop.log')` and a 24-hour default retention.
 */
export function cleanupLogs(
  logDir: string,
  retentionHours = 24,
  now: Date | null = null,
  protectedNames: Iterable<string> = DEFAULT_PROTECTED_LOG_NAMES,
): CleanupResult {
  return pruneLogFiles(logDir, retentionHours, now, protectedNames);
}

/**
 * Delete stale update packages (`*.zip`) under `updatesDir`.
 *
 * Port of `maintenance.cleanup_updates`:
 *
 * - a missing / non-directory root is a no-op;
 * - `*.zip` files are matched recursively (nested directories included);
 * - when `retentionHours > 0`, a package whose mtime is `>=` the cutoff is kept
 *   (inclusive boundary); when `retentionHours <= 0`, *every* package is
 *   removed regardless of age (this is what the `/api/system/maintenance`
 *   route asks for with `retention_hours=0`);
 * - stat / unlink failures skip that entry.
 */
export function cleanupUpdates(
  updatesDir: string,
  retentionHours = 24,
  now: Date | null = null,
): CleanupResult {
  try {
    if (!statSync(updatesDir).isDirectory()) {
      return { deleted: 0, bytes: 0 };
    }
  } catch {
    return { deleted: 0, bytes: 0 };
  }

  const cutoff = (now ?? new Date()).getTime() - retentionHours * HOUR_MS;
  let deleted = 0;
  let bytes = 0;

  const visit = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Never follow symlinks (or the junction points Windows exposes as them).
      if (entry.isSymbolicLink()) {
        continue;
      }
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.zip')) {
        continue;
      }
      let stats;
      try {
        stats = lstatSync(child);
      } catch {
        continue;
      }
      if (retentionHours > 0 && stats.mtimeMs >= cutoff) {
        continue;
      }
      try {
        rmSync(child, { force: true });
      } catch {
        continue;
      }
      deleted += 1;
      bytes += stats.size;
    }
  };

  visit(updatesDir);
  return { deleted, bytes };
}

/**
 * Remove the known Electron renderer cache directories under `userDataDir`.
 *
 * Port of `maintenance.cleanup_electron_cache`: only {@link CACHE_DIRS} are
 * considered, missing targets are skipped, and a directory that cannot be
 * removed (e.g. held open by a running renderer) is left untouched. Symlinked
 * or non-directory targets are skipped — Python's `shutil.rmtree` refuses a
 * symbolic link, producing the same "not removed" outcome.
 */
export function cleanupElectronCache(
  userDataDir: string,
  cacheDirs: readonly string[] = CACHE_DIRS,
): CleanupResult {
  let deleted = 0;
  let bytes = 0;
  for (const name of cacheDirs) {
    const target = join(userDataDir, name);
    let stats;
    try {
      stats = lstatSync(target);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      continue;
    }
    const size = directorySize(target);
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      continue;
    }
    deleted += 1;
    bytes += size;
  }
  return { deleted, bytes };
}
