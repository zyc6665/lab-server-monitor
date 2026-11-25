import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  cleanupElectronCache,
  cleanupLogs,
  cleanupUpdates,
  directorySize,
  storageUsage,
} from '../../src/runtime/maintenance';

const baseDirs: string[] = [];
const NOW = new Date('2026-11-09T10:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

function makeDir(prefix = 'sm-maint-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  baseDirs.push(dir);
  return dir;
}

/** Write a file (creating parents), pad it to `size` bytes, stamp its mtime. */
function touch(filePath: string, when: Date, size = 1): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, 'x'.repeat(size));
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

describe('runtime/maintenance directorySize', () => {
  it('returns 0 for a missing path', () => {
    const dir = makeDir();
    expect(directorySize(join(dir, 'nope'))).toBe(0);
  });

  it('returns the size of a regular file', () => {
    const dir = makeDir();
    const file = join(dir, 'blob.bin');
    touch(file, NOW, 42);
    expect(directorySize(file)).toBe(42);
  });

  it('returns 0 for an empty directory', () => {
    const dir = makeDir();
    expect(directorySize(dir)).toBe(0);
  });

  it('sums files across nested directories', () => {
    const dir = makeDir();
    touch(join(dir, 'a.bin'), NOW, 10);
    touch(join(dir, 'sub', 'b.bin'), NOW, 20);
    touch(join(dir, 'sub', 'deeper', 'c.bin'), NOW, 30);
    expect(directorySize(dir)).toBe(60);
  });

  it('does not traverse a directory symlink', () => {
    const dir = makeDir();
    touch(join(dir, 'own.bin'), NOW, 5);
    const outside = makeDir('sm-maint-outside-');
    touch(join(outside, 'hidden.bin'), NOW, 100);
    const link = join(dir, 'linked-dir');
    if (!tryJunction(link, outside)) {
      return;
    }
    expect(directorySize(dir)).toBe(5);
  });
});

describe('runtime/maintenance storageUsage', () => {
  it('reports the four app areas and the whole-app total', () => {
    const root = makeDir();
    const appDir = join(root, 'app');
    const dataDir = join(appDir, 'data');
    mkdirSync(join(dataDir, 'updates'), { recursive: true });
    mkdirSync(join(dataDir, 'electron'), { recursive: true });
    mkdirSync(join(appDir, 'logs'), { recursive: true });
    const db = join(dataDir, 'servermonitor.db');
    touch(db, NOW, 12);
    touch(join(dataDir, 'updates', 'x.zip'), NOW, 20);
    touch(join(dataDir, 'electron', 'CacheFile'), NOW, 30);
    touch(join(appDir, 'logs', 'x.log'), NOW, 40);

    expect(storageUsage(db)).toEqual({
      database: 12,
      logs: 40,
      updates: 20,
      electron: 30,
      total: 102,
    });
  });
});

describe('runtime/maintenance cleanupUpdates', () => {
  it('removes only expired zips and tallies the freed bytes', () => {
    const dir = makeDir();
    const old = join(dir, 'download', 'old.zip');
    const recent = join(dir, 'download', 'recent.zip');
    touch(old, new Date(NOW.getTime() - 30 * HOUR_MS), 100);
    touch(recent, new Date(NOW.getTime() - 1 * HOUR_MS), 50);

    const result = cleanupUpdates(dir, 24, NOW);

    expect(result).toEqual({ deleted: 1, bytes: 100 });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('removes every zip when retention is zero', () => {
    const dir = makeDir();
    touch(join(dir, 'a.zip'), NOW, 10);
    touch(join(dir, 'b.zip'), NOW, 20);

    expect(cleanupUpdates(dir, 0, NOW)).toEqual({ deleted: 2, bytes: 30 });
  });

  it('is a no-op for a missing directory', () => {
    const dir = makeDir();
    expect(cleanupUpdates(join(dir, 'missing'), 24, NOW)).toEqual({ deleted: 0, bytes: 0 });
  });

  it('is a no-op when the path is a regular file', () => {
    const dir = makeDir();
    const file = join(dir, 'not-a-dir');
    touch(file, NOW, 3);
    expect(cleanupUpdates(file, 24, NOW)).toEqual({ deleted: 0, bytes: 0 });
  });

  it('walks nested directories and ignores non-zip files', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 48 * HOUR_MS);
    touch(join(dir, 'nested', 'a.zip'), when, 7);
    touch(join(dir, 'nested', 'b.txt'), when, 11);
    touch(join(dir, 'c.zip'), when, 3);

    const result = cleanupUpdates(dir, 24, NOW);

    expect(result).toEqual({ deleted: 2, bytes: 10 });
    expect(existsSync(join(dir, 'nested', 'b.txt'))).toBe(true);
  });

  it('keeps a zip whose mtime equals the cutoff', () => {
    const dir = makeDir();
    const cutoff = new Date(NOW.getTime() - 24 * HOUR_MS);
    touch(join(dir, 'exact.zip'), cutoff, 5);
    touch(join(dir, 'older.zip'), new Date(cutoff.getTime() - 60_000), 6);

    const result = cleanupUpdates(dir, 24, NOW);

    expect(result).toEqual({ deleted: 1, bytes: 6 });
    expect(existsSync(join(dir, 'exact.zip'))).toBe(true);
    expect(existsSync(join(dir, 'older.zip'))).toBe(false);
  });

  it('skips zips behind a directory symlink', () => {
    const dir = makeDir();
    const outside = makeDir('sm-maint-outside-');
    const evil = join(outside, 'evil.zip');
    touch(evil, new Date(NOW.getTime() - 48 * HOUR_MS), 9);
    const link = join(dir, 'linked-updates');
    if (!tryJunction(link, outside)) {
      return;
    }

    const result = cleanupUpdates(dir, 24, NOW);

    expect(result).toEqual({ deleted: 0, bytes: 0 });
    expect(existsSync(evil)).toBe(true);
  });
});

describe('runtime/maintenance cleanupElectronCache', () => {
  it('removes known cache directories only', () => {
    const dir = makeDir();
    const cache = join(dir, 'Cache');
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, 'data'), 'x'.repeat(40));
    mkdirSync(join(dir, 'Local Storage'));
    writeFileSync(join(dir, 'Local Storage', 'state'), 'keep');

    const result = cleanupElectronCache(dir, ['Cache']);

    expect(result).toEqual({ deleted: 1, bytes: 40 });
    expect(existsSync(cache)).toBe(false);
    expect(statSync(join(dir, 'Local Storage', 'state')).size).toBe(4);
  });

  it('is a no-op when no cache directories exist', () => {
    const dir = makeDir();
    expect(cleanupElectronCache(dir)).toEqual({ deleted: 0, bytes: 0 });
  });

  it('leaves a plain file that merely shares a cache directory name', () => {
    const dir = makeDir();
    const fake = join(dir, 'Cache');
    writeFileSync(fake, 'x'.repeat(5));
    expect(cleanupElectronCache(dir, ['Cache'])).toEqual({ deleted: 0, bytes: 0 });
    expect(existsSync(fake)).toBe(true);
  });

  it('skips a symlinked cache directory', () => {
    const dir = makeDir();
    const outside = makeDir('sm-maint-outside-');
    touch(join(outside, 'payload.bin'), NOW, 50);
    const link = join(dir, 'Cache');
    if (!tryJunction(link, outside)) {
      return;
    }

    expect(cleanupElectronCache(dir, ['Cache'])).toEqual({ deleted: 0, bytes: 0 });
    expect(existsSync(join(outside, 'payload.bin'))).toBe(true);
  });

  it('removes multiple cache directories and sums their sizes', () => {
    const dir = makeDir();
    for (const [name, size] of [['Cache', 10], ['GPUCache', 20]] as const) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'f'), 'x'.repeat(size));
    }
    expect(cleanupElectronCache(dir)).toEqual({ deleted: 2, bytes: 30 });
  });
});

describe('runtime/maintenance cleanupLogs', () => {
  it('protects the live log files inside the 24h window', () => {
    const dir = makeDir();
    const when = new Date(NOW.getTime() - 40 * HOUR_MS);
    touch(join(dir, 'servermonitor.log'), when, 30);
    touch(join(dir, 'desktop.log'), when, 20);
    touch(join(dir, 'servermonitor.log.1'), when, 10);
    touch(join(dir, 'recent.log'), new Date(NOW.getTime() - HOUR_MS), 5);

    const result = cleanupLogs(dir, 24, NOW);

    expect(result).toEqual({ deleted: 1, bytes: 10 });
    expect(existsSync(join(dir, 'servermonitor.log'))).toBe(true);
    expect(existsSync(join(dir, 'desktop.log'))).toBe(true);
    expect(existsSync(join(dir, 'servermonitor.log.1'))).toBe(false);
    expect(existsSync(join(dir, 'recent.log'))).toBe(true);
  });

  it('honours a caller-supplied retention window', () => {
    const dir = makeDir();
    touch(join(dir, 'two-hours.log'), new Date(NOW.getTime() - 2 * HOUR_MS));
    touch(join(dir, 'five-hours.log'), new Date(NOW.getTime() - 5 * HOUR_MS));

    const result = cleanupLogs(dir, 3, NOW);

    expect(result.deleted).toBe(1);
    expect(existsSync(join(dir, 'two-hours.log'))).toBe(true);
    expect(existsSync(join(dir, 'five-hours.log'))).toBe(false);
  });
});
