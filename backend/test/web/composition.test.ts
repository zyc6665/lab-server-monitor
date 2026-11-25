/**
 * P3 Task 12 — composition-root wiring tests.
 *
 * Exercises {@link buildDefaultDeps} and {@link createServerApp} against a fresh
 * temp SQLite database. The goal is to prove the migrated collection layer is
 * injected into the `hosts` / `pages` routes *without* opening a real network
 * connection:
 *
 *   - every safe dependency is present and callable,
 *   - the still-unmigrated P4/P5 hooks stay `undefined`,
 *   - SSH-backed callables fail *before* dialing when key material is missing,
 *   - the real compute builder reaches `/api/compute` (real GPU specs ≠ 0),
 *   - `GET /api/system/health` answers 200 on an initialised instance,
 *   - an injected `probeHost` override proves the deps merge is honoured.
 *
 * DPAPI is replaced by an identity stub (same pattern as the other web tests) so
 * the admin credential can be seeded without the Windows key store.
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

import type { AppConfig, HostConfig } from '../../src/config/config';
import { saveHostSnapshot } from '../../src/storage/hosts';
import { nowIsoUtc } from '../../src/storage/time';
import { setAdminPassword } from '../../src/web/routes/auth';
import { buildDefaultDeps, createServerApp } from '../../src/web/composition';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

const ADMIN_PASSWORD = 'admin-test-pw';

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
    disk_mounts: ['/'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

/** The public address used by fixtures; in the probe allowlist, so no DNS. */
const PUBLIC_HOST = '203.0.113.5';

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/composition-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

/** Seeds one GPU-bearing snapshot for `alpha` (Tesla T4 → real tflops > 0). */
function seedCompute(fresh: FreshDb): void {
  const metrics = {
    collected_at: nowIsoUtc(new Date()),
    gpu_summary: [
      {
        index: 0,
        name: 'Tesla T4',
        utilization_percent: 40,
        memory_used_mb: 1000,
        memory_total_mb: 16000,
        temperature_c: 50,
      },
    ],
    gpu_processes: [],
  };
  saveHostSnapshot(fresh.db, {
    host_name: 'alpha',
    host: PUBLIC_HOST,
    success: true,
    metrics: metrics as never,
  });
}

/** Creates a logged-in session cookie (with a CSRF token) for `app`. */
function loginCookie(app: Express, csrfToken?: string): string {
  const data = { logged_in: true, username: 'admin', ...(csrfToken ? { csrf_token: csrfToken } : {}) };
  return (app.locals.session as SessionManager).createCookie(data);
}

describe('buildDefaultDeps — P3 collection wiring', () => {
  it('exposes the migrated hosts/pages deps as functions', () => {
    const fresh = freshDb();
    const deps = buildDefaultDeps(fresh.db, makeConfig([makeServer({ name: 'a', host: PUBLIC_HOST })]));

    expect(typeof deps.hosts?.buildOverview).toBe('function');
    expect(typeof deps.hosts?.buildHostDetail).toBe('function');
    expect(typeof deps.hosts?.buildHostReport).toBe('function');
    expect(typeof deps.hosts?.probeHost).toBe('function');
    expect(typeof deps.hosts?.collectContainerStats).toBe('function');
    expect(typeof deps.hosts?.runner).toBe('function');
    expect(typeof deps.pages?.buildComputeSummary).toBe('function');
  });

  it('leaves the not-yet-migrated P4/P5 hooks undefined', () => {
    const fresh = freshDb();
    const deps = buildDefaultDeps(fresh.db, makeConfig([makeServer({ name: 'a', host: PUBLIC_HOST })]));

    expect(deps.hosts?.runHostChecks).toBeUndefined();
    expect(deps.hosts?.collectHosts).toBeUndefined();
    expect(deps.hosts?.collectionStatus).toBeUndefined();
    expect(deps.users?.monitorService ?? undefined).toBeUndefined();
  });

  it('maps a key-auth host with no key material to a failure ProbeResult (no dial)', async () => {
    const host = makeServer({ name: 'nokey', host: PUBLIC_HOST, auth: { type: 'key' } as never });
    const fresh = freshDb();
    const deps = buildDefaultDeps(fresh.db, makeConfig([host]));

    const result = (await deps.hosts!.probeHost!(host)) as { ok: boolean; status: string };
    // `probeHost` must not throw out of the route, and must not have connected.
    expect(result.ok).toBe(false);
    expect(typeof result.status).toBe('string');
  });

  it('runner / collectContainerStats reject before dialing when the key is missing', async () => {
    const host = makeServer({ name: 'nokey', host: PUBLIC_HOST, auth: { type: 'key' } as never });
    const fresh = freshDb();
    const deps = buildDefaultDeps(fresh.db, makeConfig([host]));

    await expect(deps.hosts!.runner!(host)).rejects.toThrow(/SSH key is not configured/);
    await expect(deps.hosts!.collectContainerStats!(host)).rejects.toThrow(
      /SSH key is not configured/,
    );
  });

  it('buildComputeSummary uses the real compute module (GPU specs populated)', () => {
    const fresh = freshDb();
    seedCompute(fresh);
    const config = makeConfig([makeServer({ name: 'alpha', host: PUBLIC_HOST })]);
    const deps = buildDefaultDeps(fresh.db, config);

    const summary = deps.pages!.buildComputeSummary!(fresh.db, config) as {
      totals: { tflops: number };
      models: unknown[];
    };
    expect(summary.totals.tflops).toBeGreaterThan(0);
    expect(Array.isArray(summary.models)).toBe(true);
  });
});

describe('createServerApp — P3 assembly', () => {
  /** Builds an initialised app (admin seeded so the setup gate is passed). */
  function setupApp(servers: HostConfig[]): { fresh: FreshDb; app: Express } {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: ADMIN_PASSWORD, username: 'admin' });
    const app = createServerApp({ db: fresh.db, config: makeConfig(servers), mountStatic: false });
    return { fresh, app };
  }

  it('answers GET /api/system/health with 200 on an initialised instance', async () => {
    const { app } = setupApp([makeServer({ name: 'alpha', host: PUBLIC_HOST })]);
    const res = await request(app).get('/api/system/health').set('Cookie', loginCookie(app));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe('test');
    expect(res.body).toHaveProperty('db_path');
  });

  it('serves /api/compute through the injected real compute builder', async () => {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: ADMIN_PASSWORD, username: 'admin' });
    seedCompute(fresh);
    const app = createServerApp({
      db: fresh.db,
      config: makeConfig([makeServer({ name: 'alpha', host: PUBLIC_HOST })]),
      mountStatic: false,
    });

    const res = await request(app).get('/api/compute').set('Cookie', loginCookie(app));

    expect(res.status).toBe(200);
    expect(res.body.totals.tflops).toBeGreaterThan(0);
  });

  it('honours an injected probeHost override (no network)', async () => {
    const fresh = freshDb();
    setAdminPassword(fresh.db, { newPassword: ADMIN_PASSWORD, username: 'admin' });
    const calls: unknown[] = [];
    const app = createServerApp({
      db: fresh.db,
      config: makeConfig([makeServer({ name: 'alpha', host: PUBLIC_HOST })]),
      mountStatic: false,
      deps: {
        hosts: {
          probeHost: async (target: unknown) => {
            calls.push(target);
            return { ok: true, status: 'ok', message: 'fake-probe' };
          },
        },
      },
    });

    const res = await request(app)
      .post('/api/settings/hosts/probe')
      .set('Cookie', loginCookie(app, 'test-csrf-token'))
      .set('X-CSRF-Token', 'test-csrf-token')
      .send({ host: PUBLIC_HOST, username: 'root' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'ok', message: 'fake-probe' });
    expect(calls).toHaveLength(1);
  });
});
