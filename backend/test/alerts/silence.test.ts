import { describe, it, expect, afterEach } from 'vitest';

import { SilenceRegistry } from '../../src/alerts/silence';
import { insertSilence, deleteSilence } from '../../src/storage/alerts';
import { nowIsoUtc } from '../../src/storage/time';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

/** Builds a strict UTC timestamp from calendar/clock parts (all UTC). */
function isoAt(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): string {
  return nowIsoUtc(new Date(Date.UTC(year, month - 1, day, hour, minute, second)));
}

const NOW = new Date(Date.UTC(2026, 10, 26, 0, 0, 0)); // 2026-11-26T00:00:00Z
const PAST_START = isoAt(2026, 11, 1);
const FUTURE_END = isoAt(2026, 12, 1);

describe('SilenceRegistry.activeFor', () => {
  it('silences every host under an `all` window', () => {
    const { db } = freshDb();
    insertSilence(db, 'all', null, '全站维护', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW)).toEqual({
      silenced: true,
      reason: '全站维护',
    });
    expect(registry.activeFor({ hostName: 'db-9' }, NOW).silenced).toBe(true);
  });

  it('matches a `host` window by exact host name', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'web-1', '磁盘升级', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW)).toEqual({
      silenced: true,
      reason: '磁盘升级',
    });
    expect(registry.activeFor({ hostName: 'web-2' }, NOW).silenced).toBe(false);
  });

  it('matches a `group` window by group name', () => {
    const { db } = freshDb();
    insertSilence(db, 'group', 'prod', '生产维护', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1', group: 'prod' }, NOW)).toEqual({
      silenced: true,
      reason: '生产维护',
    });
    expect(registry.activeFor({ hostName: 'web-1', group: 'staging' }, NOW).silenced).toBe(false);
  });

  it('treats an unspecified group as the default group', () => {
    const { db } = freshDb();
    insertSilence(db, 'group', '未分组', '默认分组维护', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(true);
    expect(registry.activeFor({ hostName: 'web-1', group: null }, NOW).silenced).toBe(true);
  });

  it('prefers `all` over `group` and `host`', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'web-1', 'host-r', PAST_START, FUTURE_END, 'alice');
    insertSilence(db, 'group', 'prod', 'group-r', PAST_START, FUTURE_END, 'alice');
    insertSilence(db, 'all', null, 'all-r', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1', group: 'prod' }, NOW)).toEqual({
      silenced: true,
      reason: 'all-r',
    });
  });

  it('prefers `group` over `host`', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'web-1', 'host-r', PAST_START, FUTURE_END, 'alice');
    insertSilence(db, 'group', 'prod', 'group-r', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1', group: 'prod' }, NOW)).toEqual({
      silenced: true,
      reason: 'group-r',
    });
  });

  it('returns the first window in creation order within the same scope', () => {
    const { db } = freshDb();
    insertSilence(db, 'all', null, 'first', PAST_START, FUTURE_END, 'alice');
    insertSilence(db, 'all', null, 'second', PAST_START, FUTURE_END, 'bob');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).reason).toBe('first');
  });

  it('ignores an expired window', () => {
    const { db } = freshDb();
    insertSilence(db, 'all', null, '过期', isoAt(2026, 10, 1), isoAt(2026, 11, 24), 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW)).toEqual({ silenced: false });
  });

  it('ignores a window that has not started yet', () => {
    const { db } = freshDb();
    insertSilence(db, 'all', null, '未来', isoAt(2026, 11, 27), FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(false);
  });

  it('treats the end boundary as expired (now < ends_at)', () => {
    const { db } = freshDb();
    insertSilence(db, 'all', null, 'ends-now', PAST_START, isoAt(2026, 11, 26, 0, 0, 0), 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(false);
  });

  it('treats the start boundary as active (starts_at <= now)', () => {
    const { db } = freshDb();
    const start = isoAt(2026, 11, 26, 0, 0, 0);
    insertSilence(db, 'all', null, 'starts-now', start, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(true);
  });

  it('matches a `fingerprint` window by exact fingerprint', () => {
    const { db } = freshDb();
    insertSilence(db, 'fingerprint', 'disk:/data', '该磁盘维护', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(
      registry.activeFor({ hostName: 'web-1', fingerprint: 'disk:/data' }, NOW),
    ).toEqual({ silenced: true, reason: '该磁盘维护' });
    expect(
      registry.activeFor({ hostName: 'web-1', fingerprint: 'disk:/' }, NOW).silenced,
    ).toBe(false);
  });

  it('matches a `category` window by exact category', () => {
    const { db } = freshDb();
    insertSilence(db, 'category', 'disk', '磁盘告警静默', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1', category: 'disk' }, NOW).silenced).toBe(true);
    expect(registry.activeFor({ hostName: 'web-1', category: 'cpu' }, NOW).silenced).toBe(false);
  });

  it('returns silenced:false with no reason when nothing matches', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'other-host', 'r', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    const result = registry.activeFor({ hostName: 'web-1' }, NOW);
    expect(result).toEqual({ silenced: false });
    expect(result.reason).toBeUndefined();
  });

  it('accepts the plan spelling `host` as an alias for `hostName`', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'web-1', '别名', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ host: 'web-1' }, NOW)).toEqual({
      silenced: true,
      reason: '别名',
    });
  });

  it('re-reads the database on every call (no caching)', () => {
    const { db } = freshDb();
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(false);

    const id = insertSilence(db, 'all', null, '新增静默', PAST_START, FUTURE_END, 'alice');
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(true);

    deleteSilence(db, id);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(false);
  });

  it('does not match a host window with a null scope', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', null, '坏行', PAST_START, FUTURE_END, 'alice');
    const registry = new SilenceRegistry(db);
    expect(registry.activeFor({ hostName: 'web-1' }, NOW).silenced).toBe(false);
  });
});
