/**
 * Differential read-path tests: every query is answered by the Node storage
 * functions and by the Python `servermanage.storage` oracle against the same
 * seeded fixture, normalised per plan §9.1, and asserted identical
 * (`runDiff(...) === []`).
 *
 * If the Python interpreter / `servermanage` package is not importable in the
 * current environment, the comparison tests are skipped with an explanatory
 * warning (per the task's fallback clause); a Node-only sanity check still runs.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { listAlerts } from '../../src/storage/alerts';
import { openDatabase } from '../../src/storage/db';
import { getAllHostSnapshots, getHostSnapshot } from '../../src/storage/hosts';
import { fetchDailyPointsForWeek, fetchHostHistory } from '../../src/storage/metrics-read';
import { listSecretNames } from '../../src/storage/secrets';
import { loadAppSettings } from '../../src/storage/settings';
import { buildFixture, type Fixture } from './fixture';
import {
  runDiff,
  type QueryCase,
} from './harness';

/** `describe` that skips wholesale when the Python oracle is unavailable. */
const describePython = describe;

/** Clock injected into the metrics readers so cutoffs are reproducible. */
const NOW = new Date('2026-01-15T12:00:00.000Z');
const NOW_ISO = '2026-01-15T12:00:00+00:00';

let fixture: Fixture | null = null;

function useFixture(): Fixture {
  fixture = buildFixture();
  return fixture;
}

afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describePython('storage read paths: Node vs Python oracle', () => {
  it('app_settings (loadAppSettings)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      { name: 'settings', python: { op: 'settings' }, node: (db) => loadAppSettings(db) },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('secret names (non-secret listing)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      {
        name: 'secret_names',
        python: { op: 'secret_names' },
        node: (db) => listSecretNames(db),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('host snapshots (all + single + missing)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      {
        name: 'all_snapshots',
        python: { op: 'all_snapshots' },
        node: (db) => getAllHostSnapshots(db),
      },
      {
        name: 'host_snapshot',
        python: { op: 'host_snapshot', args: { host_name: 'host-a' } },
        node: (db) => getHostSnapshot(db, 'host-a'),
      },
      {
        name: 'host_snapshot_missing',
        python: { op: 'host_snapshot', args: { host_name: 'host-z' } },
        node: (db) => getHostSnapshot(db, 'host-z'),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('alerts list (all + status filter + limit)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      { name: 'alerts_all', python: { op: 'alerts' }, node: (db) => listAlerts(db) },
      {
        name: 'alerts_active_top2',
        python: { op: 'alerts', args: { status: 'active', limit: 2 } },
        node: (db) => listAlerts(db, { status: 'active', limit: 2 }),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('metrics history 24h (raw points + derived rates)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      {
        name: 'history_24h',
        python: { op: 'metrics_history', args: { host_name: 'host-a', range_key: '24h', now: NOW_ISO } },
        node: (db) => fetchHostHistory(db, 'host-a', { rangeKey: '24h', now: NOW }),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('metrics history 7d (daily-summary branch)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      {
        name: 'history_7d',
        python: { op: 'metrics_history', args: { host_name: 'host-a', range_key: '7d', now: NOW_ISO } },
        node: (db) => fetchHostHistory(db, 'host-a', { rangeKey: '7d', now: NOW }),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('daily summary week (fetchDailyPointsForWeek)', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      {
        name: 'daily_week',
        python: { op: 'daily_week', args: { week_start: '2026-01-05', week_end: '2026-01-11' } },
        node: (db) => fetchDailyPointsForWeek(db, '2026-01-05', '2026-01-11', 'UTC'),
      },
    ];
    expect(await runDiff(dbPath, cases)).toEqual([]);
  });

  it('harness self-check: a deliberate mismatch yields a non-empty diff', async () => {
    const { dbPath } = useFixture();
    const cases: QueryCase[] = [
      { name: 'settings', python: { op: 'settings' }, node: () => ({ __injected_mismatch__: true }) },
    ];
    const diffs = await runDiff(dbPath, cases);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((diff) => diff.path.startsWith('settings'))).toBe(true);
  });
});

// Node-only guard: runs even when the Python oracle is unavailable so a broken
// fixture or storage port still surfaces.
describe('storage read paths: Node fixture sanity', () => {
  it('seeded fixture is readable through the Node storage functions', () => {
    const { dbPath } = useFixture();
    const db = openDatabase(dbPath, { readonly: true });
    try {
      expect(Object.keys(loadAppSettings(db)).sort()).toEqual(['alerts', 'empty', 'general']);
      expect(listSecretNames(db)).toEqual(['a_token', 'm_ssh_passphrase', 'z_api_key']);
      expect(getAllHostSnapshots(db).map((row) => row.host_name)).toEqual(['host-a', 'host-b']);
      expect(getHostSnapshot(db, 'host-z')).toBeNull();
      expect(listAlerts(db).map((row) => row.id)).toEqual([3, 4, 2, 1]);
      const history = fetchHostHistory(db, 'host-a', { rangeKey: '24h', now: NOW });
      expect(history.map((point) => point.cpu)).toEqual([10, 20]);
      const week = fetchDailyPointsForWeek(db, '2026-01-05', '2026-01-11', 'UTC');
      expect(week.map((point) => `${point.host_name}@${point.day}`)).toEqual([
        'host-a@2026-01-09',
        'host-a@2026-01-10',
        'host-a@2026-01-11',
        'host-b@2026-01-10',
      ]);
    } finally {
      db.close();
    }
  });
});
