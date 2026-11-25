/**
 * Integration tests for the disk-health page route (P2 Task 16).
 *
 * Builds the full middleware chain through {@link createWebApp} on a fresh temp
 * SQLite database, seeds a small amount of disk-health history and asserts both
 * the rendered page and the aggregation helper (`buildDiskHealthContext`).
 * DPAPI is replaced by an identity stub so the admin credential can be seeded.
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
import { buildDiskHealthContext, registerDiskHealthRoutes } from '../../src/web/routes/disk-health';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { saveDiskHealth } from '../../src/storage/disk';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

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

/** `alpha` (group Web) + `beta` + `delta` (configured but no health snapshot). */
function diskServers(): HostConfig[] {
  return [
    makeServer({ name: 'alpha', host: '10.0.0.1', group: 'Web' }),
    makeServer({ name: 'beta', host: '10.0.0.2' }),
    makeServer({ name: 'delta', host: '10.0.0.4' }),
  ];
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/disk-health-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/**
 * Seeds disk health for `alpha` (healthy + warning, one hot), `beta`
 * (critical) and `gamma` (error, not in config → health-only host).
 */
function seedDiskHealth(fresh: FreshDb): void {
  saveDiskHealth(fresh.db, {
    host_name: 'alpha',
    collected_at: new Date(),
    status: 'ok',
    controllers: [{ controller: 0 }],
    virtual_drives: [{ controller: 0, vd_id: 0 }],
    physical_drives: [
      { controller: 0, enclosure: 0, slot: 0, model: 'ST4000', serial: 'S1', health: 'healthy', temperature_c: 40 },
      { controller: 0, enclosure: 0, slot: 1, model: 'ST4000', serial: 'S2', health: 'warning', temperature_c: 60 },
    ],
  });
  saveDiskHealth(fresh.db, {
    host_name: 'beta',
    collected_at: new Date(),
    status: 'critical',
    physical_drives: [
      { controller: 0, enclosure: 0, slot: 2, model: 'WD20', serial: 'B1', health: 'critical', temperature_c: 55 },
    ],
  });
  saveDiskHealth(fresh.db, {
    host_name: 'gamma',
    collected_at: new Date(),
    status: 'error',
    message: 'storcli 未安装',
  });
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
}

function setup(options: { authenticate: boolean; seed?: boolean }): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
  if (options.seed) {
    seedDiskHealth(fresh);
  }
  const config = makeConfig(diskServers());
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerDiskHealthRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = options.authenticate
    ? (app.locals.session as SessionManager).createCookie({ logged_in: true, username: 'admin' })
    : '';
  return { fresh, app, cookie };
}

describe('disk-health route — authentication gating', () => {
  it('redirects to /login when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/disk-health');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });
});

describe('disk-health route — page', () => {
  it('renders disk_health.html with per-host rows and group headers', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/disk-health').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('磁盘健康');
    expect(res.text).toContain('alpha');
    expect(res.text).toContain('beta');
    expect(res.text).toContain('id="disk-alpha"');
    expect(res.text).toContain('data-disk-group="Web"');
    expect(res.text).toContain('未分组');
  });

  it('renders an empty page (200) when there is no disk-health data', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: false });
    const res = await request(app).get('/disk-health').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('磁盘健康');
  });
});

describe('disk-health aggregation (buildDiskHealthContext)', () => {
  it('aggregates totals, temperatures, ordering and group headers like the oracle', () => {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
    seedDiskHealth(fresh);
    const config = makeConfig(diskServers());

    const context = buildDiskHealthContext(fresh.db, config);

    expect(context.totals).toEqual({ healthy: 1, warning: 1, critical: 1, drives: 3 });
    expect(context.temperature_stats).toEqual({ max: 60, average: 51.7, hot: 2, samples: 3 });
    expect(context.has_groups).toBe(true);

    // Critical (beta) → ok (alpha) → unknown (delta) → error (gamma).
    expect(context.hosts.map((row) => row.name)).toEqual(['beta', 'alpha', 'delta', 'gamma']);

    const alpha = context.hosts.find((row) => row.name === 'alpha');
    expect(alpha).toMatchObject({
      anchor: 'alpha',
      host: '10.0.0.1',
      group: 'Web',
      status: 'ok',
      healthy: 1,
      warning: 1,
      critical: 0,
      needs_attention: true,
      controller_count: 1,
      vd_count: 1,
      pd_count: 2,
      temperature_max: 60,
      group_header: 'Web',
      group_size: 1,
    });
    expect(String(alpha?.search_text)).toContain('st4000');

    const beta = context.hosts.find((row) => row.name === 'beta');
    expect(beta).toMatchObject({
      status: 'critical',
      critical: 1,
      needs_attention: true,
      group_header: '未分组',
      group_size: 3,
    });

    const delta = context.hosts.find((row) => row.name === 'delta');
    expect(delta).toMatchObject({ status: 'unknown', host: '10.0.0.4', pd_count: 0, collected_at: null });
    expect(delta?.group_header).toBeNull();

    const gamma = context.hosts.find((row) => row.name === 'gamma');
    expect(gamma).toMatchObject({
      status: 'error',
      host: null,
      group: '未分组',
      needs_attention: true,
      message: 'storcli 未安装',
      group_size: 3,
    });
    // Only the first row of each group carries the group header.
    expect(gamma?.group_header).toBeNull();

    // Every physical drive carries its host name in the flat drives list.
    expect(context.drives).toHaveLength(3);
    expect(context.drives.every((drive) => typeof drive.host_name === 'string')).toBe(true);
  });
});
