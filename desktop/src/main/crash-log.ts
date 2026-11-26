/**
 * Crash logging for the desktop main process (M11 / v0.3.3).
 *
 * Pure, dependency-free helpers behind `main.ts`'s crash handlers:
 * - {@link crashLogPath} names a crash file `crash-<YYYYMMDD-HHmmss>.log`
 *   (local time, stable for tests because the clock is injectable).
 * - {@link formatCrash} renders a self-contained, human-readable entry.
 * - {@link pruneCrashLogs} keeps only the newest `keep` files that match
 *   `crash-*.log`, so the logs directory cannot grow without bound.
 *
 * Everything here is deliberately total: a missing directory, a permission
 * error or a Windows file lock must never throw out of a crash handler (we may
 * already be handling a fatal error). Callers therefore get `null`/`0` or an
 * `ok: false` result instead of exceptions.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

/** One crash record. `at` defaults to "now" when omitted. */
export interface CrashEntry {
  kind: string;
  message: string;
  stack?: string;
  at?: Date;
}

/** Filename prefix for crash logs (`crash-*.log`). */
export const CRASH_LOG_PREFIX = 'crash-';
/** Filename suffix for crash logs. */
export const CRASH_LOG_SUFFIX = '.log';
/** Number of crash files kept by {@link pruneCrashLogs}. */
export const DEFAULT_CRASH_LOG_KEEP = 20;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/** `YYYYMMDD-HHmmss` in local time (the filename stamp). */
export function crashStamp(at: Date): string {
  const d = isValidDate(at) ? at : new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** `YYYY-MM-DD HH:mm:ss` in local time (the human-readable stamp). */
export function crashTime(at: Date): string {
  const d = isValidDate(at) ? at : new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * Absolute path of the crash log for `at` (default: now).
 *
 * Format: `crash-<YYYYMMDD-HHmmss>.log` — e.g.
 * `crash-20261127-090507.log`. Local time, so log names line up with what a
 * user sees in Explorer.
 */
export function crashLogPath(dir: string, at: Date = new Date()): string {
  return path.join(dir, `${CRASH_LOG_PREFIX}${crashStamp(at)}${CRASH_LOG_SUFFIX}`);
}

/** Render one crash entry as plain text (always ends with a newline). */
export function formatCrash(entry: CrashEntry): string {
  const at = isValidDate(entry.at) ? entry.at : new Date();
  const kind =
    typeof entry.kind === 'string' && entry.kind.trim() !== '' ? entry.kind.trim() : 'unknown';
  const message =
    typeof entry.message === 'string' ? entry.message : String(entry.message ?? '');
  const lines = [
    '=== ServerMonitor 崩溃日志 ===',
    `时间: ${crashTime(at)}`,
    `ISO: ${at.toISOString()}`,
    `类型: ${kind}`,
    `消息: ${message}`,
  ];
  const stack = typeof entry.stack === 'string' ? entry.stack.trim() : '';
  if (stack) {
    lines.push('堆栈:');
    for (const line of stack.split(/\r?\n/)) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push('堆栈: （无）');
  }
  lines.push('');
  return lines.join('\n');
}

/** True for names owned by the crash logger (`crash-*.log`). */
export function isCrashLogName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.startsWith(CRASH_LOG_PREFIX) &&
    name.endsWith(CRASH_LOG_SUFFIX) &&
    name.length > CRASH_LOG_PREFIX.length + CRASH_LOG_SUFFIX.length
  );
}

interface LogFile {
  name: string;
  fullPath: string;
  mtimeMs: number;
}

function listFiles(dir: string): LogFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LogFile[] = [];
  for (const name of names) {
    if (!isCrashLogName(name)) {
      continue;
    }
    const fullPath = path.join(dir, name);
    try {
      const info = statSync(fullPath);
      if (!info.isFile()) {
        continue;
      }
      files.push({ name, fullPath, mtimeMs: info.mtimeMs });
    } catch {
      /* unreadable entry: ignore */
    }
  }
  // Newest first; the timestamped name breaks ties within the same millisecond
  // (and keeps pruning deterministic on filesystems with coarse mtime).
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return files;
}

/**
 * Keep only the newest `keep` crash logs in `dir`; delete the rest.
 *
 * Only `crash-*.log` files are considered — the directory also holds backend
 * and desktop logs. Non-positive `keep` deletes every crash log. A missing or
 * unreadable directory is not an error (returns 0). Per-file failures are
 * skipped. Returns the number of files actually removed.
 */
export function pruneCrashLogs(dir: string, keep = DEFAULT_CRASH_LOG_KEEP): number {
  const limit = Number.isFinite(keep) ? Math.max(0, Math.trunc(keep)) : DEFAULT_CRASH_LOG_KEEP;
  const files = listFiles(dir);
  let removed = 0;
  for (const file of files.slice(limit)) {
    try {
      unlinkSync(file.fullPath);
      removed += 1;
    } catch {
      /* locked/permission error: leave it for the next prune */
    }
  }
  return removed;
}

/** All crash logs in `dir`, newest first (absolute paths). */
export function listCrashLogs(dir: string): string[] {
  return listFiles(dir).map((file) => file.fullPath);
}

/** Newest crash log in `dir`, or `null` when there is none. */
export function latestCrashLog(dir: string): string | null {
  return listCrashLogs(dir)[0] ?? null;
}

function uniqueCrashPath(dir: string, at: Date): string {
  const base = crashLogPath(dir, at);
  if (!existsSync(base)) {
    return base;
  }
  // Two crashes in the same second: keep both by disambiguating with a suffix.
  for (let counter = 1; counter <= 100; counter += 1) {
    const candidate = base.replace(/\.log$/, `-${counter}.log`);
    if (!existsSync(candidate)) {
      return candidate;
    }
  }
  return base;
}

/**
 * Write a crash log into `dir` (creating it if needed) and return its path.
 *
 * Never throws: returns `null` when the entry could not be persisted. This is
 * the only helper that touches the disk, and it is safe to call from
 * `uncaughtException` / `unhandledRejection` listeners.
 */
export function writeCrashLog(dir: string, entry: CrashEntry): string | null {
  const at = isValidDate(entry.at) ? entry.at : new Date();
  const body = formatCrash({ ...entry, at });
  try {
    mkdirSync(dir, { recursive: true });
    const target = uniqueCrashPath(dir, at);
    writeFileSync(target, body, 'utf8');
    return target;
  } catch {
    return null;
  }
}