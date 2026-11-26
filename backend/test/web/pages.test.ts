/**
 * Integration tests for the lightweight pages routes (P2 Task 16).
 *
 * Each case builds the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. DPAPI is replaced by an identity stub so the admin
 * credential can be seeded without the Windows key store (same stub as the
 * overview tests).
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
import { registerPagesRoutes } from '../../src/web/routes/pages';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveSection } from '../../src/config/service';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { saveHostSnapshot } from '../../src/storage/hosts';
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

function pagesServers(): HostConfig[] {
  return [
    makeServer({ name: 'alpha', host: '10.0.0.1', group: 'Web' }),
    makeServer({ name: 'beta', host: '10.0.0.2' }),
  ];
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/pages-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/** Seeds one GPU-bearing snapshot for `alpha`. */
function seedCompute(fresh: FreshDb): void {
  const metrics = {
    collected_at: nowIsoUtc(new Date()),
    gpu_summary: [
      {
        index: 0,
        name: 'Tesla T4',
        utilization_percent: 40,
        memory_used_mb: 1000,
        memory_total_mb: 4000,
        temperature_c: 50,
      },
      {
        index: 1,
        name: 'Tesla T4',
        utilization_percent: 20,
        memory_used_mb: 500,
        memory_total_mb: 4000,
        temperature_c: 48,
      },
    ],
    gpu_processes: [
      { username: 'alice', memory_used_mb: 800, index: 0, command: 'python train.py' },
    ],
  };
  saveHostSnapshot(fresh.db, {
    host_name: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: metrics as never,
  });
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
}

function setup(options: {
  authenticate: boolean;
  seed?: boolean;
  userMode?: boolean;
  deps?: Partial<Parameters<typeof registerPagesRoutes>[1]>;
}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'correcthorse', username: 'admin' });
  if (options.userMode) {
    saveSection(fresh.db, 'monitoring', { mode: 'user', member_account: 'alice' });
  }
  if (options.seed) {
    seedCompute(fresh);
  }
  const config = makeConfig(pagesServers());
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerPagesRoutes(instance, { db: fresh.db, config, appVersion: 'test', ...options.deps });
    },
  });
  const cookie = options.authenticate
    ? (app.locals.session as SessionManager).createCookie({ logged_in: true, username: 'admin' })
    : '';
  return { fresh, app, cookie };
}

describe('pages routes — authentication gating', () => {
  it('redirects the compute page to /login when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/compute');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 JSON for /api/compute when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/api/compute');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('pages routes — GET /compute', () => {
  it('renders compute.html', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/compute').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('算力概览');
  });
});

describe('pages routes — GET /api/compute', () => {
  it('returns the documented compute summary structure', async () => {
    const { app, cookie } = setup({ authenticate: true, seed: true });
    const res = await request(app).get('/api/compute').set('Cookie', cookie);
    expect(res.status).toBe(200);

    // Values come from the real `collect/compute.ts` builder that
    // `defaultBuildComputeSummary` now delegates to (one-decimal GiB, like the
    // Python oracle): 8000 MiB / 1024 = 7.8, 1500 MiB / 1024 = 1.5, 19.2%.
    expect(res.body.totals).toMatchObject({
      cards: 2,
      vram_gb: 7.8,
      used_gb: 1.5,
      vram_pct: 19.2,
    });
    expect(typeof res.body.totals.pf16).toBe('number');
    expect(Array.isArray(res.body.models)).toBe(true);
    expect(Array.isArray(res.body.hosts)).toBe(true);
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(Array.isArray(res.body.idle_hosts)).toBe(true);
    expect(res.body.notes).toHaveLength(3);

    const alpha = res.body.hosts.find((row: { name: string }) => row.name === 'alpha');
    expect(alpha).toMatchObject({ name: 'alpha', address: '10.0.0.1', cards: 2 });
  });

  it('uses an injected compute-summary builder when provided', async () => {
    const sentinel = { totals: { cards: 99 }, models: [], hosts: [], users: [], idle_hosts: [], notes: ['x'] };
    const { app, cookie } = setup({
      authenticate: true,
      deps: { buildComputeSummary: () => sentinel },
    });
    const res = await request(app).get('/api/compute').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sentinel);
  });
});

describe('pages routes — GET /my + /api/my/summary', () => {
  it('renders my.html with the member account', async () => {
    const { app, cookie } = setup({ authenticate: true, userMode: true });
    const res = await request(app).get('/my').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('alice');
  });

  it('returns my summary JSON with mode/member and empty host rows', async () => {
    const { app, cookie } = setup({ authenticate: true, userMode: true });
    const res = await request(app).get('/api/my/summary').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'user',
      member: 'alice',
      hosts: [],
    });
    expect(res.body.summary).toMatchObject({
      hosts: 0,
      present: 0,
      missing: 0,
      issues: 0,
      host_errors: 0,
      home_bytes: 0,
      data_bytes: 0,
    });
  });
});

describe('pages routes — GET /terminal', () => {
  it('renders terminal.html with the host list', async () => {
    const { app, cookie } = setup({ authenticate: true });
    const res = await request(app).get('/terminal').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('SSH 终端');
    expect(res.text).toContain('alpha');
    expect(res.text).toContain('beta');
  });
});
