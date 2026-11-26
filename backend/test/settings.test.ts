import { describe, it, expect, afterEach } from 'vitest';

import {
  loadAppSettings,
  saveAppSettings,
  deleteAppSettings,
} from '../src/storage/settings';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

function payloadText(db: TestDb, section: string): string {
  const row = db
    .prepare('SELECT payload FROM app_settings WHERE section = ?')
    .get(section) as { payload: string } | undefined;
  return row?.payload ?? '';
}

function updatedAt(db: TestDb, section: string): string {
  const row = db
    .prepare('SELECT updated_at FROM app_settings WHERE section = ?')
    .get(section) as { updated_at: string } | undefined;
  return row?.updated_at ?? '';
}

describe('app_settings storage', () => {
  it('returns an empty map when nothing has been saved', () => {
    const { db } = freshDb();
    expect(loadAppSettings(db)).toEqual({});
  });

  it('round-trips a payload through save + load', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'general', { refresh_interval: 30, alerts: true, name: '生产' });

    expect(loadAppSettings(db)).toEqual({
      general: { refresh_interval: 30, alerts: true, name: '生产' },
    });
  });

  it('encodes payload JSON exactly like Python json.dumps(ensure_ascii=False)', () => {
    const { db } = freshDb();
    saveAppSettings(db, 's', {
      a: 1,
      b: [1, 2, 3],
      c: true,
      d: null,
      s: 'x y',
      u: '中文',
    });

    // Python: json.dumps({...}, ensure_ascii=False) -> spaces after , and :,
    // raw non-ASCII, compact arrays reproduced with ", " separators.
    expect(payloadText(db, 's')).toBe(
      '{"a": 1, "b": [1, 2, 3], "c": true, "d": null, "s": "x y", "u": "中文"}',
    );
  });

  it('serialises floats and integers with Python formatting', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'n', { f: 0.85, tiny: 1e-7 });

    expect(payloadText(db, 'n')).toBe('{"f": 0.85, "tiny": 1e-07}');
  });

  it('stamps updated_at with a strict six-digit UTC ISO timestamp', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'general', { a: 1 });

    expect(updatedAt(db, 'general')).toMatch(STRICT_ISO);
  });

  it('replaces the payload when the same section is saved twice', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'general', { a: 1, b: 2 });
    saveAppSettings(db, 'general', { a: 9 });

    expect(loadAppSettings(db)).toEqual({ general: { a: 9 } });
    const count = db.prepare('SELECT COUNT(*) AS n FROM app_settings').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps multiple sections independent', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'a', { x: 1 });
    saveAppSettings(db, 'b', { y: 2 });

    expect(loadAppSettings(db)).toEqual({ a: { x: 1 }, b: { y: 2 } });
  });

  it('deletes a section and is a no-op for a missing section', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'a', { x: 1 });
    saveAppSettings(db, 'b', { y: 2 });

    deleteAppSettings(db, 'a');
    expect(loadAppSettings(db)).toEqual({ b: { y: 2 } });

    expect(() => deleteAppSettings(db, 'does-not-exist')).not.toThrow();
    expect(loadAppSettings(db)).toEqual({ b: { y: 2 } });
  });
});
