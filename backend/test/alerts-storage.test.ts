import { describe, it, expect, afterEach } from 'vitest';

import {
  insertAlert,
  updateAlert,
  findLatestAlert,
  closeAlertsForHost,
  listAlerts,
  listAlertsForHost,
  listOpenAlertsForHost,
  listRecentAlertsGrouped,
  fetchAlertHistory,
  countActiveAlertsByHost,
  countActiveCriticalAlerts,
  countAlertsByStatus,
  insertSilence,
  listSilences,
  deleteSilence,
  pruneAlertSilences,
  pruneAlertHistory,
  type AlertEventInput,
  type AlertRangeKey,
} from '../src/storage/alerts';
import { nowIsoUtc } from '../src/storage/time';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

/** `nowIsoUtc` renders `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` (Python-compatible). */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

function count(db: TestDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

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

/** A representative alert event; override any field per test. */
function makeEvent(overrides: Partial<AlertEventInput> = {}): AlertEventInput {
  return {
    host_name: 'host-a',
    category: 'disk',
    severity: 'warning',
    title: 'Disk usage high',
    message: '/data at 91%',
    fingerprint: 'disk:/data',
    ...overrides,
  };
}

describe('insertAlert + findLatestAlert', () => {
  it('inserts an active row with a strict ISO UTC created_at', () => {
    const { db } = freshDb();
    const id = insertAlert(db, makeEvent());

    expect(typeof id).toBe('number');
    const rows = listAlerts(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].status).toBe('active');
    expect(rows[0].host_name).toBe('host-a');
    expect(rows[0].fingerprint).toBe('disk:/data');
    expect(rows[0].notified_channels).toBeNull();
    expect(rows[0].ack_at).toBeNull();
    expect(rows[0].created_at).toMatch(STRICT_ISO);
  });

  it('honours an explicit created_at', () => {
    const { db } = freshDb();
    const created = isoAt(2026, 1, 2, 3, 4, 5);
    insertAlert(db, makeEvent(), { createdAt: created });

    expect(listAlerts(db)[0].created_at).toBe(created);
  });

  it('findLatestAlert picks the newest row for a fingerprint, else null', () => {
    const { db } = freshDb();
    insertAlert(db, makeEvent({ fingerprint: 'fp' }), { createdAt: isoAt(2026, 1, 1) });
    const newer = insertAlert(
      db,
      makeEvent({ fingerprint: 'fp' }),
      { createdAt: isoAt(2026, 1, 2) },
    );

    expect(findLatestAlert(db, 'fp')?.id).toBe(newer);
    expect(findLatestAlert(db, 'missing')).toBeNull();
  });
});

describe('listAlerts', () => {
  function seed(db: TestDb): { a: number; b: number; c: number } {
    const a = insertAlert(db, makeEvent({ fingerprint: 'a' }), { createdAt: isoAt(2026, 1, 1) });
    const b = insertAlert(db, makeEvent({ fingerprint: 'b' }), { createdAt: isoAt(2026, 1, 2) });
    const c = insertAlert(db, makeEvent({ fingerprint: 'c' }), { createdAt: isoAt(2026, 1, 3) });
    updateAlert(db, a, { status: 'resolved' });
    updateAlert(db, b, { status: 'acknowledged' });
    return { a, b, c };
  }

  it('orders newest first and respects limit', () => {
    const { db } = freshDb();
    const { a, b, c } = seed(db);

    expect(listAlerts(db).map((r) => r.id)).toEqual([c, b, a]);
    expect(listAlerts(db, { limit: 2 }).map((r) => r.id)).toEqual([c, b]);
  });

  it('filters by status', () => {
    const { db } = freshDb();
    const { a } = seed(db);

    expect(listAlerts(db, { status: 'resolved' }).map((r) => r.id)).toEqual([a]);
  });

  it('filters by since (created_at >= cutoff)', () => {
    const { db } = freshDb();
    const { b, c } = seed(db);

    expect(listAlerts(db, { since: isoAt(2026, 1, 2) }).map((r) => r.id)).toEqual([c, b]);
  });
});

describe('updateAlert', () => {
  it('updates only the provided columns', () => {
    const { db } = freshDb();
    const id = insertAlert(db, makeEvent());

    updateAlert(db, id, {
      status: 'acknowledged',
      notifiedChannels: 'slack,#ops',
      ackAt: '2026-01-02T00:00:00+00:00',
    });
    const row = findLatestAlert(db, 'disk:/data')!;
    expect(row.status).toBe('acknowledged');
    expect(row.notified_channels).toBe('slack,#ops');
    expect(row.ack_at).toBe('2026-01-02T00:00:00+00:00');
  });

  it('is a no-op when nothing is provided', () => {
    const { db } = freshDb();
    const id = insertAlert(db, makeEvent());

    updateAlert(db, id, {});
    const row = findLatestAlert(db, 'disk:/data')!;
    expect(row.status).toBe('active');
    expect(row.notified_channels).toBeNull();
    expect(row.ack_at).toBeNull();
  });

  it('leaves unset fields untouched', () => {
    const { db } = freshDb();
    const id = insertAlert(db, makeEvent());

    updateAlert(db, id, { status: 'resolved' });
    const row = findLatestAlert(db, 'disk:/data')!;
    expect(row.status).toBe('resolved');
    expect(row.notified_channels).toBeNull();
  });
});

describe('closeAlertsForHost', () => {
  it('resolves active/acknowledged rows of one host+category and returns count', () => {
    const { db } = freshDb();
    const active = insertAlert(db, makeEvent({ fingerprint: 'a' }));
    const ack = insertAlert(db, makeEvent({ fingerprint: 'b' }));
    updateAlert(db, ack, { status: 'acknowledged' });
    const otherHost = insertAlert(db, makeEvent({ fingerprint: 'c', host_name: 'host-b' }));
    const otherCategory = insertAlert(db, makeEvent({ fingerprint: 'd', category: 'cpu' }));

    expect(closeAlertsForHost(db, 'host-a', { category: 'disk' })).toBe(2);
    expect(findLatestAlert(db, 'a')?.status).toBe('resolved');
    expect(findLatestAlert(db, 'b')?.status).toBe('resolved');
    expect(findLatestAlert(db, 'c')?.status).toBe('active');
    expect(findLatestAlert(db, 'd')?.status).toBe('active');
    // sanity: no rows deleted
    expect(count(db, 'alerts')).toBe(4);
    void active;
    void otherHost;
    void otherCategory;
  });

  it('returns 0 when nothing matches and supports a custom status', () => {
    const { db } = freshDb();
    insertAlert(db, makeEvent({ fingerprint: 'a' }));

    expect(closeAlertsForHost(db, 'host-a', { category: 'cpu' })).toBe(0);
    expect(closeAlertsForHost(db, 'host-a', { category: 'disk', status: 'acknowledged' })).toBe(1);
    expect(findLatestAlert(db, 'a')?.status).toBe('acknowledged');
  });
});

describe('listAlertsForHost + listOpenAlertsForHost', () => {
  function seed(db: TestDb): void {
    const a = insertAlert(db, makeEvent({ fingerprint: 'a' }), { createdAt: isoAt(2026, 1, 1) });
    const b = insertAlert(db, makeEvent({ fingerprint: 'b' }), { createdAt: isoAt(2026, 1, 2) });
    const c = insertAlert(db, makeEvent({ fingerprint: 'c' }), { createdAt: isoAt(2026, 1, 3) });
    insertAlert(db, makeEvent({ fingerprint: 'x', host_name: 'host-b' }));
    insertAlert(db, makeEvent({ fingerprint: 'y', category: 'cpu' }), { createdAt: isoAt(2026, 1, 4) });
    updateAlert(db, a, { status: 'resolved' });
    updateAlert(db, b, { status: 'acknowledged' });
    void c;
  }

  it('listAlertsForHost filters by host, newest first, honours limit', () => {
    const { db } = freshDb();
    seed(db);

    const rows = listAlertsForHost(db, 'host-a');
    expect(rows.every((r) => r.host_name === 'host-a')).toBe(true);
    // 4 host-a rows: a(1), b(2), c(3), y(1/4)
    expect(rows).toHaveLength(4);
    expect(rows[0].created_at).toBe(isoAt(2026, 1, 4));
    expect(listAlertsForHost(db, 'host-a', { limit: 2 })).toHaveLength(2);
  });

  it('listOpenAlertsForHost keeps active+acknowledged, optionally by category', () => {
    const { db } = freshDb();
    seed(db);

    const open = listOpenAlertsForHost(db, 'host-a');
    // active: c, y ; acknowledged: b ; resolved: a excluded
    expect(open.map((r) => r.fingerprint).sort()).toEqual(['b', 'c', 'y']);
    const diskOnly = listOpenAlertsForHost(db, 'host-a', { category: 'disk' });
    expect(diskOnly.map((r) => r.fingerprint).sort()).toEqual(['b', 'c']);
  });
});

describe('listRecentAlertsGrouped', () => {
  it('caps rows per host and groups by host_name without the rn helper', () => {
    const { db } = freshDb();
    insertAlert(db, makeEvent({ host_name: 'host-a', fingerprint: 'a1' }), { createdAt: isoAt(2026, 1, 1) });
    insertAlert(db, makeEvent({ host_name: 'host-a', fingerprint: 'a2' }), { createdAt: isoAt(2026, 1, 2) });
    insertAlert(db, makeEvent({ host_name: 'host-a', fingerprint: 'a3' }), { createdAt: isoAt(2026, 1, 3) });
    insertAlert(db, makeEvent({ host_name: 'host-b', fingerprint: 'b1' }), { createdAt: isoAt(2026, 1, 1) });

    const grouped = listRecentAlertsGrouped(db, { perHost: 2 });
    expect(Object.keys(grouped).sort()).toEqual(['host-a', 'host-b']);
    expect(grouped['host-a']).toHaveLength(2);
    expect(grouped['host-a'].map((r) => r.fingerprint)).toEqual(['a3', 'a2']);
    expect(grouped['host-b']).toHaveLength(1);
    expect(grouped['host-a'][0]).not.toHaveProperty('rn');
  });
});

describe('counts', () => {
  function seed(db: TestDb): void {
    const a1 = insertAlert(db, makeEvent({ fingerprint: 'a1', severity: 'warning' }));
    insertAlert(db, makeEvent({ fingerprint: 'a2', severity: 'Critical' }));
    insertAlert(db, makeEvent({ fingerprint: 'b1', host_name: 'host-b', severity: 'critical' }));
    const a4 = insertAlert(db, makeEvent({ fingerprint: 'a4' }));
    const a5 = insertAlert(db, makeEvent({ fingerprint: 'a5' }));
    updateAlert(db, a4, { status: 'resolved' });
    updateAlert(db, a5, { status: 'acknowledged' });
    void a1;
  }

  it('countActiveAlertsByHost groups active rows per host', () => {
    const { db } = freshDb();
    seed(db);

    expect(countActiveAlertsByHost(db)).toEqual({ 'host-a': 2, 'host-b': 1 });
  });

  it('countActiveCriticalAlerts is case-insensitive', () => {
    const { db } = freshDb();
    seed(db);

    // a2 ('Critical') + b1 ('critical') are both active critical.
    expect(countActiveCriticalAlerts(db)).toBe(2);
  });

  it('countAlertsByStatus fills known keys and totals every row', () => {
    const { db } = freshDb();
    seed(db);

    expect(countAlertsByStatus(db)).toEqual({
      active: 3,
      acknowledged: 1,
      resolved: 1,
      total: 5,
    });
  });

  it('countAlertsByStatus honours since', () => {
    const { db } = freshDb();
    insertAlert(db, makeEvent({ fingerprint: 'old' }), { createdAt: isoAt(2026, 1, 1) });
    insertAlert(db, makeEvent({ fingerprint: 'new' }), { createdAt: isoAt(2026, 2, 1) });

    expect(countAlertsByStatus(db, { since: isoAt(2026, 1, 15) })).toEqual({
      active: 1,
      acknowledged: 0,
      resolved: 0,
      total: 1,
    });
  });
});

describe('fetchAlertHistory', () => {
  it('buckets a 24h window by local hour', () => {
    const { db } = freshDb();
    const now = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
    insertAlert(db, makeEvent({ fingerprint: 'h1', severity: 'critical' }), {
      createdAt: isoAt(2026, 11, 25, 11, 30, 0),
    });
    insertAlert(db, makeEvent({ fingerprint: 'h2', severity: 'warning' }), {
      createdAt: isoAt(2026, 11, 25, 0, 15, 0),
    });
    insertAlert(db, makeEvent({ fingerprint: 'h3', severity: 'debug' }), {
      createdAt: isoAt(2026, 11, 25, 5, 0, 0),
    });
    insertAlert(db, makeEvent({ fingerprint: 'h4', severity: 'info' }), {
      createdAt: isoAt(2026, 11, 25, 5, 0, 0),
    });

    const buckets = fetchAlertHistory(db, { rangeKey: '24h', tz: 'UTC', now });
    expect(buckets).toHaveLength(24);
    expect(buckets[0].label).toBe('13:00');
    expect(buckets[23].label).toBe('12:00');

    const find = (label: string) => buckets.find((b) => b.label === label)!;
    expect(find('11:00').critical).toBe(1);
    expect(find('00:00').warning).toBe(1);
    // unknown severity ('debug') falls back to info
    expect(find('05:00').info).toBe(2);
    expect(find('05:00').total).toBe(2);
    expect(buckets.reduce((sum, b) => sum + b.total, 0)).toBe(4);
  });

  it('buckets a 7d window by local day and 30d has 30 buckets', () => {
    const { db } = freshDb();
    const now = new Date(Date.UTC(2026, 10, 25, 12, 0, 0));
    insertAlert(db, makeEvent({ fingerprint: 'd1', severity: 'critical' }), {
      createdAt: isoAt(2026, 11, 24, 10, 0, 0),
    });
    insertAlert(db, makeEvent({ fingerprint: 'd2', severity: 'warning' }), {
      createdAt: isoAt(2026, 11, 19, 1, 0, 0),
    });

    const buckets = fetchAlertHistory(db, { rangeKey: '7d', tz: 'UTC', now });
    expect(buckets).toHaveLength(7);
    expect(buckets[0].label).toBe('11-19');
    expect(buckets[0].key).toBe('2026-11-19');
    expect(buckets[6].label).toBe('11-25');
    expect(buckets.find((b) => b.label === '11-24')!.critical).toBe(1);
    expect(buckets.find((b) => b.label === '11-19')!.warning).toBe(1);

    expect(fetchAlertHistory(db, { rangeKey: '30d', tz: 'UTC', now })).toHaveLength(30);
  });

  it('honours the requested timezone when bucketing', () => {
    const { db } = freshDb();
    const now = new Date(Date.UTC(2026, 10, 25, 12, 0, 0)); // 20:00 in Shanghai
    // 2026-11-24T20:00Z == 2026-11-25T04:00 in Asia/Shanghai
    insertAlert(db, makeEvent({ fingerprint: 'tz1', severity: 'critical' }), {
      createdAt: isoAt(2026, 11, 24, 20, 0, 0),
    });

    const buckets = fetchAlertHistory(db, { rangeKey: '24h', tz: 'Asia/Shanghai', now });
    expect(buckets).toHaveLength(24);
    expect(buckets.find((b) => b.label === '04:00')!.critical).toBe(1);
  });

  it('rejects an unknown range_key', () => {
    const { db } = freshDb();
    expect(() =>
      fetchAlertHistory(db, { rangeKey: '1h' as unknown as AlertRangeKey }),
    ).toThrow('range_key must be 24h, 7d or 30d');
  });
});

describe('silences', () => {
  it('inserts and lists a silence with a strict ISO created_at', () => {
    const { db } = freshDb();
    const id = insertSilence(
      db,
      'host',
      'host-a',
      'maintenance',
      isoAt(2026, 11, 25),
      isoAt(2026, 11, 26),
      'alice',
    );

    expect(typeof id).toBe('number');
    const rows = listSilences(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id);
    expect(rows[0].scope_type).toBe('host');
    expect(rows[0].scope).toBe('host-a');
    expect(rows[0].reason).toBe('maintenance');
    expect(rows[0].created_by).toBe('alice');
    expect(rows[0].created_at).toMatch(STRICT_ISO);
  });

  it('activeOnly keeps windows where starts_at <= now < ends_at', () => {
    const { db } = freshDb();
    const current = insertSilence(
      db,
      'host',
      'host-a',
      'now',
      isoAt(2026, 11, 25),
      isoAt(2026, 11, 26),
      'alice',
    );
    insertSilence(db, 'host', 'host-b', 'future', isoAt(2026, 12, 1), isoAt(2026, 12, 2), 'bob');

    const active = listSilences(db, {
      activeOnly: true,
      now: new Date(Date.UTC(2026, 10, 25, 12, 0, 0)),
    });
    expect(active.map((s) => s.id)).toEqual([current]);
  });

  it('deleteSilence returns true once then false', () => {
    const { db } = freshDb();
    const id = insertSilence(db, 'host', 'host-a', 'r', isoAt(2026, 11, 25), isoAt(2026, 11, 26), 'a');

    expect(deleteSilence(db, id)).toBe(true);
    expect(deleteSilence(db, id)).toBe(false);
    expect(listSilences(db)).toHaveLength(0);
  });

  it('pruneAlertSilences removes ended windows only', () => {
    const { db } = freshDb();
    insertSilence(db, 'host', 'host-a', 'past', isoAt(2026, 10, 1), isoAt(2026, 10, 2), 'a');
    const live = insertSilence(db, 'host', 'host-b', 'live', isoAt(2026, 11, 1), isoAt(2026, 12, 31), 'a');

    const removed = pruneAlertSilences(db, { now: new Date(Date.UTC(2026, 10, 25, 12, 0, 0)) });
    expect(removed).toBe(1);
    expect(listSilences(db).map((s) => s.id)).toEqual([live]);
  });
});

describe('pruneAlertHistory', () => {
  it('deletes only resolved alerts older than the retention window', () => {
    const { db } = freshDb();
    const oldResolved = insertAlert(db, makeEvent({ fingerprint: 'old-resolved' }), {
      createdAt: isoAt(2026, 10, 1),
    });
    updateAlert(db, oldResolved, { status: 'resolved' });
    const recentResolved = insertAlert(db, makeEvent({ fingerprint: 'recent-resolved' }), {
      createdAt: isoAt(2026, 12, 10),
    });
    updateAlert(db, recentResolved, { status: 'resolved' });
    insertAlert(db, makeEvent({ fingerprint: 'old-active' }), { createdAt: isoAt(2026, 10, 1) });

    const removed = pruneAlertHistory(db, 30, {
      now: new Date(Date.UTC(2026, 11, 15, 0, 0, 0)),
    });
    expect(removed).toBe(1);
    expect(findLatestAlert(db, 'old-resolved')).toBeNull();
    expect(findLatestAlert(db, 'recent-resolved')).not.toBeNull();
    expect(findLatestAlert(db, 'old-active')).not.toBeNull();
    expect(count(db, 'alerts')).toBe(2);
  });
});
