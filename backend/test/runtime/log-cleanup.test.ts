import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { pruneLogFiles } from '../../src/runtime/log-cleanup';

const baseDirs: string[] = [];
const NOW = new Date('2026-11-09T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function makeDir(prefix = 'sm-logcleanup-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  baseDirs.push(dir);
  return dir;
}

/** Write a file (creating parents) and stamp its mtime/atime to `when`. */
function touch(filePath: string, when: Date, content = 'x'): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  utimesSync(filePath, when, when);
}

/** Create a directory junction/symlink; returns false when the OS refuses. */
function tryJunction(linkPath: string, targetPath: string): boolean {
  try {
    symlinkSync(targetPath, linkPath, 'junction');
    return true;
  } catch {
    return false;
  }
}

afterAll(() => {
  for (const dir of baseDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('runtime/log-cleanup pruneLogFiles', () => {
  it('removes only expired files and tallies the freed bytes', () => {
    const dir = makeDir();
    const old = join(dir, 'servermonitor.log.1');
    const recent = join(dir, 'desktop.log');
    const active = join(dir, 'servermonitor.log');
    touch(old, new Date(NOW.getTime() - 30 * HOUR_MS), 'x'.repeat(10));
    touch(recent, new Date(NOW.getTime() - 2 * HOUR_MS), 'x'.repeat(20));
    touch(active, new Date(NOW.getTime() - 40 * HOUR_MS), 'x'.repeat(30));

    const result = pruneLogFiles(dir, 24, NOW, ['servermonitor.log']);

    expect(result).toEqual({ deleted: 1, bytes: 10 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(active)).toBe(true);
  });

  it('ignores a missing directory', () => {
    const dir = makeDir();
    expect(pruneLogFiles(join(dir, 'missing'), 24, NOW)).toEqual({ deleted: 0, bytes: 0 });
  });

  it('ignores a path that is a regular file', () => {
    const dir = makeDir();
    const file = join(dir, 'not-a-dir');
    touch(file, NOW);
    expect(pruneLogFiles(file, 24, NOW)).toEqual({ deleted: 0, bytes: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it('returns a zero result for an empty directory', () => {
    const dir = makeDir();
    expect(pruneLogFiles(dir, 24, NOW)).toEqual({ deleted: 0, bytes: 0 });
  });

  it('matches *.log and rotated *.log.* names but no other extensions', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 48 * HOUR_MS);
    touch(join(dir, 'a.log'), when);
    touch(join(dir, 'b.log.1'), when);
    touch(join(dir, 'c.log.2026-11-01'), when);
    touch(join(dir, 'd.txt'), when);
    touch(join(dir, 'catalog'), when);
    touch(join(dir, 'e.logx'), when);

    const result = pruneLogFiles(dir, 24, NOW);

    expect(result.deleted).toBe(3);
    expect(existsSync(join(dir, 'a.log'))).toBe(false);
    expect(existsSync(join(dir, 'b.log.1'))).toBe(false);
    expect(existsSync(join(dir, 'c.log.2026-11-01'))).toBe(false);
    expect(existsSync(join(dir, 'd.txt'))).toBe(true);
    expect(existsSync(join(dir, 'catalog'))).toBe(true);
    expect(existsSync(join(dir, 'e.logx'))).toBe(true);
  });

  it('protects only the exact protected names', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 48 * HOUR_MS);
    touch(join(dir, 'servermonitor.log'), when, 'keep');
    touch(join(dir, 'servermonitor.log.1'), when, 'go');

    const result = pruneLogFiles(dir, 24, NOW, ['servermonitor.log']);

    expect(result).toEqual({ deleted: 1, bytes: 2 });
    expect(existsSync(join(dir, 'servermonitor.log'))).toBe(true);
    expect(existsSync(join(dir, 'servermonitor.log.1'))).toBe(false);
  });

  it('keeps files whose mtime equals the cutoff and deletes older ones', () => {
    const dir = makeDir();
    const cutoff = new Date(NOW.getTime() - 24 * HOUR_MS);
    touch(join(dir, 'exact.log'), cutoff);
    touch(join(dir, 'older.log'), new Date(cutoff.getTime() - 60_000));
    touch(join(dir, 'newer.log'), new Date(cutoff.getTime() + 60_000));

    const result = pruneLogFiles(dir, 24, NOW);

    expect(result.deleted).toBe(1);
    expect(existsSync(join(dir, 'exact.log'))).toBe(true);
    expect(existsSync(join(dir, 'older.log'))).toBe(false);
    expect(existsSync(join(dir, 'newer.log'))).toBe(true);
  });

  it('deletes every expired log when retention is zero', () => {
    const dir = makeDir();
    touch(join(dir, 'a.log'), new Date(NOW.getTime() - 60_000));
    touch(join(dir, 'b.log'), new Date(NOW.getTime() - 120_000));
    touch(join(dir, 'future.log'), new Date(NOW.getTime() + HOUR_MS));

    const result = pruneLogFiles(dir, 0, NOW);

    expect(result.deleted).toBe(2);
    expect(existsSync(join(dir, 'a.log'))).toBe(false);
    expect(existsSync(join(dir, 'b.log'))).toBe(false);
    expect(existsSync(join(dir, 'future.log'))).toBe(true);
  });

  it('does not recurse into subdirectories', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 48 * HOUR_MS);
    touch(join(dir, 'top.log'), when);
    touch(join(dir, 'nested', 'deep.log'), when);

    const result = pruneLogFiles(dir, 24, NOW);

    expect(result.deleted).toBe(1);
    expect(existsSync(join(dir, 'top.log'))).toBe(false);
    expect(existsSync(join(dir, 'nested', 'deep.log'))).toBe(true);
  });

  it('skips a directory symlink without deleting through it', () => {
    const dir = makeDir();
    const outside = makeDir('sm-logcleanup-outside-');
    const deep = join(outside, 'deep.log');
    touch(deep, new Date(NOW.getTime() - 48 * HOUR_MS));
    const link = join(dir, 'linked.log');
    if (!tryJunction(link, outside)) {
      return; // OS cannot create junctions/symlinks in this environment.
    }

    const result = pruneLogFiles(dir, 24, NOW);

    expect(result).toEqual({ deleted: 0, bytes: 0 });
    expect(existsSync(deep)).toBe(true);
  });

  it('sums the sizes of all deleted files', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 48 * HOUR_MS);
    touch(join(dir, 'one.log'), when, 'x'.repeat(7));
    touch(join(dir, 'two.log'), when, 'x'.repeat(13));

    const result = pruneLogFiles(dir, 24, NOW);

    expect(result).toEqual({ deleted: 2, bytes: 20 });
  });
});
