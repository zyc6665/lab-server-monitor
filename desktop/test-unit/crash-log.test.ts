import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_CRASH_LOG_KEEP,
  crashLogPath,
  crashStamp,
  crashTime,
  formatCrash,
  isCrashLogName,
  latestCrashLog,
  listCrashLogs,
  pruneCrashLogs,
  writeCrashLog,
} from '../src/main/crash-log';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sm-crash-log-'));
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

/** Create `crash-<stamp>.log` files with explicit, increasing mtimes. */
function seedCrashLogs(count: number, options: { prefixSeconds?: number } = {}): string[] {
  const names: string[] = [];
  const baseSeconds = options.prefixSeconds ?? 1_800_000_000;
  for (let index = 0; index < count; index += 1) {
    const at = new Date(2026, 10, 27, 9, 0, 0);
    at.setSeconds(at.getSeconds() + index);
    const full = crashLogPath(dir, at);
    writeFileSync(full, `entry ${index}\n`, 'utf8');
    utimesSync(full, baseSeconds + index, baseSeconds + index);
    names.push(path.basename(full));
  }
  return names;
}

describe('crashLogPath', () => {
  it('builds crash-<YYYYMMDD-HHmmss>.log in local time', () => {
    const at = new Date(2026, 10, 27, 9, 5, 7);
    expect(crashLogPath(dir, at)).toBe(path.join(dir, 'crash-20261127-090507.log'));
  });

  it('zero-pads every field', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5);
    expect(crashLogPath(dir, at)).toBe(path.join(dir, 'crash-20260102-030405.log'));
  });

  it('defaults to now and always matches the crash-*.log pattern', () => {
    const file = crashLogPath(dir);
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^crash-\d{8}-\d{6}\.log$/);
  });

  it('exposes the same stamps used for formatting', () => {
    const at = new Date(2026, 10, 27, 9, 5, 7);
    expect(crashStamp(at)).toBe('20261127-090507');
    expect(crashTime(at)).toBe('2026-11-27 09:05:07');
  });
});

describe('formatCrash', () => {
  it('renders a self-contained entry with a local timestamp', () => {
    const text = formatCrash({
      kind: 'uncaughtException',
      message: 'boom',
      stack: 'Error: boom\n    at main (/app/main.ts:1:1)',
      at: new Date(2026, 10, 27, 9, 5, 7),
    });

    expect(text).toContain('=== ServerMonitor 崩溃日志 ===');
    expect(text).toContain('时间: 2026-11-27 09:05:07');
    expect(text).toContain('类型: uncaughtException');
    expect(text).toContain('消息: boom');
    expect(text).toContain('堆栈:');
    expect(text).toContain('  Error: boom');
    expect(text).toContain('      at main (/app/main.ts:1:1)');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('records the ISO instant for cross-timezone correlation', () => {
    const at = new Date(Date.UTC(2026, 10, 27, 1, 5, 7));
    const text = formatCrash({ kind: 'unhandledRejection', message: 'nope', at });
    expect(text).toContain(`ISO: ${at.toISOString()}`);
  });

  it('marks a missing stack as （无）', () => {
    const text = formatCrash({
      kind: 'render-process-gone',
      message: 'reason=crashed exitCode=1',
      at: new Date(2026, 10, 27, 9, 5, 7),
    });
    expect(text).toContain('堆栈: （无）');
  });

  it('is total: blank kind and invalid date still render', () => {
    const text = formatCrash({ kind: '', message: 'x', at: new Date(Number.NaN) });
    expect(text).toContain('类型: unknown');
    expect(text).toContain('消息: x');
  });
});

describe('isCrashLogName', () => {
  it('accepts only crash-*.log names', () => {
    expect(isCrashLogName('crash-20261127-090507.log')).toBe(true);
    expect(isCrashLogName('crash-20261127-090507-1.log')).toBe(true);
    expect(isCrashLogName('backend.log')).toBe(false);
    expect(isCrashLogName('crash-20261127-090507.txt')).toBe(false);
    expect(isCrashLogName('crash-.log')).toBe(false);
  });
});

describe('pruneCrashLogs', () => {
  it('keeps the newest 20 crash logs and deletes the rest', () => {
    const names = seedCrashLogs(25);

    expect(pruneCrashLogs(dir)).toBe(5);

    const remaining = readdirSync(dir).sort();
    expect(remaining).toHaveLength(DEFAULT_CRASH_LOG_KEEP);
    expect(remaining).toEqual(names.slice(5).sort());
  });

  it('honours an explicit keep limit', () => {
    seedCrashLogs(5);
    expect(pruneCrashLogs(dir, 2)).toBe(3);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('never touches non-crash files', () => {
    seedCrashLogs(3);
    writeFileSync(path.join(dir, 'backend.log'), 'backend\n', 'utf8');
    writeFileSync(path.join(dir, 'crash-notes.txt'), 'notes\n', 'utf8');
    mkdirSync(path.join(dir, 'crash-dir.log'));

    expect(pruneCrashLogs(dir, 1)).toBe(2);

    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(
      [
        'backend.log',
        'crash-20261127-090002.log',
        'crash-dir.log',
        'crash-notes.txt',
      ].sort(),
    );
  });

  it('is tolerant of a missing directory', () => {
    expect(pruneCrashLogs(path.join(dir, 'missing'))).toBe(0);
  });

  it('deletes everything when keep is 0', () => {
    seedCrashLogs(4);
    expect(pruneCrashLogs(dir, 0)).toBe(4);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it('does nothing when there are fewer files than keep', () => {
    seedCrashLogs(3);
    expect(pruneCrashLogs(dir, 20)).toBe(0);
    expect(readdirSync(dir)).toHaveLength(3);
  });
});

describe('writeCrashLog / latestCrashLog', () => {
  it('creates the directory and returns the written path', () => {
    const nested = path.join(dir, 'a', 'b');
    const at = new Date(2026, 10, 27, 9, 5, 7);

    const written = writeCrashLog(nested, { kind: 'uncaughtException', message: 'boom', at });

    expect(written).toBe(path.join(nested, 'crash-20261127-090507.log'));
    expect(readFileSync(written as string, 'utf8')).toContain('消息: boom');
  });

  it('never collides when two crashes land in the same second', () => {
    const at = new Date(2026, 10, 27, 9, 5, 7);
    const first = writeCrashLog(dir, { kind: 'uncaughtException', message: 'one', at });
    const second = writeCrashLog(dir, { kind: 'uncaughtException', message: 'two', at });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
    expect(readFileSync(second as string, 'utf8')).toContain('消息: two');
  });

  it('returns null instead of throwing when the path cannot be written', () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');

    expect(writeCrashLog(blocker, { kind: 'uncaughtException', message: 'boom' })).toBeNull();
  });

  it('reports the newest crash log by mtime', () => {
    const names = seedCrashLogs(3);
    const latest = latestCrashLog(dir);
    expect(latest).toBe(path.join(dir, names[names.length - 1]));
    const listed = listCrashLogs(dir);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toBe(latest);
    expect(listed).toEqual(names.slice().reverse().map((name) => path.join(dir, name)));
  });

  it('returns null when there is no crash log', () => {
    expect(latestCrashLog(dir)).toBeNull();
    expect(latestCrashLog(path.join(dir, 'missing'))).toBeNull();
  });
});