/**
 * Integration tests for the overview routes (P2 Task 10).
 *
 * Every case builds the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database and seeds a tiny amount of history/snapshot data so
 * the JSON payloads and the rendered page have something real to show. DPAPI is
 * replaced by an identity stub so the admin credential can be seeded without
 * touching the Windows key store (same stub as `auth.test.ts`).
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

// DPAPI identity stub: protect/unprotect are byte copies so SECRET_ADMIN blobs
// round-trip as raw JSON and `dpapiAvailable()` reports the platform writable.
vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { createWebApp } from '../../src/web/app';
import { registerOverviewRoutes } from '../../src/web/routes/overview';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { saveHostCheckResults, saveHostSnapshot } from '../../src/storage/hosts';
import { saveDiskHealth } from '../../src/storage/disk';
import { insertAlert } from '../../src/storage/alerts';
import { nowIsoUtc } from '../../src/storage/time';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

/** Builds one fully-populated {@link HostConfig} for the fixtures. */
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

/** Two-server config: `alpha` (has data, grouped/tagged) and `beta` (no snapshot). */
function overviewServers(): HostConfig[] {
  return [
    makeServer({
      name: 'alpha',
      host: '10.0.0.1',
      group: 'Web',
      owner: 'ops',
      location: 'DC1',
      tags: ['prod', 'web'],
    }),
    makeServer({ name: 'beta', host: '10.0.0.2' }),
  ];
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/overview-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/** Seeds a snapshot + disk health + checks + one active alert for `alpha`. */
function seedOverviewData(fresh: FreshDb): void {
  const collectedAt = nowIsoUtc(new Date());
  const metrics = {
    collected_at: collectedAt,
    cpu_usage_percent: 42.5,
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
    logged_in_users: [
      { username: 'root', terminal: 'pts/0' },
      { username: 'root', terminal: 'pts/1' },
      { username: 'bob', terminal: 'pts/2' },
    ],
    thermal_zones: [{ celsius: 55 }],
    containers: [],
  };
  saveHostSnapshot(fresh.db, {
    host_name: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: metrics as never,
  });
  saveDiskHealth(fresh.db, {
    host_name: 'alpha',
    collected_at: new Date(),
    status: 'ok',
    physical_drives: [
      { controller: 0, health: 'healthy' },
      { controller: 1, health: 'warning' },
    ],
  });
  saveHostCheckResults(fresh.db, 'alpha', [
    { name: 'ssh', type: 'tcp', target: '22', status: 'ok', latency_ms: 12 },
    { name: 'http', type: 'http', target: 'http://10.0.0.1', status: 'failed', message: 'down' },
  ]);
  insertAlert(fresh.db, {
    host_name: 'alpha',
    category: 'cpu',
    severity: 'critical',
    title: 'CPU 使用率过高',
    message: 'CPU 94%',
    fingerprint: 'alpha-cpu',
  });
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
}

/** Builds a fully wired app (admin seeded, overview routes mounted). */
function setup(options: { authenticate: boolean; seed: boolean }): Harness {
  const fresh = freshDb();
  // Seed the admin credential first so `setupRequired` is false at app build.
  setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
  if (options.seed) {
    seedOverviewData(fresh);
  }
  const config = makeConfig(overviewServers());
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerOverviewRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = options.authenticate
    ? (app.locals.session as SessionManager).createCookie({ logged_in: true, username: 'admin' })
    : '';
  return { fresh, app, cookie };
}

describe('overview routes — authentication gating', () => {
  it('redirects the page to /login when unauthenticated', async () => {
    const { app } = setup({ authenticate: false, seed: false });
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 JSON for the API when unauthenticated', async () => {
    const { app } = setup({ authenticate: false, seed: false });
    const res = await request(app).get('/api/overview');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('overview routes — page', () => {
  it('renders overview.html with the summary and host rows', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('概览');
    expect(res.text).toContain('summary-online');
    expect(res.text).toContain('alpha');
  });
});

describe('overview routes — /api/overview', () => {
  it('returns the summary, per-host rows and capacity payload', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/api/overview').set('Cookie', cookie);
    expect(res.status).toBe(200);

    expect(res.body.summary).toEqual({ online: 1, offline: 1, active_alerts: 1 });
    expect(res.body.meta.groups).toEqual(['Web', '未分组']);
    expect(res.body.meta.has_groups).toBe(true);
    expect(res.body.meta.tags).toEqual(['prod', 'web']);
    expect(res.body.meta.has_tags).toBe(true);
    expect(Array.isArray(res.body.capacity)).toBe(true);

    expect(res.body.hosts).toHaveLength(2);
    const alpha = res.body.hosts.find((row: { name: string }) => row.name === 'alpha');
    expect(alpha).toMatchObject({
      host: '10.0.0.1',
      online: true,
      cpu_percent: 42.5,
      memory_percent: 50,
      disk_percent: 50,
      gpu_memory_percent: 25,
      cpu_cores: 4,
      uptime: '3 days',
      logged_in_user_count: 2,
      logged_in_sessions: 3,
      temperature_c: 55,
      group: 'Web',
      owner: 'ops',
      location: 'DC1',
      tags: ['prod', 'web'],
      silenced: false,
      active_alert_count: 1,
    });
    expect(alpha.disk_health).toEqual({ status: 'ok', healthy: 1, warning: 1, critical: 0 });
    expect(alpha.checks).toEqual({ total: 2, ok: 1, failed: 1, unknown: 0 });
    expect(alpha.gpu_memory).toEqual({ used_mb: 1000, total_mb: 4000 });
    expect(alpha.collection_uptime).toEqual({ samples: 0, expected: 144 });

    const beta = res.body.hosts.find((row: { name: string }) => row.name === 'beta');
    expect(beta).toMatchObject({ online: false, collected_at: null, memory_percent: null });
    expect(beta.disk_health).toEqual({ status: 'unknown', healthy: 0, warning: 0, critical: 0 });
  });
});

describe('overview routes — /api/overview/capacity', () => {
  it('defaults to 30 days and returns per-host forecasts', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/api/overview/capacity').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(30);
    expect(res.body.thresholds).toEqual({ memory: 90, disk: 90, gpu_memory: 90 });
    expect(res.body.hosts).toHaveLength(2);
    const alpha = res.body.hosts.find((row: { host_name: string }) => row.host_name === 'alpha');
    expect(alpha.metrics.map((metric: { key: string }) => metric.key)).toEqual([
      'memory',
      'disk',
      'gpu_memory',
    ]);
    // No 7/30/90-day history in the fixture → every metric is insufficient_data.
    expect(alpha.metrics.every((metric: { status: string }) => metric.status === 'insufficient_data')).toBe(true);
  });

  it('rejects an unsupported day count with 400 invalid_days', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: false });
    const bad = await request(app).get('/api/overview/capacity?days=13').set('Cookie', cookie);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({ error: 'invalid_days' });

    const nonNumeric = await request(app).get('/api/overview/capacity?days=abc').set('Cookie', cookie);
    expect(nonNumeric.status).toBe(400);
    expect(nonNumeric.body).toEqual({ error: 'invalid_days' });
  });
});

describe('overview routes — /api/overview/history', () => {
  it('returns the range + points payload', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/api/overview/history?range=24h').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('24h');
    expect(Array.isArray(res.body.points)).toBe(true);
    expect(res.body.previous).toBeUndefined();
  });

  it('adds an empty previous array for 24h compare requests', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app)
      .get('/api/overview/history?range=24h&compare=1')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.previous).toEqual([]);
  });

  it('rejects an unsupported range with 400 invalid_range', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: false });
    const res = await request(app).get('/api/overview/history?range=1h').set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_range' });
  });
});

describe('overview routes — /api/overview/alert-history', () => {
  it('returns buckets for the requested range', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app)
      .get('/api/overview/alert-history?range=24h')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.range).toBe('24h');
    expect(Array.isArray(res.body.buckets)).toBe(true);
  });

  it('rejects the 90d range (alert history only supports up to 30d)', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: false });
    const res = await request(app)
      .get('/api/overview/alert-history?range=90d')
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_range' });
  });
});

describe('overview routes — /api/overview/report', () => {
  it('downloads a BOM-prefixed plain-text fleet report', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/api/overview/report').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="fleet-report-\d{8}-\d{6}\.txt"/,
    );
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('服务器轮询监测 · 全网巡检报告');
    expect(res.text).toContain('[主机摘要]');
    expect(res.text).toContain('【主机 1/2】alpha');
    expect(res.text).toContain('（报告由服务器轮询监测工具自动生成）');
  });
});
