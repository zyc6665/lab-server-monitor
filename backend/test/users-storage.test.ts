/**
 * Tests for `backend/src/storage/users.ts` — the Node port of the Python oracle
 * `servermanage/storage/users.py`.
 *
 * Every test runs against a brand-new fully-initialised SQLite database (see
 * {@link freshDb}) so rows never leak between cases. The suite mirrors the
 * oracle's public surface: snapshot, baseline, scan-state, usage history,
 * operations, growth ranking and host-data deletion.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  saveHostUserSnapshot,
  saveHostUserScanResult,
  getHostUserSnapshot,
  getAllHostUserSnapshots,
  upsertUserBaseline,
  getUserBaseline,
  getAllUserBaselines,
  deleteUserBaseline,
  saveUserScanState,
  getUserScanState,
  getAllUserScanStates,
  appendUserUsageHistory,
  getUserUsageDeltas,
  getAllUserUsageDeltas,
  getUserUsageSeries,
  saveUserOperation,
  listUserOperations,
  topUserGrowth,
  deleteHostUserData,
  type UserAccountInput,
} from '../src/storage/users';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

/** Matches `nowIsoUtc` output: 6-digit microseconds and a `+00:00` offset. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

function count(db: TestDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

/** A fixed UTC instant for deterministic timestamps. */
function utc(year: number, month: number, day: number, hour = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0, 0));
}

/** A fully-populated account exercising every stored snapshot field. */
function sampleAccount(overrides: Partial<UserAccountInput> = {}): UserAccountInput {
  return {
    username: 'alice',
    uid: 1000,
    gid: 1000,
    primary_group: 'users',
    gecos: 'Alice Example',
    home: '/home/alice',
    shell: '/bin/bash',
    groups: ['sudo', 'users'],
    in_docker: 1,
    in_sudo: 0,
    home_exists: true,
    home_owner: 'alice',
    home_group: 'users',
    home_mode: '0700',
    home_size_bytes: 100,
    data_exists: false,
    data_owner: null,
    data_group: null,
    data_mode: null,
    data_size_bytes: null,
    usage_stale: 0,
    usage_collected_at: '2026-01-02T03:04:05.123000+00:00',
    ...overrides,
  };
}

describe('user snapshot', () => {
  it('round-trips a full account with booleans, groups and JSON', () => {
    const { db } = freshDb();

    saveHostUserSnapshot(db, 'host-a', [sampleAccount()]);

    const rows = getHostUserSnapshot(db, 'host-a');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.host_name).toBe('host-a');
    expect(row.username).toBe('alice');
    expect(row.uid).toBe(1000);
    expect(row.gid).toBe(1000);
    expect(row.primary_group).toBe('users');
    expect(row.gecos).toBe('Alice Example');
    expect(row.groups).toEqual(['sudo', 'users']);
    // flag columns are decoded back to real booleans
    expect(row.in_docker).toBe(true);
    expect(row.in_sudo).toBe(false);
    expect(row.home_exists).toBe(true);
    expect(row.data_exists).toBe(false);
    // data_supported defaulted to true, usage_readable derived from sizes
    expect(row.data_supported).toBe(true);
    expect(row.usage_readable).toBe(true);
    expect(row.usage_stale).toBe(false);
    expect(row.usage_collected_at).toBe('2026-01-02T03:04:05.123000+00:00');
  });

  it('stores groups as Python-compatible JSON and flags as 0/1 integers', () => {
    const { db } = freshDb();

    saveHostUserSnapshot(db, 'host-a', [sampleAccount()]);

    const raw = db
      .prepare('SELECT groups_json, in_docker, in_sudo FROM host_user_snapshot')
      .get() as { groups_json: string; in_docker: number; in_sudo: number };
    expect(raw.groups_json).toBe('["sudo", "users"]');
    expect(raw.in_docker).toBe(1);
    expect(raw.in_sudo).toBe(0);
  });

  it('falls back to a strict nowIsoUtc timestamp when collected_at is absent', () => {
    const { db } = freshDb();

    saveHostUserSnapshot(db, 'host-a', [sampleAccount({ collected_at: undefined })]);

    const row = getHostUserSnapshot(db, 'host-a')[0];
    expect(row.collected_at).toMatch(STRICT_ISO);
  });

  it('replaces only the target host and clears it for an empty account list', () => {
    const { db } = freshDb();
    saveHostUserSnapshot(db, 'host-a', [sampleAccount({ username: 'alice' })]);
    saveHostUserSnapshot(db, 'host-b', [sampleAccount({ username: 'bob' })]);

    saveHostUserSnapshot(db, 'host-a', [
      sampleAccount({ username: 'carol' }),
      sampleAccount({ username: 'dave' }),
    ]);

    expect(getHostUserSnapshot(db, 'host-a').map((r) => r.username)).toEqual([
      'carol',
      'dave',
    ]);
    expect(getHostUserSnapshot(db, 'host-b').map((r) => r.username)).toEqual(['bob']);

    saveHostUserSnapshot(db, 'host-a', []);
    expect(getHostUserSnapshot(db, 'host-a')).toEqual([]);
    expect(count(db, 'host_user_snapshot')).toBe(1);
  });

  it('groups a fleet snapshot by host, ordered by host then username', () => {
    const { db } = freshDb();
    saveHostUserSnapshot(db, 'host-b', [sampleAccount({ username: 'zed' })]);
    saveHostUserSnapshot(db, 'host-a', [
      sampleAccount({ username: 'bob' }),
      sampleAccount({ username: 'alice' }),
    ]);

    const all = getAllHostUserSnapshots(db);
    expect(Object.keys(all)).toEqual(['host-a', 'host-b']);
    expect(all['host-a'].map((r) => r.username)).toEqual(['alice', 'bob']);
    expect(all['host-b'].map((r) => r.username)).toEqual(['zed']);
  });
});

describe('user baseline', () => {
  it('inserts once, then refreshes without changing first_seen_at', () => {
    const { db } = freshDb();
    const t0 = '2026-01-01T00:00:00.000000+00:00';
    const t1 = '2026-01-03T00:00:00.000000+00:00';

    const inserted = upsertUserBaseline(db, 'host-a', sampleAccount(), { now: t0 });
    expect(inserted).toBe(true);

    const updated = upsertUserBaseline(
      db,
      'host-a',
      sampleAccount({ shell: '/bin/zsh', groups: ['docker'] }),
      { now: t1 },
    );
    expect(updated).toBe(false);

    const rows = getUserBaseline(db, 'host-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].shell).toBe('/bin/zsh');
    expect(rows[0].groups).toEqual(['docker']);
    expect(rows[0].first_seen_at).toBe(t0);
    expect(rows[0].last_seen_at).toBe(t1);
  });

  it('lists a fleet baseline grouped by host, and deletes one row', () => {
    const { db } = freshDb();
    upsertUserBaseline(db, 'host-b', sampleAccount({ username: 'zoe' }));
    upsertUserBaseline(db, 'host-a', sampleAccount({ username: 'bob' }));
    upsertUserBaseline(db, 'host-a', sampleAccount({ username: 'alice' }));

    const all = getAllUserBaselines(db);
    expect(Object.keys(all)).toEqual(['host-a', 'host-b']);
    expect(all['host-a'].map((r) => r.username)).toEqual(['alice', 'bob']);

    expect(deleteUserBaseline(db, 'host-a', 'bob')).toBe(true);
    expect(deleteUserBaseline(db, 'host-a', 'bob')).toBe(false);
    expect(getUserBaseline(db, 'host-a').map((r) => r.username)).toEqual(['alice']);
  });
});

describe('user scan state', () => {
  it('upserts and only overwrites the provided fields', () => {
    const { db } = freshDb();
    const t0 = '2026-01-01T00:00:00.000000+00:00';
    const t1 = '2026-01-02T00:00:00.000000+00:00';

    saveUserScanState(db, 'host-a', { lastScanAt: t0, lastError: '' });
    let state = getUserScanState(db, 'host-a');
    expect(state).not.toBeNull();
    expect(state!.last_scan_at).toBe(t0);
    expect(state!.last_usage_at).toBeNull();
    expect(state!.last_error).toBe('');

    saveUserScanState(db, 'host-a', { lastUsageAt: t1 });
    state = getUserScanState(db, 'host-a');
    expect(state!.last_scan_at).toBe(t0);
    expect(state!.last_usage_at).toBe(t1);

    saveUserScanState(db, 'host-a', { lastError: 'connection refused' });
    expect(getUserScanState(db, 'host-a')!.last_error).toBe('connection refused');

    // an empty string clears a previous error, null leaves it untouched
    saveUserScanState(db, 'host-a', { lastError: null });
    expect(getUserScanState(db, 'host-a')!.last_error).toBe('connection refused');
    saveUserScanState(db, 'host-a', { lastError: '' });
    expect(getUserScanState(db, 'host-a')!.last_error).toBe('');
  });

  it('returns null for an unknown host and lists all states', () => {
    const { db } = freshDb();
    expect(getUserScanState(db, 'nope')).toBeNull();

    saveUserScanState(db, 'host-a', { lastScanAt: '2026-01-01T00:00:00.000000+00:00' });
    saveUserScanState(db, 'host-b', { lastScanAt: '2026-01-02T00:00:00.000000+00:00' });

    const all = getAllUserScanStates(db);
    expect(Object.keys(all).sort()).toEqual(['host-a', 'host-b']);
    expect(all['host-b'].last_scan_at).toBe('2026-01-02T00:00:00.000000+00:00');
  });
});

describe('user usage history', () => {
  it('records only accounts that carry a size', () => {
    const { db } = freshDb();
    const written = appendUserUsageHistory(
      db,
      'host-a',
      [
        sampleAccount({ username: 'alice', home_size_bytes: 100, data_size_bytes: null }),
        sampleAccount({ username: 'bob', home_size_bytes: null, data_size_bytes: 50 }),
        sampleAccount({ username: 'ghost', home_size_bytes: null, data_size_bytes: null }),
      ],
      { now: utc(2026, 1, 2) },
    );
    expect(written).toBe(2);
    expect(count(db, 'host_user_usage_history')).toBe(2);
  });

  it('throttles unchanged sizes to one per interval but records changes', () => {
    const { db } = freshDb();
    const base = { now: utc(2026, 1, 2) };

    expect(
      appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 100 })], base),
    ).toBe(1);
    // same size 1h later -> skipped
    expect(
      appendUserUsageHistory(
        db,
        'host-a',
        [sampleAccount({ home_size_bytes: 100 })],
        { now: utc(2026, 1, 2, 1) },
      ),
    ).toBe(0);
    // changed size 2h later -> recorded
    expect(
      appendUserUsageHistory(
        db,
        'host-a',
        [sampleAccount({ home_size_bytes: 300 })],
        { now: utc(2026, 1, 2, 2) },
      ),
    ).toBe(1);
    expect(count(db, 'host_user_usage_history')).toBe(2);

    // minIntervalHours 0 records every sample, even unchanged
    expect(
      appendUserUsageHistory(
        db,
        'host-a',
        [sampleAccount({ home_size_bytes: 300 })],
        { now: utc(2026, 1, 2, 3), minIntervalHours: 0 },
      ),
    ).toBe(1);
    expect(count(db, 'host_user_usage_history')).toBe(3);
  });

  it('prunes samples older than retainDays', () => {
    const { db } = freshDb();
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 100 })], {
      now: utc(2026, 1, 1),
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 400 })], {
      now: utc(2026, 7, 10),
    });

    const rows = db
      .prepare('SELECT collected_at FROM host_user_usage_history ORDER BY collected_at')
      .all() as Array<{ collected_at: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].collected_at).toBe('2026-07-10T00:00:00.000000+00:00');
  });

  it('computes deltas from the oldest and newest samples in the window', () => {
    const { db } = freshDb();
    appendUserUsageHistory(
      db,
      'host-a',
      [sampleAccount({ username: 'alice', home_size_bytes: 100 })],
      { now: utc(2026, 1, 2), minIntervalHours: 0 },
    );
    appendUserUsageHistory(
      db,
      'host-a',
      [sampleAccount({ username: 'alice', home_size_bytes: 400 })],
      { now: utc(2026, 1, 4), minIntervalHours: 0 },
    );
    appendUserUsageHistory(
      db,
      'host-a',
      [sampleAccount({ username: 'bob', home_size_bytes: 70 })],
      { now: utc(2026, 1, 3) },
    );

    const deltas = getUserUsageDeltas(db, 'host-a', { now: utc(2026, 1, 6) });
    expect(deltas.alice).toEqual({
      delta: 300,
      base: 100,
      current: 400,
      since: '2026-01-02T00:00:00.000000+00:00',
      points: 2,
    });
    expect(deltas.bob.delta).toBeNull();
    expect(deltas.bob.points).toBe(1);
  });

  it('groups fleet deltas by host', () => {
    const { db } = freshDb();
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 100 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 250 })], {
      now: utc(2026, 1, 3),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(
      db,
      'host-b',
      [sampleAccount({ username: 'bob', home_size_bytes: 10 })],
      { now: utc(2026, 1, 2) },
    );

    const all = getAllUserUsageDeltas(db, { now: utc(2026, 1, 5) });
    expect(Object.keys(all).sort()).toEqual(['host-a', 'host-b']);
    expect(all['host-a'].alice.delta).toBe(150);
    expect(all['host-b'].bob.delta).toBeNull();
  });

  it('builds a usage series and downsamples to maxPoints', () => {
    const { db } = freshDb();
    for (let hour = 0; hour < 5; hour += 1) {
      appendUserUsageHistory(
        db,
        'host-a',
        [sampleAccount({ home_size_bytes: 100 + hour * 10 })],
        { now: utc(2026, 1, 2, hour), minIntervalHours: 0 },
      );
    }
    // a both-null row is ignored by the series
    db.prepare(
      'INSERT INTO host_user_usage_history (host_name, username, collected_at, home_size_bytes, data_size_bytes)'
        + " VALUES ('host-a', 'alice', '2026-01-02T06:00:00.000000+00:00', NULL, NULL)",
    ).run();

    const series = getUserUsageSeries(db, 'host-a', {
      now: utc(2026, 1, 3),
      maxPoints: 3,
    });
    const points = series.alice;
    expect(points).toHaveLength(3);
    // indices 0, 2, 4 of the five real samples
    expect(points[0].total).toBe(100);
    expect(points[1].total).toBe(120);
    expect(points[2].total).toBe(140);
    expect(points[0].at).toBe('2026-01-02T00:00:00.000000+00:00');
  });

  it('returns the full series when under maxPoints', () => {
    const { db } = freshDb();
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 100 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 200 })], {
      now: utc(2026, 1, 2, 1),
      minIntervalHours: 0,
    });
    const series = getUserUsageSeries(db, 'host-a', { now: utc(2026, 1, 3), maxPoints: 36 });
    expect(series.alice).toHaveLength(2);
    expect(series.alice[1].total).toBe(200);
  });

  it('ranks accounts by positive growth, dropping shrinking ones', () => {
    const { db } = freshDb();
    // host-a alice: +300
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ username: 'alice', home_size_bytes: 100 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ username: 'alice', home_size_bytes: 400 })], {
      now: utc(2026, 1, 3),
      minIntervalHours: 0,
    });
    // host-a bob: +10
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ username: 'bob', home_size_bytes: 50 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ username: 'bob', home_size_bytes: 60 })], {
      now: utc(2026, 1, 3),
      minIntervalHours: 0,
    });
    // host-b carol: +700
    appendUserUsageHistory(db, 'host-b', [sampleAccount({ username: 'carol', home_size_bytes: 200 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-b', [sampleAccount({ username: 'carol', home_size_bytes: 900 })], {
      now: utc(2026, 1, 3),
      minIntervalHours: 0,
    });
    // host-b dave: negative -> dropped
    appendUserUsageHistory(db, 'host-b', [sampleAccount({ username: 'dave', home_size_bytes: 100 })], {
      now: utc(2026, 1, 2),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-b', [sampleAccount({ username: 'dave', home_size_bytes: 50 })], {
      now: utc(2026, 1, 3),
      minIntervalHours: 0,
    });

    const growth = topUserGrowth(db, { now: utc(2026, 1, 5) });
    expect(growth.map((g) => g.account)).toEqual(['carol', 'alice', 'bob']);
    expect(growth[0]).toMatchObject({ host: 'host-b', account: 'carol', delta: 700, base: 200, current: 900 });

    expect(topUserGrowth(db, { now: utc(2026, 1, 5), limit: 2 }).map((g) => g.account)).toEqual([
      'carol',
      'alice',
    ]);
    expect(topUserGrowth(db, { now: utc(2026, 1, 5), limit: 0 })).toEqual([]);
  });

  it('ignores samples outside the window', () => {
    const { db } = freshDb();
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 100 })], {
      now: utc(2025, 1, 1),
      minIntervalHours: 0,
    });
    appendUserUsageHistory(db, 'host-a', [sampleAccount({ home_size_bytes: 400 })], {
      now: utc(2025, 1, 2),
      minIntervalHours: 0,
    });
    const growth = topUserGrowth(db, { now: utc(2026, 1, 1), days: 7 });
    expect(growth).toEqual([]);
  });
});

describe('user operations', () => {
  it('appends an audit row and returns its id, newest first when listed', () => {
    const { db } = freshDb();

    const firstId = saveUserOperation(db, 'host-a', 'alice', 'provision', 'success', {
      actor: 'admin',
      steps: [{ step: 'create', ok: true }],
    });
    const secondId = saveUserOperation(db, 'host-a', 'bob', 'provision', 'failed', {
      error: 'useradd exited 1',
    });
    expect(secondId).toBeGreaterThan(firstId);

    const ops = listUserOperations(db, { hostName: 'host-a' });
    expect(ops).toHaveLength(2);
    expect(ops[0].id).toBe(secondId); // newest first
    expect(ops[0].account).toBe('bob');
    expect(ops[0].status).toBe('failed');
    expect(ops[0].error).toBe('useradd exited 1');
    // defaults
    expect(ops[0].actor).toBe('');
    expect(ops[0].plan_hash).toBe('');
    expect(ops[0].steps).toEqual([]);

    expect(ops[1].id).toBe(firstId);
    expect(ops[1].actor).toBe('admin');
    expect(ops[1].steps).toEqual([{ step: 'create', ok: true }]);
  });

  it('stores steps as Python-compatible JSON', () => {
    const { db } = freshDb();
    saveUserOperation(db, 'host-a', 'alice', 'provision', 'success', {
      steps: [{ step: 'create', ok: true }],
    });
    const raw = db.prepare('SELECT steps_json FROM user_operations').get() as {
      steps_json: string;
    };
    expect(raw.steps_json).toBe('[{"step": "create", "ok": true}]');
  });

  it('filters by host and clamps the limit', () => {
    const { db } = freshDb();
    saveUserOperation(db, 'host-a', 'alice', 'provision', 'success');
    saveUserOperation(db, 'host-a', 'bob', 'provision', 'success');
    saveUserOperation(db, 'host-a', 'carol', 'provision', 'success');
    saveUserOperation(db, 'host-b', 'dave', 'provision', 'success');

    expect(listUserOperations(db, { hostName: 'host-a' })).toHaveLength(3);
    expect(listUserOperations(db, { hostName: 'host-b' })).toHaveLength(1);
    expect(listUserOperations(db, { hostName: 'host-a', limit: 2 })).toHaveLength(2);
    // limit 0 is clamped to 1, not 0
    expect(listUserOperations(db, { hostName: 'host-a', limit: 0 })).toHaveLength(1);
  });
});

describe('saveHostUserScanResult', () => {
  it('persists snapshot + baseline + scan state atomically and reports new users', () => {
    const { db } = freshDb();
    const moment = '2026-01-02T00:00:00.000000+00:00';

    const inserted = saveHostUserScanResult(
      db,
      'host-a',
      [sampleAccount({ username: 'alice' }), sampleAccount({ username: 'bob' })],
      { now: moment, usageRefreshed: true },
    );
    expect(inserted).toEqual(['alice', 'bob']);
    expect(getHostUserSnapshot(db, 'host-a')).toHaveLength(2);
    expect(getUserBaseline(db, 'host-a')).toHaveLength(2);

    const state = getUserScanState(db, 'host-a');
    expect(state!.last_scan_at).toBe(moment);
    expect(state!.last_usage_at).toBe(moment);
    expect(state!.last_error).toBe('');

    // second scan: only the newly appeared account is reported as added
    const second = saveHostUserScanResult(
      db,
      'host-a',
      [
        sampleAccount({ username: 'alice', home_size_bytes: 999 }),
        sampleAccount({ username: 'carol' }),
      ],
      { now: '2026-01-03T00:00:00.000000+00:00' },
    );
    expect(second).toEqual(['carol']);
    // snapshot fully replaced
    expect(getHostUserSnapshot(db, 'host-a').map((r) => r.username)).toEqual([
      'alice',
      'carol',
    ]);
    // usage not refreshed -> last_usage_at keeps the earlier value
    expect(getUserScanState(db, 'host-a')!.last_usage_at).toBe(moment);
  });

  it('seeds the baseline silently when seedOnly is set', () => {
    const { db } = freshDb();

    const inserted = saveHostUserScanResult(
      db,
      'host-a',
      [sampleAccount({ username: 'alice' }), sampleAccount({ username: 'bob' })],
      { seedOnly: true },
    );
    expect(inserted).toEqual([]);
    expect(getUserBaseline(db, 'host-a')).toHaveLength(2);
  });
});

describe('deleteHostUserData', () => {
  it('removes snapshot, baseline and scan state for one host only', () => {
    const { db } = freshDb();
    saveHostUserScanResult(db, 'host-a', [sampleAccount()]);
    saveHostUserScanResult(db, 'host-b', [sampleAccount()]);

    deleteHostUserData(db, 'host-a');

    expect(getHostUserSnapshot(db, 'host-a')).toEqual([]);
    expect(getUserBaseline(db, 'host-a')).toEqual([]);
    expect(getUserScanState(db, 'host-a')).toBeNull();
    // other host untouched
    expect(getHostUserSnapshot(db, 'host-b')).toHaveLength(1);
    expect(getUserBaseline(db, 'host-b')).toHaveLength(1);
    expect(getUserScanState(db, 'host-b')).not.toBeNull();
  });
});
