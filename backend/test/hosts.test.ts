import { describe, it, expect, afterEach } from 'vitest';

import {
  saveHostSnapshot,
  getHostSnapshot,
  getAllHostSnapshots,
  persistHostReports,
  saveHostCheckResults,
  getHostCheckResults,
  getAllHostCheckResults,
  deleteHostCheckResults,
  fetchHostNetworkRates,
  fetchAllHostNetworkRates,
  type HostReportInput,
} from '../src/storage/hosts';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

const STRICT_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

afterEach(cleanupStorageTests);

function count(db: TestDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

/** A fully-populated successful host report exercising every stored field. */
function sampleReport(overrides: Partial<HostReportInput> = {}): HostReportInput {
  return {
    host_name: 'host-a',
    host: '10.0.0.1',
    success: true,
    metrics: {
      collected_at: '2026-01-02T03:04:05.123000+00:00',
      cpu_usage_percent: 42.5,
      memory: { used_mb: 2048, total_mb: 8192 },
      load_average: { load_1: 1.5, load_5: 1.25, load_15: 1 },
      disk_usage: [
        { filesystem: 'tmpfs', mountpoint: '/run', percent: '99%' },
        { filesystem: '/dev/sda1', mountpoint: '/', percent: '60%' },
        { filesystem: '/dev/sdb1', mountpoint: '/data', percent: '85%' },
      ],
      gpu_summary: [
        { utilization_percent: 30, temperature_c: 55, memory_used_mb: 1000, memory_total_mb: 4000 },
        { utilization_percent: 80, temperature_c: 60, memory_used_mb: 2000, memory_total_mb: 4000 },
      ],
      total_processes: 130,
      logged_in_users: [{ username: 'alice' }, { username: 'bob' }],
      net_rx_bytes: 1000,
      net_tx_bytes: 2000,
      thermal_zones: [{ celsius: 45.5 }],
    },
    errors: [],
    checks: [],
    users: [],
    ...overrides,
  };
}

describe('host_latest_snapshot', () => {
  it('round-trips a full report and exposes metrics/errors', () => {
    const { db } = freshDb();
    const report = sampleReport();

    saveHostSnapshot(db, report);

    const snapshot = getHostSnapshot(db, 'host-a');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.host_name).toBe('host-a');
    expect(snapshot!.collected_at).toBe('2026-01-02T03:04:05.123000+00:00');
    expect(snapshot!.success).toBe(true);
    expect(snapshot!.metrics).toEqual(report.metrics);
    expect(snapshot!.errors).toEqual([]);

    expect(getAllHostSnapshots(db)).toHaveLength(1);
  });

  it('replaces (upserts) a single row per host on write', () => {
    const { db } = freshDb();
    saveHostSnapshot(db, sampleReport());
    saveHostSnapshot(
      db,
      sampleReport({
        metrics: { ...sampleReport().metrics, cpu_usage_percent: 10, collected_at: '2026-01-03T00:00:00.000000+00:00' },
      }),
    );

    expect(count(db, 'host_latest_snapshot')).toBe(1);
    const snapshot = getHostSnapshot(db, 'host-a')!;
    expect((snapshot.metrics as { cpu_usage_percent: number }).cpu_usage_percent).toBe(10);
    expect(snapshot.collected_at).toBe('2026-01-03T00:00:00.000000+00:00');
  });

  it('serialises raw_json exactly like Python json.dumps(ensure_ascii=False)', () => {
    const { db } = freshDb();
    saveHostSnapshot(db, sampleReport());

    const row = db
      .prepare('SELECT raw_json FROM host_latest_snapshot WHERE host_name = ?')
      .get('host-a') as { raw_json: string };
    // Spaces after ", " and ": " (Python default separators), booleans as JSON
    // true/false (not 0/1), raw UTF-8 preserved.
    expect(row.raw_json.startsWith('{"host_name": "host-a", "host": "10.0.0.1", "success": true, "metrics": {')).toBe(true);
    expect(row.raw_json).toContain('"cpu_usage_percent": 42.5');
    expect(row.raw_json).toContain('"collected_at": "2026-01-02T03:04:05.123000+00:00"');
    expect(() => JSON.parse(row.raw_json)).not.toThrow();
  });

  it('defaults collected_at to a strict UTC ISO timestamp when absent', () => {
    const { db } = freshDb();
    saveHostSnapshot(db, sampleReport({ metrics: { cpu_usage_percent: 1 } }));

    const snapshot = getHostSnapshot(db, 'host-a')!;
    expect(snapshot.collected_at).toMatch(STRICT_ISO);
  });

  it('accepts a Date collected_at and renders it with microsecond precision', () => {
    const { db } = freshDb();
    saveHostSnapshot(
      db,
      sampleReport({ metrics: { ...sampleReport().metrics, collected_at: new Date('2026-01-02T03:04:05.123Z') } }),
    );
    expect(getHostSnapshot(db, 'host-a')!.collected_at).toBe('2026-01-02T03:04:05.123000+00:00');
  });

  it('returns null / [] / empty metrics for an unknown or empty database', () => {
    const { db } = freshDb();
    expect(getHostSnapshot(db, 'nope')).toBeNull();
    expect(getAllHostSnapshots(db)).toEqual([]);
  });

  it('orders getAllHostSnapshots by host name', () => {
    const { db } = freshDb();
    saveHostSnapshot(db, sampleReport({ host_name: 'host-c' }));
    saveHostSnapshot(db, sampleReport({ host_name: 'host-a' }));
    expect(getAllHostSnapshots(db).map((s) => s.host_name)).toEqual(['host-a', 'host-c']);
  });
});

describe('persistHostReports (host_metrics_history + host_daily_summary)', () => {
  it('writes every metric column with 0/1 success and computed roll-ups', () => {
    const { db } = freshDb();
    persistHostReports(db, [sampleReport()]);

    const row = db
      .prepare('SELECT * FROM host_metrics_history WHERE host_name = ?')
      .get('host-a') as Record<string, unknown>;
    expect(row.collected_at).toBe('2026-01-02T03:04:05.123000+00:00');
    expect(row.success).toBe(1);
    expect(row.cpu_usage_percent).toBe(42.5);
    expect(row.memory_used_mb).toBe(2048);
    expect(row.memory_total_mb).toBe(8192);
    expect(row.disk_used_percent).toBe(85); // max over non-virtual filesystems
    expect(row.gpu_utilization_percent).toBe(80); // max GPU util
    expect(row.gpu_memory_used_mb).toBe(3000); // sum across GPUs
    expect(row.gpu_memory_total_mb).toBe(8000);
    expect(row.total_processes).toBe(130);
    expect(row.logged_in_user_count).toBe(2);
    expect(row.load_1).toBe(1.5);
    expect(row.load_5).toBe(1.25);
    expect(row.load_15).toBe(1);
    expect(row.net_rx_bytes).toBe(1000);
    expect(row.net_tx_bytes).toBe(2000);
    expect(row.temperature_c).toBe(60); // max(thermal 45.5, gpu 55, gpu 60)
  });

  it('accumulates the daily summary across repeated report batches', () => {
    const { db } = freshDb();
    persistHostReports(db, [sampleReport()]);
    persistHostReports(db, [sampleReport({ metrics: { ...sampleReport().metrics, cpu_usage_percent: 50 } })]);

    const summary = db
      .prepare('SELECT * FROM host_daily_summary WHERE host_name = ?')
      .get('host-a') as Record<string, unknown>;
    expect(summary.day).toBe('2026-01-02');
    expect(summary.tz).toBe('UTC');
    expect(summary.sample_count).toBe(2);
    expect(summary.success_count).toBe(2);
    expect(summary.cpu_sum).toBeCloseTo(92.5, 6);
    expect(summary.cpu_max).toBe(50);
    expect(summary.cpu_min).toBe(42.5);
    expect(summary.memory_pct_sum).toBeCloseTo(50, 6); // 25 + 25
    expect(summary.disk_pct_sum).toBeCloseTo(170, 6); // 85 + 85
    expect(summary.gpu_util_sum).toBeCloseTo(160, 6); // 80 + 80
    expect(summary.gpu_memory_pct_sum).toBeCloseTo(75, 6); // 37.5 + 37.5
    expect(summary.load_sum).toBeCloseTo(3, 6); // 1.5 + 1.5
    expect(summary.users_sum).toBeCloseTo(4, 6); // 2 + 2
    expect(summary.processes_sum).toBeCloseTo(260, 6); // 130 + 130
  });

  it('uses configured disk mounts and treats virtual filesystems as absent', () => {
    const { db } = freshDb();
    persistHostReports(db, [sampleReport()], { diskMounts: { 'host-a': ['/data'] } });
    expect(
      (db.prepare('SELECT disk_used_percent FROM host_metrics_history WHERE host_name = ?').get('host-a') as {
        disk_used_percent: number;
      }).disk_used_percent,
    ).toBe(85);

    // A configured mount backed by tmpfs is "absent" -> null, not 99.
    const { db: db2 } = freshDb();
    persistHostReports(db2, [sampleReport()], { diskMounts: { 'host-a': ['/run'] } });
    expect(
      (db2.prepare('SELECT disk_used_percent FROM host_metrics_history WHERE host_name = ?').get('host-a') as {
        disk_used_percent: number | null;
      }).disk_used_percent,
    ).toBeNull();

    // A configured mount that was never reported -> null.
    const { db: db3 } = freshDb();
    persistHostReports(db3, [sampleReport()], { diskMounts: { 'host-a': ['/missing'] } });
    expect(
      (db3.prepare('SELECT disk_used_percent FROM host_metrics_history WHERE host_name = ?').get('host-a') as {
        disk_used_percent: number | null;
      }).disk_used_percent,
    ).toBeNull();
  });

  it('computes the local summary day for the requested timezone', () => {
    const { db } = freshDb();
    const report = sampleReport({
      metrics: { ...sampleReport().metrics, collected_at: '2026-01-01T20:30:00.000000+00:00' },
    });
    persistHostReports(db, [report], { tz: 'Asia/Shanghai' });
    const summary = db.prepare('SELECT day, tz FROM host_daily_summary WHERE host_name = ?').get('host-a') as {
      day: string;
      tz: string;
    };
    // 20:30 UTC on Jan 1 is 04:30 on Jan 2 in Asia/Shanghai.
    expect(summary.day).toBe('2026-01-02');
    expect(summary.tz).toBe('Asia/Shanghai');
  });

  it('skips failed host reports entirely', () => {
    const { db } = freshDb();
    persistHostReports(db, sampleReport({ success: false }));
    expect(count(db, 'host_metrics_history')).toBe(0);
    expect(count(db, 'host_daily_summary')).toBe(0);
  });

  it('accepts either a DailyReport object or a bare report array', () => {
    const { db } = freshDb();
    persistHostReports(db, { reports: [sampleReport()], subject_prefix: 'x' });
    expect(count(db, 'host_metrics_history')).toBe(1);

    const { db: db2 } = freshDb();
    persistHostReports(db2, [sampleReport()]);
    expect(count(db2, 'host_metrics_history')).toBe(1);
  });
});

describe('host_check_snapshot', () => {
  it('replaces the snapshot and returns rows ordered by check name', () => {
    const { db } = freshDb();
    saveHostCheckResults(db, 'host-a', [
      { name: 'ping', type: 'icmp', target: '10.0.0.1', status: 'up', latency_ms: 1.2, checked_at: '2026-01-02T03:04:05.000000+00:00' },
      { name: 'http', type: 'http', target: 'http://x', status: 'down', message: 'timeout' },
    ]);

    const rows = getHostCheckResults(db, 'host-a');
    expect(rows.map((r) => r.check_name)).toEqual(['http', 'ping']);
    const http = rows[0];
    expect(http.message).toBe('timeout');
    expect(http.latency_ms).toBeNull();
    expect(http.checked_at).toMatch(STRICT_ISO); // defaulted to now
    expect(rows[1].latency_ms).toBe(1.2);
    expect(rows[1].message).toBe('');

    // Re-saving replaces the whole snapshot for the host.
    saveHostCheckResults(db, 'host-a', [
      { name: 'ping', type: 'icmp', target: '10.0.0.1', status: 'up' },
    ]);
    expect(count(db, 'host_check_snapshot')).toBe(1);
  });

  it('groups the latest snapshot for every host', () => {
    const { db } = freshDb();
    saveHostCheckResults(db, 'host-b', [{ name: 'ping', type: 'icmp', target: 'b', status: 'up' }]);
    saveHostCheckResults(db, 'host-a', [
      { name: 'ping', type: 'icmp', target: 'a', status: 'up' },
      { name: 'dns', type: 'dns', target: 'a', status: 'up' },
    ]);

    const all = getAllHostCheckResults(db);
    expect(Object.keys(all).sort()).toEqual(['host-a', 'host-b']);
    expect(all['host-a'].map((r) => r.check_name)).toEqual(['dns', 'ping']);
    expect(all['host-b']).toHaveLength(1);
  });

  it('rolls back the whole replacement when an insert fails', () => {
    const { db } = freshDb();
    saveHostCheckResults(db, 'host-a', [
      { name: 'ping', type: 'icmp', target: 'a', status: 'up' },
    ]);

    expect(() =>
      saveHostCheckResults(db, 'host-a', [
        { name: null as unknown as string, type: 'icmp', target: 'a', status: 'up' },
      ]),
    ).toThrow();

    // The previous snapshot survives (BEGIN IMMEDIATE rolled back).
    const rows = getHostCheckResults(db, 'host-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].check_name).toBe('ping');
  });

  it('deletes both the snapshot and the history for a host', () => {
    const { db } = freshDb();
    saveHostCheckResults(db, 'host-a', [{ name: 'ping', type: 'icmp', target: 'a', status: 'up' }]);
    db.prepare(
      'INSERT INTO host_check_history (host_name, check_name, status, checked_at) VALUES (?, ?, ?, ?)',
    ).run('host-a', 'ping', 'up', '2026-01-02T03:04:05.000000+00:00');
    db.prepare(
      'INSERT INTO host_check_history (host_name, check_name, status, checked_at) VALUES (?, ?, ?, ?)',
    ).run('host-b', 'ping', 'up', '2026-01-02T03:04:05.000000+00:00');

    deleteHostCheckResults(db, 'host-a');
    expect(count(db, 'host_check_snapshot')).toBe(0);
    const history = db.prepare('SELECT host_name FROM host_check_history').all() as Array<{ host_name: string }>;
    expect(history.map((h) => h.host_name)).toEqual(['host-b']);
  });
});

describe('network rates', () => {
  function insertHistory(
    db: TestDb,
    hostName: string,
    collectedAt: string,
    rx: number | null,
    tx: number | null,
    success = 1,
  ): void {
    db.prepare(
      `INSERT INTO host_metrics_history (collected_at, host_name, host, success, net_rx_bytes, net_tx_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(collectedAt, hostName, 'h', success, rx, tx);
  }

  it('computes rx/tx rates from the two most recent samples, nulling a counter reset', () => {
    const { db } = freshDb();
    insertHistory(db, 'host-a', '2026-01-02T03:04:05.000000+00:00', 1000, 5000);
    insertHistory(db, 'host-a', '2026-01-02T03:04:15.000000+00:00', 2000, 4000);

    const rate = fetchHostNetworkRates(db, 'host-a');
    expect(rate.rx_bytes_per_second).toBe(100); // (2000 - 1000) / 10s
    expect(rate.tx_bytes_per_second).toBeNull(); // negative delta -> reset
  });

  it('returns nulls when fewer than two samples exist', () => {
    const { db } = freshDb();
    insertHistory(db, 'host-a', '2026-01-02T03:04:05.000000+00:00', 1000, 5000);
    expect(fetchHostNetworkRates(db, 'host-a')).toEqual({
      rx_bytes_per_second: null,
      tx_bytes_per_second: null,
    });
  });

  it('ignores unsuccessful samples', () => {
    const { db } = freshDb();
    insertHistory(db, 'host-a', '2026-01-02T03:04:05.000000+00:00', 1000, 5000, 0);
    insertHistory(db, 'host-a', '2026-01-02T03:04:15.000000+00:00', 2000, 6000, 0);
    expect(fetchHostNetworkRates(db, 'host-a')).toEqual({
      rx_bytes_per_second: null,
      tx_bytes_per_second: null,
    });
  });

  it('fetches rates for every host in one query', () => {
    const { db } = freshDb();
    insertHistory(db, 'host-a', '2026-01-02T03:04:05.000000+00:00', 0, 0);
    insertHistory(db, 'host-a', '2026-01-02T03:04:15.000000+00:00', 500, 1000);
    insertHistory(db, 'host-b', '2026-01-02T03:04:05.000000+00:00', 10, 10); // only one sample

    const rates = fetchAllHostNetworkRates(db);
    expect(Object.keys(rates).sort()).toEqual(['host-a', 'host-b']);
    expect(rates['host-a'].rx_bytes_per_second).toBe(50); // 500 / 10s
    expect(rates['host-a'].tx_bytes_per_second).toBe(100); // 1000 / 10s
    expect(rates['host-b']).toEqual({ rx_bytes_per_second: null, tx_bytes_per_second: null });
  });

  it('returns an empty map when there is no history', () => {
    const { db } = freshDb();
    expect(fetchAllHostNetworkRates(db)).toEqual({});
    expect(getAllHostCheckResults(db)).toEqual({});
    expect(getHostCheckResults(db, 'x')).toEqual([]);
  });
});
