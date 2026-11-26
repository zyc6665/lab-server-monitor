import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../src/storage/db';

let dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-db-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

describe('openDatabase', () => {
  it('applies busy_timeout=10000 and synchronous=NORMAL', () => {
    const dbPath = path.join(tempDir(), 'monitor.db');
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('busy_timeout', { simple: true })).toBe(10000);
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // 1 = NORMAL
    } finally {
      db.close();
    }
  });

  it('sets journal_mode=WAL and auto_vacuum=INCREMENTAL on a brand-new file', () => {
    const dbPath = path.join(tempDir(), 'monitor.db');
    const db = openDatabase(dbPath);
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('auto_vacuum', { simple: true })).toBe(2); // 2 = INCREMENTAL
    } finally {
      db.close();
    }
  });

  it('creates a usable database that can be written and read', () => {
    const dbPath = path.join(tempDir(), 'monitor.db');
    const db = openDatabase(dbPath);
    try {
      db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
      expect(db.prepare('SELECT v FROM t WHERE id = 1').get()).toEqual({ v: 'hello' });
    } finally {
      db.close();
    }
    expect(existsSync(dbPath)).toBe(true);
  });

  it('leaves no -wal / -shm lock files behind after close', () => {
    const dbPath = path.join(tempDir(), 'monitor.db');
    const db = openDatabase(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    db.prepare('INSERT INTO t DEFAULT VALUES').run();
    expect(existsSync(dbPath + '-wal')).toBe(true); // WAL active while open
    db.close();
    expect(existsSync(dbPath + '-wal')).toBe(false);
    expect(existsSync(dbPath + '-shm')).toBe(false);
  });

  it('opens an existing database read-only without mutating it', () => {
    const dbPath = path.join(tempDir(), 'monitor.db');
    const writer = openDatabase(dbPath);
    writer.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    writer.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    writer.close();

    const reader = openDatabase(dbPath, { readonly: true });
    try {
      expect(reader.pragma('busy_timeout', { simple: true })).toBe(10000);
      expect(reader.prepare('SELECT v FROM t WHERE id = 1').get()).toEqual({ v: 'x' });
      expect(() => reader.exec('CREATE TABLE t2 (id INTEGER)')).toThrow();
    } finally {
      reader.close();
    }
  });
});
