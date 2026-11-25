/**
 * Tests for `src/users/collection.ts` — the Node port of the collection /
 * persistence layer in `servermanage/user_collection.py:48-420`.
 *
 * Every test runs against a fresh fully-initialised SQLite database (see
 * {@link freshDb}) and injects both a fake scanner (`runScan`) and a stub
 * runner factory, so no real SSH/host is ever touched. The assertions cover the
 * behavioural contract: host filtering, first-scan baseline seeding, snapshot +
 * usage-history writes, stale usage never overwriting a known size, scan
 * failures keeping the previous baseline, partial-failure isolation, and the
 * summary shape the P2 users route consumes.
 */
import { describe, it, expect, afterEach } from 'vitest';

import type { HostConfig } from '../../src/config/config';
import type { HostUserAccount } from '../../src/collect/types';
import type { CollectHostUsersOptions, CollectHostUsersResult, UserScanRunner } from '../../src/users/scan';
import {
  accountFromBaseline,
  isUserMonitoringEnabled,
  runUserScan,
  usageIsStale,
  type HostUserScanner,
  type UserScanRunnerFactory,
} from '../../src/users/collection';
import {
  getHostUserSnapshot,
  getUserBaseline,
  getUserScanState,
  saveHostUserScanResult,
  upsertUserBaseline,
  type UserAccountInput,
} from '../../src/storage/users';
import { saveAppSettings } from '../../src/storage/settings';
import { nowIsoUtc } from '../../src/storage/time';
import { cleanupStorageTests, freshDb, type TestDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

/** Matches `nowIsoUtc` output: six fractional digits and a `+00:00` offset. */
const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

/** A fixed UTC instant used for every deterministic run. */
const NOW = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const NOW_ISO = nowIsoUtc(NOW);
const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimal `HostConfig`; the collector only reads `.name`, `.user_monitoring`. */
function host(name: string, overrides: Partial<HostConfig> = {}): HostConfig {
  return { name, ...overrides } as unknown as HostConfig;
}

/** A fully-populated scan account (camelCase `HostUserAccount`). */
function account(overrides: Partial<HostUserAccount> = {}): HostUserAccount {
  return {
    hostName: 'host-a',
    username: 'alice',
    uid: 1001,
    gid: 1001,
    primaryGroup: 'users',
    gecos: 'Alice',
    home: '/home/alice',
    shell: '/bin/bash',
    groups: ['users'],
    inDocker: false,
    inSudo: false,
    homeExists: true,
    homeOwner: 'alice',
    homeGroup: 'users',
    homeMode: '0700',
    homeSizeBytes: 500,
    dataExists: false,
    dataOwner: null,
    dataGroup: null,
    dataMode: null,
    dataSizeBytes: null,
    dataSupported: true,
    usageReadable: true,
    usageStale: false,
    usageCollectedAt: NOW_ISO,
    collectedAt: NOW_ISO,
    state: 'present',
    ...overrides,
  };
}

/** A `CollectHostUsersResult` wrapping the given accounts. */
function scanResult(
  accounts: HostUserAccount[],
  overrides: Partial<CollectHostUsersResult> = {},
): CollectHostUsersResult {
  return { accounts, usageReadable: true, usageRefreshed: false, ...overrides };
}

/** A snake_case storage input used to pre-seed snapshots/baselines. */
function snapshotInput(overrides: Partial<UserAccountInput> = {}): UserAccountInput {
  return {
    username: 'alice',
    uid: 1001,
    gid: 1001,
    primary_group: 'users',
    gecos: 'Alice',
    home: '/home/alice',
    shell: '/bin/bash',
    groups: ['users'],
    in_docker: 0,
    in_sudo: 0,
    home_exists: 1,
    home_owner: 'alice',
    home_group: 'users',
    home_mode: '0700',
    home_size_bytes: 500,
    data_exists: 0,
    data_owner: null,
    data_group: null,
    data_mode: null,
    data_size_bytes: null,
    data_supported: 1,
    usage_stale: 0,
    usage_readable: 1,
    usage_collected_at: NOW_ISO,
    collected_at: NOW_ISO,
    ...overrides,
  };
}

interface ScanCall {
  host: string;
  options: CollectHostUsersOptions;
}

/** Wraps a handler in a recording scanner so tests can inspect the options. */
function recordingScan(
  handler: (
    host: HostConfig,
    options: CollectHostUsersOptions,
  ) => CollectHostUsersResult | Promise<CollectHostUsersResult>,
): { runScan: HostUserScanner; calls: ScanCall[] } {
  const calls: ScanCall[] = [];
  const runScan: HostUserScanner = (hostConfig, _runner, options) => {
    calls.push({ host: hostConfig.name, options });
    return handler(hostConfig, options);
  };
  return { runScan, calls };
}

/** A stub runner factory that never connects; records which runners were closed. */
function stubRunners(): { runnerFactory: UserScanRunnerFactory; closed: string[] } {
  const closed: string[] = [];
  const runnerFactory: UserScanRunnerFactory = (hostConfig) => {
    const runner: UserScanRunner & { close: () => void } = {
      run: async () => ({ stdout: '', stderr: '', exitStatus: 0 }),
      runSudo: async () => ({ stdout: '', stderr: '', exitStatus: 0 }),
      close: () => {
        closed.push(hostConfig.name);
      },
    };
    return runner;
  };
  return { runnerFactory, closed };
}

/** Counts usage-history rows for a host. */
function usageHistoryCount(db: TestDb, hostName: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM host_user_usage_history WHERE host_name = ?')
    .get(hostName) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// isUserMonitoringEnabled
// ---------------------------------------------------------------------------

describe('isUserMonitoringEnabled', () => {
  it('honours a host-level boolean override and otherwise inherits the global switch', () => {
    const globalOn = { user_monitoring: { enabled: true } };
    const globalOff = { user_monitoring: { enabled: false } };

    // Explicit host values win in both directions.
    expect(isUserMonitoringEnabled(host('a', { user_monitoring: true }), globalOff)).toBe(true);
    expect(isUserMonitoringEnabled(host('a', { user_monitoring: false }), globalOn)).toBe(false);
    // Undefined inherits the global value.
    expect(isUserMonitoringEnabled(host('a'), globalOn)).toBe(true);
    expect(isUserMonitoringEnabled(host('a'), globalOff)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// usageIsStale
// ---------------------------------------------------------------------------

describe('usageIsStale', () => {
  const interval = 1000;
  const now = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  const recent = new Date(now.getTime() - 10 * 60 * 1000);

  it('is fresh when refreshed, stale when missing/forced/older than 1.5x', () => {
    expect(usageIsStale(now, recent, interval, true)).toBe(false);
    expect(usageIsStale(now, null, interval, false)).toBe(true);
    expect(usageIsStale(now, recent, interval, false, { usageDue: true })).toBe(true);
    // Age exactly at 1.5x is not stale; one second past it is.
    const boundary = new Date(now.getTime() - interval * 1.5 * 1000);
    expect(usageIsStale(now, boundary, interval, false)).toBe(false);
    expect(usageIsStale(now, new Date(boundary.getTime() - 1000), interval, false)).toBe(true);
    expect(usageIsStale(now, recent, interval, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// accountFromBaseline
// ---------------------------------------------------------------------------

describe('accountFromBaseline', () => {
  it('reconstructs a missing account from a baseline row', () => {
    const row = {
      username: 'bob',
      uid: 2002,
      gid: 2002,
      primary_group: 'devs',
      gecos: 'Bob',
      home: '/home/bob',
      shell: '/bin/zsh',
      groups: ['devs', 'sudo'],
      in_docker: 0,
      in_sudo: 1,
      home_size_bytes: 42,
    };
    const result = accountFromBaseline('host-z', row, NOW_ISO);
    expect(result.state).toBe('missing');
    expect(result.hostName).toBe('host-z');
    expect(result.username).toBe('bob');
    expect(result.uid).toBe(2002);
    expect(result.primaryGroup).toBe('devs');
    expect(result.groups).toEqual(['devs', 'sudo']);
    expect(result.inSudo).toBe(true);
    expect(result.homeSizeBytes).toBe(42);
    expect(result.collectedAt).toBe(NOW_ISO);
  });
});

// ---------------------------------------------------------------------------
// Host filtering
// ---------------------------------------------------------------------------

describe('runUserScan host filtering', () => {
  it('skips hosts disabled via a user_monitoring=false override', async () => {
    const { db } = freshDb();
    const { runScan, calls } = recordingScan(() => scanResult([account()]));
    const { runnerFactory } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('disabled', { user_monitoring: false }), host('enabled')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(calls.map((call) => call.host)).toEqual(['enabled']);
    expect(summary.hosts_total).toBe(1);
    expect(summary.hosts_done).toBe(1);
  });

  it('runs only hosts that override a globally-disabled switch back on', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { enabled: false });
    const { runScan, calls } = recordingScan(() => scanResult([account()]));
    const { runnerFactory } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('forced-on', { user_monitoring: true }), host('inherits-off')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(calls.map((call) => call.host)).toEqual(['forced-on']);
    expect(summary.hosts_total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// First scan: silent baseline seed
// ---------------------------------------------------------------------------

describe('runUserScan first scan', () => {
  it('seeds the baseline silently and writes the snapshot + scan state', async () => {
    const { db } = freshDb();
    const { runScan } = recordingScan(() =>
      scanResult([account({ username: 'alice' }), account({ username: 'bob' })], {
        usageRefreshed: true,
      }),
    );
    const { runnerFactory } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(summary.accounts).toBe(2);
    expect(getHostUserSnapshot(db, 'host-a')).toHaveLength(2);
    // First scan seeds the baseline (no `user-added` alerts on that edge).
    expect(getUserBaseline(db, 'host-a')).toHaveLength(2);
    const state = getUserScanState(db, 'host-a');
    expect(state?.last_scan_at).toBe(NOW_ISO);
    expect(state?.last_usage_at).toBe(NOW_ISO);
    expect(state?.last_error).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Snapshot + usage-history writes
// ---------------------------------------------------------------------------

describe('runUserScan persistence', () => {
  it('writes the snapshot, records usage history, and marks fresh usage non-stale', async () => {
    const { db } = freshDb();
    const { runScan } = recordingScan(() =>
      scanResult([account({ homeSizeBytes: 500 })], { usageRefreshed: true }),
    );
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    const snapshot = getHostUserSnapshot(db, 'host-a');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].home_size_bytes).toBe(500);
    expect(snapshot[0].usage_stale).toBe(false);
    expect(usageHistoryCount(db, 'host-a')).toBe(1);
  });

  it('records a growing usage delta across two scans', async () => {
    const { db } = freshDb();
    const { runnerFactory } = stubRunners();

    const first = recordingScan(() =>
      scanResult([account({ homeSizeBytes: 500 })], { usageRefreshed: true }),
    );
    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan: first.runScan,
      runnerFactory,
      now: NOW,
    });

    const secondAt = new Date(NOW.getTime() + DAY_MS);
    const secondIso = nowIsoUtc(secondAt);
    const second = recordingScan(() =>
      scanResult([account({ homeSizeBytes: 900, usageCollectedAt: secondIso })], {
        usageRefreshed: true,
      }),
    );
    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan: second.runScan,
      runnerFactory,
      now: secondAt,
    });

    expect(getHostUserSnapshot(db, 'host-a')[0].home_size_bytes).toBe(900);
    expect(usageHistoryCount(db, 'host-a')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Stale usage never overwrites a known size
// ---------------------------------------------------------------------------

describe('runUserScan stale usage', () => {
  it('retains the previous size and flags usage_stale when a refresh produces nothing', async () => {
    const { db } = freshDb();
    // A one-hour usage interval makes the seeded (day-old) measurement due +
    // stale; the fake scanner reports nothing measured and no refresh.
    saveAppSettings(db, 'user_monitoring', { usage_interval_seconds: 3600 });

    const previousAt = new Date(NOW.getTime() - DAY_MS);
    saveHostUserScanResult(
      db,
      'host-a',
      [snapshotInput({ home_size_bytes: 500, usage_collected_at: nowIsoUtc(previousAt) })],
      {
        now: previousAt,
        usageRefreshed: true,
      },
    );

    const { runScan } = recordingScan(() =>
      scanResult(
        [
          account({
            homeSizeBytes: null,
            usageCollectedAt: null,
            dataSizeBytes: null,
          }),
        ],
        { usageReadable: false, usageRefreshed: false },
      ),
    );
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    const snapshot = getHostUserSnapshot(db, 'host-a');
    expect(snapshot).toHaveLength(1);
    // The unknown size must not erase the known one.
    expect(snapshot[0].home_size_bytes).toBe(500);
    expect(snapshot[0].usage_stale).toBe(true);
    // usage_collected_at falls back to the last successful usage time.
    expect(snapshot[0].usage_collected_at).toBe(nowIsoUtc(previousAt));
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('runUserScan failure handling', () => {
  it('records last_error and keeps the previous baseline when a scan throws', async () => {
    const { db } = freshDb();
    saveHostUserScanResult(db, 'host-a', [snapshotInput({ username: 'alice' })], {
      now: NOW,
      usageRefreshed: true,
    });
    expect(getUserBaseline(db, 'host-a')).toHaveLength(1);

    const { runScan } = recordingScan(async () => {
      throw new Error('boom');
    });
    const { runnerFactory } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(summary.hosts_done).toBe(0);
    expect(summary.hosts_failed).toBe(1);
    expect(summary.errors['host-a']).toBe('boom');
    const state = getUserScanState(db, 'host-a');
    expect(state?.last_error).toBe('boom');
    // Baseline survives the failure untouched.
    expect(getUserBaseline(db, 'host-a')).toHaveLength(1);
  });

  it('isolates a failure so other hosts still succeed', async () => {
    const { db } = freshDb();
    const { runScan } = recordingScan((hostConfig) => {
      if (hostConfig.name === 'host-b') {
        throw new Error('unreachable');
      }
      return scanResult([account({ hostName: 'host-a', username: 'alice' })]);
    });
    const { runnerFactory, closed } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('host-a'), host('host-b')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(summary.hosts_total).toBe(2);
    expect(summary.hosts_done).toBe(1);
    expect(summary.hosts_failed).toBe(1);
    expect(summary.accounts).toBe(1);
    expect(summary.errors).toEqual({ 'host-b': 'unreachable' });
    expect(getHostUserSnapshot(db, 'host-a')).toHaveLength(1);
    expect(getUserScanState(db, 'host-b')?.last_error).toBe('unreachable');
    // Every runner is closed, success or failure.
    expect(closed.sort()).toEqual(['host-a', 'host-b']);
  });

  it('keeps the previous baseline row when a scan fails on re-scan', async () => {
    const { db } = freshDb();
    saveHostUserScanResult(db, 'host-a', [snapshotInput({ username: 'carol' })], {
      now: new Date(NOW.getTime() - DAY_MS),
      usageRefreshed: true,
    });

    const { runScan } = recordingScan(async () => {
      throw new Error('timeout');
    });
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    const baseline = getUserBaseline(db, 'host-a');
    expect(baseline.map((row) => row.username)).toContain('carol');
  });
});

// ---------------------------------------------------------------------------
// Usage-due / known-usage decisions
// ---------------------------------------------------------------------------

describe('runUserScan usage scheduling', () => {
  it('is due on the first scan even with a long interval', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { usage_interval_seconds: 604800 });
    const { runScan, calls } = recordingScan(() => scanResult([account()]));
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(calls[0].options.usageDue).toBe(true);
  });

  it('forceUsage ignores a recent last usage', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { usage_interval_seconds: 604800 });
    saveHostUserScanResult(db, 'host-a', [snapshotInput()], {
      now: new Date(NOW.getTime() - 60 * 1000),
      usageRefreshed: true,
    });

    const { runScan, calls } = recordingScan(() => scanResult([account()]));
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
      forceUsage: true,
    });

    expect(calls[0].options.usageDue).toBe(true);
  });

  it('seeds known usage from a fresh previous measurement', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { usage_interval_seconds: 604800 });
    const previousAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    saveHostUserScanResult(
      db,
      'host-a',
      [snapshotInput({ home_size_bytes: 777, usage_collected_at: nowIsoUtc(previousAt) })],
      { now: previousAt, usageRefreshed: true },
    );

    const { runScan, calls } = recordingScan(() =>
      scanResult([account({ homeSizeBytes: 777 })]),
    );
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    const known = calls[0].options.knownUsage ?? {};
    expect(known.alice).toBeTruthy();
    expect(known.alice.home).toBe(777);
    expect(known.alice.at).toBe(nowIsoUtc(previousAt));
  });

  it('does not seed known usage from a measurement older than the interval', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { usage_interval_seconds: 3600 });
    const longAgo = new Date(Date.UTC(2020, 0, 1));
    saveHostUserScanResult(
      db,
      'host-a',
      [snapshotInput({ home_size_bytes: 777, usage_collected_at: nowIsoUtc(longAgo) })],
      { now: longAgo, usageRefreshed: true },
    );

    const { runScan, calls } = recordingScan(() => scanResult([account()]));
    const { runnerFactory } = stubRunners();

    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(calls[0].options.knownUsage ?? {}).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Summary shape
// ---------------------------------------------------------------------------

describe('runUserScan summary', () => {
  it('returns counts, timing and the refresh-status compatible fields', async () => {
    const { db } = freshDb();
    const { runScan } = recordingScan((hostConfig) =>
      hostConfig.name === 'host-a'
        ? scanResult([account(), account({ username: 'bob' })])
        : scanResult([account({ hostName: 'host-b', username: 'carol' })]),
    );
    const { runnerFactory } = stubRunners();

    const summary = await runUserScan({
      db,
      config: { servers: [host('host-a'), host('host-b')] },
      runScan,
      runnerFactory,
      now: NOW,
    });

    expect(summary.hosts_total).toBe(2);
    expect(summary.hosts_done).toBe(2);
    expect(summary.hosts_failed).toBe(0);
    expect(summary.accounts).toBe(3);
    expect(summary.errors).toEqual({});
    expect(summary.started_at).toBe(NOW_ISO);
    expect(summary.started_at).toMatch(STRICT_ISO);
    expect(summary.finished_at).toMatch(STRICT_ISO);
    expect(Date.parse(summary.finished_at)).toBeGreaterThanOrEqual(
      Date.parse(summary.started_at),
    );
    // Refresh-status compatible fields (users route `usageScanState`).
    expect(summary.running).toBe(false);
    expect(summary.current_host).toBeNull();
    expect(summary.current_account).toBeNull();
    expect(summary.next_account).toBeNull();
    expect(summary.accounts_done).toBe(3);
    expect(summary.accounts_total).toBe(3);
  });

  it('emits progress ticks tagged with the host/account currently being scanned', async () => {
    const { db } = freshDb();
    const { runScan } = recordingScan((_hostConfig, options) => {
      options.usageProgress?.('alice', 1, 2, 'bob');
      return scanResult([account({ username: 'alice' }), account({ username: 'bob' })], {
        usageRefreshed: true,
      });
    });
    const { runnerFactory } = stubRunners();

    const updates: Array<Record<string, unknown>> = [];
    await runUserScan({
      db,
      config: { servers: [host('host-a')] },
      runScan,
      runnerFactory,
      now: NOW,
      progress: (update) => updates.push({ ...update }),
    });

    const accountTick = updates.find((update) => update.current_account === 'alice');
    expect(accountTick).toBeTruthy();
    expect(accountTick?.current_host).toBe('host-a');
    expect(accountTick?.next_account).toBe('bob');
    expect(accountTick?.accounts_done).toBe(1);
    expect(accountTick?.accounts_total).toBe(2);
  });
});
