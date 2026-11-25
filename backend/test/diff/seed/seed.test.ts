/**
 * Contract tests for the shared differential-e2e seed database (P7 Task1).
 *
 * The fixture is produced by `backend/test/diff/seed/build_seed.py`, which
 * drives the *real* `servermanage.storage` writers so that the single SQLite
 * file can be read by both the Python service and the Node backend.
 *
 * Regenerate with:
 *   cd backend && python test/diff/seed/build_seed.py
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const DB_PATH = path.resolve(__dirname, '../../fixtures/seed/servermonitor-seed.db');

/** Every timestamp written by the Python side must use this exact shape. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

if (!existsSync(DB_PATH)) {
  throw new Error(
    `Seed database not found: ${DB_PATH}\n` +
      `Generate it first with:\n  cd backend && python test/diff/seed/build_seed.py`,
  );
}

type Row = Record<string, any>;

let db: Database.Database;

beforeAll(() => {
  db = new Database(DB_PATH, { fileMustExist: true });
});

afterAll(() => {
  db?.close();
});

function rows(sql: string, params: unknown[] = []): Row[] {
  return db.prepare(sql).all(...(params as any[])) as Row[];
}

function one(sql: string, params: unknown[] = []): Row {
  return db.prepare(sql).get(...(params as any[])) as Row;
}

function count(table: string): number {
  return one(`SELECT COUNT(*) AS n FROM ${table}`).n as number;
}

describe('seed database file', () => {
  it('exists and has a sane size (< 2 MiB)', () => {
    const size = statSync(DB_PATH).size;
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(2 * 1024 * 1024);
  });

  it('is a WAL database', () => {
    expect(String(db.pragma('journal_mode', { simple: true }))).toBe('wal');
  });

  it('advertises schema user_version >= 1', () => {
    expect(Number(db.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(1);
  });
});

describe('hosts and latest snapshots', () => {
  it('contains the three seeded hosts in host_latest_snapshot', () => {
    expect(count('host_latest_snapshot')).toBeGreaterThanOrEqual(3);
    const names = rows('SELECT host_name FROM host_latest_snapshot ORDER BY host_name').map(
      (r) => r.host_name,
    );
    expect(names.sort()).toEqual(['gpu-01', 'lab-01', 'lab-02']);
  });

  it('every latest snapshot carries cpu / memory / disk / gpu data', () => {
    for (const row of rows('SELECT host_name, raw_json FROM host_latest_snapshot')) {
      const obj = JSON.parse(row.raw_json);
      expect(obj.metrics, `${row.host_name} metrics`).toBeTruthy();
      expect(typeof obj.metrics.cpu_usage_percent, `${row.host_name} cpu`).toBe('number');
      expect(obj.metrics.memory, `${row.host_name} memory`).toBeTruthy();
      expect(Array.isArray(obj.metrics.disk_usage), `${row.host_name} disk`).toBe(true);
      expect(obj.metrics.disk_usage.length, `${row.host_name} disk rows`).toBeGreaterThan(0);
      expect(Array.isArray(obj.metrics.gpu_summary), `${row.host_name} gpu`).toBe(true);
      expect(obj.metrics.gpu_summary.length, `${row.host_name} gpu rows`).toBeGreaterThan(0);
    }
  });
});

describe('host_metrics_history coverage', () => {
  it('has at least 90 rows per host', () => {
    expect(count('host_metrics_history')).toBeGreaterThanOrEqual(270);
    for (const row of rows(
      'SELECT host_name, COUNT(*) AS n FROM host_metrics_history GROUP BY host_name',
    )) {
      expect(row.n, `${row.host_name} rows`).toBeGreaterThanOrEqual(90);
    }
  });

  it('covers 90 distinct days overall', () => {
    const span = one(
      `SELECT COUNT(DISTINCT substr(collected_at,1,10)) AS days,
              MIN(collected_at) AS lo, MAX(collected_at) AS hi
         FROM host_metrics_history`,
    );
    expect(span.days).toBe(90);
    expect(span.lo <= span.hi).toBe(true);
  });

  it('has at least one sample per host per day across all 90 days', () => {
    const perHost = rows(
      `SELECT host_name, COUNT(DISTINCT substr(collected_at,1,10)) AS days
         FROM host_metrics_history GROUP BY host_name`,
    );
    expect(perHost.length).toBe(3);
    for (const row of perHost) {
      expect(row.days, `${row.host_name} day coverage`).toBe(90);
    }
  });

  it('CPU shows a slow upward trend (non-empty capacity slope)', () => {
    const hosts = rows('SELECT DISTINCT host_name FROM host_metrics_history').map(
      (r) => r.host_name,
    );
    expect(hosts.length).toBe(3);
    for (const host of hosts) {
      const first = one(
        'SELECT cpu_usage_percent AS v FROM host_metrics_history WHERE host_name=? ORDER BY collected_at ASC LIMIT 1',
        [host],
      );
      const last = one(
        'SELECT cpu_usage_percent AS v FROM host_metrics_history WHERE host_name=? ORDER BY collected_at DESC LIMIT 1',
        [host],
      );
      expect(typeof first.v, `${host} first cpu`).toBe('number');
      expect(typeof last.v, `${host} last cpu`).toBe('number');
      expect(last.v, `${host} cpu trend`).toBeGreaterThan(first.v);
    }
  });
});

describe('alerts', () => {
  it('has at least one alert in each status', () => {
    const byStatus: Record<string, number> = {};
    for (const row of rows('SELECT status, COUNT(*) AS n FROM alerts GROUP BY status')) {
      byStatus[row.status] = row.n;
    }
    expect(byStatus.active ?? 0).toBeGreaterThanOrEqual(1);
    expect(byStatus.acknowledged ?? 0).toBeGreaterThanOrEqual(1);
    expect(byStatus.resolved ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('covers system and disk categories', () => {
    const cats = rows('SELECT DISTINCT category FROM alerts').map((r) => r.category);
    expect(cats).toContain('system');
    expect(cats).toContain('disk');
  });

  it('acknowledged/resolved alerts carry an ack_at timestamp', () => {
    const acked = rows(
      "SELECT ack_at FROM alerts WHERE status IN ('acknowledged','resolved')",
    );
    expect(acked.length).toBeGreaterThanOrEqual(2);
    for (const row of acked) {
      expect(typeof row.ack_at).toBe('string');
    }
  });
});

describe('alert silences', () => {
  it('has one silence scoped to a host or all, valid for <= ~30 days', () => {
    expect(count('alert_silences')).toBeGreaterThanOrEqual(1);
    for (const row of rows('SELECT scope_type, scope, starts_at, ends_at FROM alert_silences')) {
      expect(['host', 'all']).toContain(row.scope_type);
      const start = Date.parse(row.starts_at);
      const end = Date.parse(row.ends_at);
      expect(Number.isNaN(start), 'starts_at parses').toBe(false);
      expect(Number.isNaN(end), 'ends_at parses').toBe(false);
      expect(end).toBeGreaterThan(start);
      expect(end - start).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
    }
  });
});

describe('disk health and user snapshots', () => {
  it('has a disk_health snapshot with controller/vd/pd detail', () => {
    expect(count('disk_health_snapshot')).toBeGreaterThanOrEqual(1);
    expect(count('disk_controller_snapshot')).toBeGreaterThanOrEqual(1);
    expect(count('disk_vd_snapshot')).toBeGreaterThanOrEqual(1);
    expect(count('disk_pd_snapshot')).toBeGreaterThanOrEqual(1);
  });

  it('has a user snapshot and a user baseline', () => {
    expect(count('host_user_snapshot')).toBeGreaterThanOrEqual(1);
    expect(count('host_user_baseline')).toBeGreaterThanOrEqual(1);
  });
});

describe('app_settings', () => {
  it('stores monitoring.timezone = Asia/Shanghai', () => {
    const row = one("SELECT payload FROM app_settings WHERE section='monitoring'");
    expect(row).toBeTruthy();
    expect(JSON.parse(row.payload).timezone).toBe('Asia/Shanghai');
  });

  it('stores alerts defaults (enabled + cpu threshold)', () => {
    const row = one("SELECT payload FROM app_settings WHERE section='alerts'");
    expect(row).toBeTruthy();
    const payload = JSON.parse(row.payload);
    expect(payload.enabled).toBe(true);
    expect(payload.thresholds.cpu_percent).toBe(90);
  });
});

describe('timestamp format', () => {
  const timestampColumns: Array<[string, string]> = [
    ['host_metrics_history', 'collected_at'],
    ['host_latest_snapshot', 'collected_at'],
    ['host_daily_summary', 'updated_at'],
    ['disk_health_snapshot', 'collected_at'],
    ['disk_controller_snapshot', 'collected_at'],
    ['disk_vd_snapshot', 'collected_at'],
    ['disk_pd_snapshot', 'collected_at'],
    ['alerts', 'created_at'],
    ['alerts', 'ack_at'],
    ['alert_silences', 'starts_at'],
    ['alert_silences', 'ends_at'],
    ['alert_silences', 'created_at'],
    ['app_settings', 'updated_at'],
    ['host_user_snapshot', 'collected_at'],
    ['host_user_baseline', 'first_seen_at'],
    ['host_user_baseline', 'last_seen_at'],
    ['host_user_scan_state', 'last_scan_at'],
    ['host_user_scan_state', 'last_usage_at'],
  ];

  for (const [table, column] of timestampColumns) {
    it(`${table}.${column} is ISO-8601 UTC with microseconds`, () => {
      const values = rows(
        `SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL`,
      ).map((r) => r.v);
      expect(values.length, `${table}.${column} has values`).toBeGreaterThan(0);
      for (const value of values) {
        expect(value, `${table}.${column}`).toMatch(ISO_RE);
      }
    });
  }
});
