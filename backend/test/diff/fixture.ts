/**
 * Deterministic fixture used by the storage differential tests.
 *
 * The database is built in a throw-away temp directory with the *production*
 * `initSchema` + plain `INSERT`s (so the on-disk layout is exactly what both
 * stacks expect), checkpointed out of WAL and switched back to a
 * rollback-journal so the Python read-only subprocess sees a plain file. It is
 * never committed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase } from '../../src/storage/db';
import { dumpJson } from '../../src/storage/json';
import { initSchema } from '../../src/storage/schema';

export interface Fixture {
  dbPath: string;
  dir: string;
  cleanup(): void;
}

const ISO = (stamp: string): string => stamp; // documents strict-ISO literals below

/** Seeds every table touched by the covered read paths. */
function seed(db: ReturnType<typeof openDatabase>): void {
  // --- app_settings -------------------------------------------------------
  const insertSetting = db.prepare(
    'INSERT INTO app_settings (section, payload, updated_at) VALUES (?, ?, ?)',
  );
  insertSetting.run(
    'general',
    dumpJson({
      theme: 'dark',
      locale: 'zh-CN',
      note: '实验室服务器轮询',
      nested: { retries: 3, backoff: [1, 2, 4], flags: { beta: true, legacy: false } },
      thresholds: { cpu: 85.5, disk: 90, memory: 75.25 },
    }),
    ISO('2026-01-01T00:00:00.000000+00:00'),
  );
  insertSetting.run(
    'alerts',
    dumpJson({
      email: 'ops@example.com',
      enabled: true,
      channels: ['email', 'webhook'],
      quiet_hours: { start: '22:00', end: '07:00' },
    }),
    ISO('2026-01-02T00:00:00.000000+00:00'),
  );
  insertSetting.run('empty', dumpJson({}), ISO('2026-01-03T00:00:00.000000+00:00'));

  // --- app_secrets (names only are compared) -----------------------------
  const insertSecret = db.prepare(
    'INSERT INTO app_secrets (name, ciphertext, updated_at) VALUES (?, ?, ?)',
  );
  insertSecret.run('z_api_key', Buffer.from([1, 2, 3, 4]), ISO('2026-01-01T00:00:00.000000+00:00'));
  insertSecret.run('a_token', Buffer.from([9, 8, 7]), ISO('2026-01-01T00:00:00.000000+00:00'));
  insertSecret.run(
    'm_ssh_passphrase',
    Buffer.from([0, 255, 128]),
    ISO('2026-01-01T00:00:00.000000+00:00'),
  );

  // --- host_latest_snapshot ----------------------------------------------
  const insertSnapshot = db.prepare(
    'INSERT INTO host_latest_snapshot (host_name, collected_at, success, raw_json) VALUES (?, ?, ?, ?)',
  );
  insertSnapshot.run(
    'host-a',
    ISO('2026-01-15T09:10:00.123456+00:00'),
    1,
    dumpJson({
      metrics: {
        collected_at: '2026-01-15T09:10:00.123456+00:00',
        cpu_usage_percent: 42.5,
        memory: { used_mb: 2048, total_mb: 8192 },
        load_average: { load_1: 1.5, load_5: 1.25, load_15: 1 },
        disk_usage: [{ filesystem: '/dev/sda1', mountpoint: '/', percent: '60%' }],
        gpu_summary: [
          { utilization_percent: 30, temperature_c: 55, memory_used_mb: 1000, memory_total_mb: 4000 },
        ],
        total_processes: 130,
        logged_in_users: [{ username: 'alice' }],
        net_rx_bytes: 1000,
        net_tx_bytes: 2000,
        thermal_zones: [{ celsius: 45.5 }],
      },
      errors: [],
    }),
  );
  insertSnapshot.run(
    'host-b',
    ISO('2026-01-15T09:20:00.000000+00:00'),
    0,
    dumpJson({
      metrics: {
        collected_at: '2026-01-15T09:20:00.000000+00:00',
        cpu_usage_percent: 7,
        memory: { used_mb: 1, total_mb: 2 },
      },
      errors: [{ source: 'gpu', message: '不可用' }],
    }),
  );

  // --- alerts -------------------------------------------------------------
  const insertAlert = db.prepare(
    `INSERT INTO alerts (
        created_at, host_name, category, severity, title, message, fingerprint,
        status, notified_channels, ack_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // ids are assigned 1..4 in this insertion order; ties on created_at are
  // broken by id DESC in the oracle's ORDER BY.
  insertAlert.run(
    ISO('2026-01-10T00:00:00.000000+00:00'),
    'host-a',
    'disk',
    'warning',
    'Disk usage high',
    '/data at 91%',
    'disk:/data',
    'active',
    dumpJson(['email']),
    null,
  );
  insertAlert.run(
    ISO('2026-01-11T00:00:00.000000+00:00'),
    'host-b',
    'cpu',
    'critical',
    'CPU pegged',
    'cpu 99% for 5m',
    'cpu:99',
    'active',
    null,
    null,
  );
  insertAlert.run(
    ISO('2026-01-12T00:00:00.000000+00:00'),
    'host-a',
    'memory',
    'warning',
    'Memory rising',
    'memory 80%',
    'memory:80',
    'closed',
    dumpJson(['email', 'webhook']),
    ISO('2026-01-12T01:00:00.000000+00:00'),
  );
  insertAlert.run(
    ISO('2026-01-11T00:00:00.000000+00:00'),
    'host-a',
    'cpu',
    'warning',
    'CPU warm',
    'cpu 70%',
    'cpu:70',
    'active',
    null,
    null,
  );

  // --- host_metrics_history ----------------------------------------------
  const insertHistory = db.prepare(
    `INSERT INTO host_metrics_history (
        collected_at, host_name, host, success, cpu_usage_percent,
        memory_used_mb, memory_total_mb, disk_used_percent, gpu_utilization_percent,
        gpu_memory_used_mb, gpu_memory_total_mb, total_processes, logged_in_user_count,
        load_1, net_rx_bytes, net_tx_bytes, temperature_c
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertHistory.run(
    ISO('2026-01-15T09:00:00.000000+00:00'), 'host-a', '10.0.0.1', 1, 10,
    100, 1000, 20, 30, 1000, 4000, 120, 2, 0.5, 1000, 2000, 45,
  );
  insertHistory.run(
    ISO('2026-01-15T09:10:00.123456+00:00'), 'host-a', '10.0.0.1', 1, 20,
    200, 1000, 30, 40, 2000, 4000, 130, 3, 0.5, 2200, 3200, 46,
  );
  // success = 0 must be ignored by the 24h reader.
  insertHistory.run(
    ISO('2026-01-15T09:05:00.000000+00:00'), 'host-a', '10.0.0.1', 0, 99,
    null, null, null, null, null, null, null, null, null, null, null, null,
  );
  // Older than the 24h cutoff (now - 24h = 2026-01-14T12:00).
  insertHistory.run(
    ISO('2026-01-13T00:00:00.000000+00:00'), 'host-a', '10.0.0.1', 1, 1,
    1, 100, 1, 1, 1, 100, 1, 1, 0.1, 10, 10, 30,
  );
  // A different host, must not leak into host-a's history.
  insertHistory.run(
    ISO('2026-01-15T09:20:00.000000+00:00'), 'host-b', '10.0.0.2', 1, 55,
    500, 1000, 40, 60, 2000, 4000, 90, 1, 1.0, 500, 900, 50,
  );

  // --- host_daily_summary ------------------------------------------------
  const insertSummary = db.prepare(
    `INSERT INTO host_daily_summary (
        day, host_name, tz, host, sample_count, success_count,
        cpu_sum, cpu_max, cpu_min, memory_pct_sum, memory_pct_max,
        disk_pct_sum, disk_pct_max, gpu_util_sum, gpu_util_max,
        gpu_memory_pct_sum, gpu_memory_pct_max, load_sum, users_sum,
        processes_sum, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const summary = (
    day: string,
    host_name: string,
    host: string,
    sample_count: number,
    cpu_sum: number,
    memory_pct_sum: number,
    disk_pct_sum: number,
    gpu_util_sum: number,
    gpu_memory_pct_sum: number,
    load_sum: number,
  ): void => {
    insertSummary.run(
      day, host_name, 'UTC', host, sample_count, sample_count,
      cpu_sum, cpu_sum, cpu_sum / sample_count, memory_pct_sum, memory_pct_sum,
      disk_pct_sum, disk_pct_sum, gpu_util_sum, gpu_util_sum,
      gpu_memory_pct_sum, gpu_memory_pct_sum, load_sum, sample_count,
      sample_count * 10, ISO('2026-01-15T00:00:00.000000+00:00'),
    );
  };
  summary('2026-01-09', 'host-a', '10.0.0.1', 2, 30, 100, 40, 60, 50, 1.0);
  summary('2026-01-10', 'host-a', '10.0.0.1', 4, 80, 200, 80, 80, 100, 2.0);
  summary('2026-01-11', 'host-a', '10.0.0.1', 1, 10, 50, 20, 30, 25, 0.5);
  summary('2026-01-10', 'host-b', '10.0.0.2', 2, 20, 60, 60, 40, 40, 1.5);
  // Outside the daily-week window but inside the 7d history window.
  summary('2026-01-12', 'host-a', '10.0.0.1', 3, 60, 150, 60, 60, 75, 1.5);
}

/** Builds a fresh fixture database and returns its path plus a cleanup hook. */
export function buildFixture(): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-diff-'));
  const dbPath = path.join(dir, 'servermonitor.db');
  const db = openDatabase(dbPath);
  try {
    initSchema(db);
    seed(db);
    // Fold WAL pages back into the main file, then drop WAL so the read-only
    // Python subprocess can open a plain rollback-journal database.
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  return {
    dbPath,
    dir,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
