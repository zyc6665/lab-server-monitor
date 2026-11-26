/** Unit tests for the `config_history` accessors (P2-3). */
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';
import {
  listConfigHistory,
  pruneConfigHistory,
  recordConfigHistory,
} from '../../src/storage/config-history';

let fresh: FreshDb;

afterEach(() => {
  cleanupStorageTests();
});

describe('config_history storage', () => {
  it('records only key names, de-duplicated and sorted', () => {
    fresh = freshDb();
    recordConfigHistory(fresh.db, { section: 'monitoring', changedKeys: ['b', 'a', 'a'], changedBy: 'admin' });
    const rows = listConfigHistory(fresh.db, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.section).toBe('monitoring');
    expect(rows[0]!.changed_keys).toEqual(['a', 'b']);
    expect(rows[0]!.changed_by).toBe('admin');
  });

  it('ignores empty change sets and returns newest first', () => {
    fresh = freshDb();
    expect(recordConfigHistory(fresh.db, { section: 'ssh', changedKeys: [] })).toBeNull();
    recordConfigHistory(fresh.db, { section: 'ssh', changedKeys: ['connect_timeout'] });
    recordConfigHistory(fresh.db, { section: 'alerts', changedKeys: ['cooldown_minutes'] });
    const rows = listConfigHistory(fresh.db, { limit: 10 });
    expect(rows.map((r) => r.section)).toEqual(['alerts', 'ssh']);
  });

  it('filters by section and clamps the limit', () => {
    fresh = freshDb();
    for (let i = 0; i < 5; i += 1) {
      recordConfigHistory(fresh.db, { section: i % 2 === 0 ? 'ssh' : 'smtp', changedKeys: [`k${i}`] });
    }
    expect(listConfigHistory(fresh.db, { section: 'ssh', limit: 999 }).length).toBe(3);
    expect(listConfigHistory(fresh.db, { limit: 2 }).length).toBe(2);
  });

  it('prunes rows older than the 90 day window', () => {
    fresh = freshDb();
    recordConfigHistory(fresh.db, {
      section: 'ssh',
      changedKeys: ['connect_timeout'],
      changedAt: '2020-01-01T00:00:00.000000+00:00',
    });
    recordConfigHistory(fresh.db, { section: 'ssh', changedKeys: ['command_timeout'] });
    expect(pruneConfigHistory(fresh.db)).toBe(1);
    expect(listConfigHistory(fresh.db, { limit: 10 })).toHaveLength(1);
  });
});
