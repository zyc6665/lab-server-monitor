/**
 * Host-detail backend completion tests.
 *
 * Covers the fields that were missing from `buildHostDetail` (network rates,
 * user rows, diagnostics, alert days, collection uptime / uptime strip and
 * check history) plus the restored report sections. The first half drives the
 * exported builder directly against a temp SQLite database; the second half
 * exercises the hosts-route local fallback (`buildHostDetailLocal` /
 * `buildHostReportLocal`) through the real HTTP endpoints.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { createWebApp } from '../../src/web/app';
import { registerHostsRoutes } from '../../src/web/routes/hosts';
import { buildHostDetail, buildHostReport } from '../../src/web/routes/overview';
import { buildHostDiagnostics, hostAlertDays, summarizeDiagnostics } from '../../src/web/host-diagnostics';
import { setAdminPassword } from '../../src/web/routes/auth';
import { upsertHost } from '../../src/config/hosts';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import {
  getHostCheckResults,
  getHostSnapshot,
  persistHostReports,
  saveHostCheckResults,
  saveHostSnapshot,
} from '../../src/storage/hosts';
import { appendHostCheckHistory } from '../../src/storage/metrics-write';
import { saveHostUserSnapshot } from '../../src/storage/users';
import { insertAlert } from '../../src/storage/alerts';
import { nowIsoUtc } from '../../src/storage/time';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

type Obj = Record<string, unknown>;

afterEach(() => {
  cleanupStorageTests();
});

function makeServer(overrides: Partial<HostConfig> & { name: string; host: string }): HostConfig {
  return {
    name: overrides.name,
    host: overrides.host,
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/', '/data'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/host-detail-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/** Metrics that intentionally trip the CPU warning diagnostic. */
function baseMetrics(collectedAt: string) {
  return {
    collected_at: collectedAt,
    cpu_usage_percent: 95,
    cpu_core_count: 4,
    uptime: '3 days',
    memory: { total_mb: 1000, used_mb: 500 },
    load_average: { load_1: 1.2, load_5: 1.0, load_15: 0.8 },
    disk_usage: [
      { filesystem: '/dev/sda1', mountpoint: '/', used: '10G', size: '20G', percent: '50%' },
    ],
    gpu_summary: [
      {
        index: 0,
        name: 'Tesla T4',
        utilization_percent: 10,
        memory_used_mb: 1000,
        memory_total_mb: 4000,
        temperature_c: 50,
      },
    ],
    logged_in_users: [{ username: 'root', terminal: 'pts/0' }],
    thermal_zones: [{ celsius: 55 }],
    net_rx_bytes: 0,
    net_tx_bytes: 0,
    containers: [],
  };
}

interface DetailFixture {
  fresh: FreshDb;
  config: AppConfig;
  now: Date;
  snapshot: ReturnType<typeof getHostSnapshot>;
  checks: ReturnType<typeof getHostCheckResults>;
}

/** Seeds snapshot + user rows + check history + two network samples for `alpha`. */
function seedDetailFixture(): DetailFixture {
  const fresh = freshDb();
  const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1', group: 'Web' })]);
  const now = new Date();
  const collectedAt = nowIsoUtc(now);

  saveHostSnapshot(fresh.db, {
    host_name: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: baseMetrics(collectedAt) as never,
  });

  // Two successful history samples 60s apart: rx 1000 -> 4000, tx 2000 -> 5000.
  const previousAt = new Date(now.getTime() - 60_000).toISOString();
  persistHostReports(fresh.db, [
    {
      host_name: 'alpha',
      host: '10.0.0.1',
      success: true,
      metrics: {
        ...baseMetrics(previousAt),
        net_rx_bytes: 1000,
        net_tx_bytes: 2000,
      } as never,
    },
    {
      host_name: 'alpha',
      host: '10.0.0.1',
      success: true,
      metrics: {
        ...baseMetrics(collectedAt),
        net_rx_bytes: 4000,
        net_tx_bytes: 5000,
      } as never,
    },
  ]);

  saveHostUserSnapshot(fresh.db, 'alpha', [
    {
      username: 'alice',
      uid: 1001,
      gid: 1001,
      home: '/home/alice',
      shell: '/bin/bash',
      in_docker: true,
      home_exists: true,
      home_owner: 'alice',
      home_size_bytes: 1234,
      data_supported: false,
      collected_at: collectedAt,
    },
    {
      username: 'bob',
      uid: 1002,
      gid: 1002,
      home: '/home/bob',
      shell: '/bin/sh',
      in_docker: false,
      home_exists: false,
      data_supported: false,
      collected_at: collectedAt,
    },
  ]);

  saveHostCheckResults(fresh.db, 'alpha', [
    { name: 'ssh', type: 'tcp', target: '22', status: 'ok', latency_ms: 12 },
    { name: 'http', type: 'http', target: 'http://10.0.0.1', status: 'failed', message: 'down' },
  ]);
  appendHostCheckHistory(fresh.db, 'alpha', [
    { name: 'ssh', status: 'ok' },
    { name: 'http', status: 'failed' },
  ]);

  return {
    fresh,
    config,
    now,
    snapshot: getHostSnapshot(fresh.db, 'alpha'),
    checks: getHostCheckResults(fresh.db, 'alpha'),
  };
}

function buildFixtureDetail(fixture: DetailFixture, alerts: Obj[] = []) {
  return buildHostDetail(
    'alpha',
    fixture.config,
    fixture.fresh.db,
    fixture.snapshot,
    undefined,
    alerts,
    fixture.checks,
    'Asia/Shanghai',
    600,
    {},
    fixture.now,
  );
}

describe('buildHostDetail — network rates', () => {
  it('derives rx/tx bytes per second from the two newest samples', () => {
    const fixture = seedDetailFixture();
    const detail = buildFixtureDetail(fixture);

    expect(detail.network).toEqual({ rx_bytes_per_second: 50, tx_bytes_per_second: 50 });
  });
});

describe('buildHostDetail — user rows', () => {
  it('returns present rows sorted by username with the full usage shape', () => {
    const fixture = seedDetailFixture();
    const detail = buildFixtureDetail(fixture);

    expect(detail.users.map((row) => row['username'])).toEqual(['alice', 'bob']);
    const alice = detail.users.find((row) => row['username'] === 'alice') as Obj;
    expect(alice['state']).toBe('present');
    expect(alice['host_name']).toBe('alpha');
    expect(alice).toHaveProperty('usage_delta_bytes');
    expect(alice).toHaveProperty('gpu_memory_mb');
    expect(alice['issues']).toEqual([]);

    const bob = detail.users.find((row) => row['username'] === 'bob') as Obj;
    expect(bob['issues']).toEqual(expect.arrayContaining(['docker', 'home']));
  });
});

describe('buildHostDetail — collection uptime / uptime strip / check history', () => {
  it('reports sample counts, the expected cadence and the grouped check history', () => {
    const fixture = seedDetailFixture();
    const detail = buildFixtureDetail(fixture);

    expect(detail.collection_uptime).toEqual({ samples: 2, expected: 144 });
    expect(detail.uptime_strip.samples).toBe(2);
    expect(detail.uptime_strip.buckets).toHaveLength(96);
    expect(detail.uptime_strip.hours).toBe(24);
    expect(detail.uptime_strip.bucket_minutes).toBe(15);

    expect(detail.check_history).toEqual({ ssh: ['ok'], http: ['failed'] });
  });
});

describe('buildHostDetail — alert days', () => {
  it('buckets the last seven local days with severity counts and a scaled bar', () => {
    const fixture = seedDetailFixture();
    const now = fixture.now;
    const alerts: Obj[] = [
      { created_at: new Date(now.getTime()).toISOString(), severity: 'critical', title: 'a', status: 'active' },
      { created_at: new Date(now.getTime() - 60_000).toISOString(), severity: 'warning', title: 'b', status: 'active' },
      {
        created_at: new Date(now.getTime() - 8 * 86_400_000).toISOString(),
        severity: 'critical',
        title: 'old',
        status: 'resolved',
      },
    ];

    const detail = buildFixtureDetail(fixture, alerts);
    expect(detail.alert_days).toHaveLength(7);
    const today = detail.alert_days[6];
    expect(today.total).toBe(2);
    expect(today.critical).toBe(1);
    expect(today.warning).toBe(1);
    expect(today.info).toBe(0);
    expect(today.height).toBe(100);
    expect(detail.alert_days[0].total).toBe(0);
  });
});

describe('buildHostDiagnostics / summarizeDiagnostics', () => {
  it('raises a CPU warning and keeps the summary consistent', () => {
    const rows = buildHostDiagnostics(
      {
        success: true,
        collected_at: new Date().toISOString(),
        metrics: {
          cpu_usage_percent: 95,
          cpu_core_count: 4,
          memory: { total_mb: 1000, used_mb: 500 },
          load_average: { load_1: 1.2 },
          thermal_zones: [{ celsius: 55 }],
        },
        checks: [{ check_name: 'ssh', status: 'ok' }],
        users: [{ username: 'alice', issues: [] }],
        collection_uptime: { samples: 9, expected: 10 },
      },
      { pollIntervalSeconds: 600 },
    );

    const cpu = rows.find((row) => row.key === 'cpu');
    expect(cpu).toMatchObject({ level: 'warn', title: 'CPU 使用率' });

    const summary = summarizeDiagnostics(rows);
    expect(summary.crit).toBe(0);
    expect(summary.warn).toBe(1);
    expect(summary.attention).toBe(1);
    expect(summary.ok + summary.warn + summary.crit).toBe(rows.length);
  });

  it('marks a failed collection as critical', () => {
    const rows = buildHostDiagnostics({
      success: false,
      errors: [{ stage: 'ssh', message: 'timeout' }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'collect',
      level: 'crit',
      title: '最近一次采集失败',
    });
    expect(rows[0].detail).toContain('ssh');
    expect(rows[0].detail).toContain('timeout');
    expect(summarizeDiagnostics(rows)).toEqual({ crit: 1, warn: 0, ok: 0, attention: 1 });
  });
});

describe('buildHostReport — restored sections', () => {
  it('renders disk mounts, sessions, alerts and attention sections', () => {
    const fixture = seedDetailFixture();
    const alerts: Obj[] = [
      {
        created_at: new Date(fixture.now.getTime()).toISOString(),
        severity: 'critical',
        title: 'CPU 使用率过高',
        message: 'CPU 95%',
        status: 'active',
      },
    ];
    const detail = buildFixtureDetail(fixture, alerts);
    const text = buildHostReport(detail, fixture.now, 'Asia/Shanghai', true);

    expect(text).toContain('主机诊断报告');
    expect(text).toContain('[系统概览]');
    expect(text).toContain('[磁盘挂载]');
    expect(text).toContain('[当前登录用户]');
    expect(text).toContain('[最近告警]');
    expect(text).toContain('[重点关注]');
    expect(text).toContain('alpha');
  });
});

// --- hosts-route local fallback (buildHostDetailLocal / buildHostReportLocal) ---

function makeAppHarness(): { fresh: FreshDb; app: Express; cookie: string; config: AppConfig } {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'pw-admin', username: 'admin' });
  const config = makeConfig([]);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerHostsRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: 'csrf-test',
  });
  return { fresh, app, cookie, config };
}

function seedHostRow(
  harness: { fresh: FreshDb; config: AppConfig },
  name: string,
): void {
  upsertHost(
    harness.fresh.db,
    {
      name,
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: 'pw',
    } as never,
    { writable: true, baseServers: harness.config.servers },
  );
}

describe('hosts route local fallback — /api/host/:name', () => {
  it('returns network, users, diagnostics and alert_days without the overview builders', async () => {
    const harness = makeAppHarness();
    seedHostRow(harness, 'alpha');
    const now = new Date();
    const collectedAt = nowIsoUtc(now);
    saveHostSnapshot(harness.fresh.db, {
      host_name: 'alpha',
      host: '10.0.0.1',
      success: true,
      metrics: baseMetrics(collectedAt) as never,
    });
    persistHostReports(harness.fresh.db, [
      {
        host_name: 'alpha',
        host: '10.0.0.1',
        success: true,
        metrics: { ...baseMetrics(new Date(now.getTime() - 60_000).toISOString()), net_rx_bytes: 1000, net_tx_bytes: 2000 } as never,
      },
      {
        host_name: 'alpha',
        host: '10.0.0.1',
        success: true,
        metrics: { ...baseMetrics(collectedAt), net_rx_bytes: 4000, net_tx_bytes: 5000 } as never,
      },
    ]);
    saveHostUserSnapshot(harness.fresh.db, 'alpha', [
      { username: 'alice', uid: 1001, gid: 1001, in_docker: true, home_exists: true, home_owner: 'alice', data_supported: false },
    ]);
    appendHostCheckHistory(harness.fresh.db, 'alpha', [{ name: 'ssh', status: 'ok' }]);
    insertAlert(harness.fresh.db, {
      host_name: 'alpha',
      category: 'cpu',
      severity: 'critical',
      title: 'CPU 使用率过高',
      message: 'CPU 95%',
      fingerprint: 'alpha-cpu',
    });

    const res = await request(harness.app)
      .get('/api/host/alpha')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', 'csrf-test');

    expect(res.status).toBe(200);
    expect(res.body.network).toEqual({ rx_bytes_per_second: 50, tx_bytes_per_second: 50 });
    expect(res.body.users.map((row: Obj) => row['username'])).toEqual(['alice']);
    expect(Array.isArray(res.body.diagnostics)).toBe(true);
    expect(res.body.diagnostics.length).toBeGreaterThan(0);
    expect(res.body.diagnostics_summary).toHaveProperty('attention');
    expect(res.body.alert_days).toHaveLength(7);
    expect(res.body.alert_days[6].total).toBe(1);
    expect(res.body.check_history).toEqual({ ssh: ['ok'] });
  });

  it('renders the full report through the shared buildHostReport', async () => {
    const harness = makeAppHarness();
    seedHostRow(harness, 'alpha');
    const collectedAt = nowIsoUtc(new Date());
    saveHostSnapshot(harness.fresh.db, {
      host_name: 'alpha',
      host: '10.0.0.1',
      success: true,
      metrics: baseMetrics(collectedAt) as never,
    });

    const res = await request(harness.app)
      .get('/api/host/alpha/report')
      .set('Cookie', harness.cookie)
      .set('X-CSRF-Token', 'csrf-test');

    expect(res.status).toBe(200);
    expect(res.text).toContain('[系统概览]');
    expect(res.text).toContain('[磁盘挂载]');
    expect(res.text).toContain('[当前登录用户]');
    expect(res.text).toContain('alpha');
  });
});
