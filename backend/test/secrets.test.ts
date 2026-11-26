import { describe, it, expect, afterEach } from 'vitest';

import {
  getSecret,
  setSecret,
  listSecretNames,
  deleteSecret,
} from '../src/storage/secrets';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

function updatedAt(db: TestDb, name: string): string {
  const row = db
    .prepare('SELECT updated_at FROM app_secrets WHERE name = ?')
    .get(name) as { updated_at: string } | undefined;
  return row?.updated_at ?? '';
}

describe('app_secrets storage', () => {
  it('returns null / empty when nothing has been stored', () => {
    const { db } = freshDb();
    expect(getSecret(db, 'missing')).toBeNull();
    expect(listSecretNames(db)).toEqual([]);
  });

  it('round-trips ciphertext bytes verbatim', () => {
    const { db } = freshDb();
    const ciphertext = Buffer.from([0x00, 0xff, 0x10, 0x20, 0x00, 0x7f]);
    setSecret(db, 'admin-token', ciphertext);

    const stored = getSecret(db, 'admin-token');
    expect(stored).not.toBeNull();
    expect(Buffer.isBuffer(stored)).toBe(true);
    expect(Buffer.compare(stored as Buffer, ciphertext)).toBe(0);
  });

  it('stores arbitrary binary including NUL and high bytes', () => {
    const { db } = freshDb();
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    setSecret(db, 'blob', bytes);
    expect(Buffer.compare(getSecret(db, 'blob') as Buffer, bytes)).toBe(0);
  });

  it('lists stored names in alphabetical order', () => {
    const { db } = freshDb();
    setSecret(db, 'zeta', Buffer.from('z'));
    setSecret(db, 'alpha', Buffer.from('a'));
    setSecret(db, 'mike', Buffer.from('m'));

    expect(listSecretNames(db)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('replaces the ciphertext when the same name is set twice', () => {
    const { db } = freshDb();
    setSecret(db, 'token', Buffer.from('first'));
    setSecret(db, 'token', Buffer.from('second'));

    expect((getSecret(db, 'token') as Buffer).toString()).toBe('second');
    const count = db.prepare('SELECT COUNT(*) AS n FROM app_secrets').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('stamps updated_at with a strict six-digit UTC ISO timestamp', () => {
    const { db } = freshDb();
    setSecret(db, 'k', Buffer.from('v'));
    expect(updatedAt(db, 'k')).toMatch(STRICT_ISO);
  });

  it('deletes a secret and is a no-op for a missing name', () => {
    const { db } = freshDb();
    setSecret(db, 'a', Buffer.from('1'));
    setSecret(db, 'b', Buffer.from('2'));

    deleteSecret(db, 'a');
    expect(listSecretNames(db)).toEqual(['b']);
    expect(getSecret(db, 'a')).toBeNull();

    expect(() => deleteSecret(db, 'missing')).not.toThrow();
  });
});
