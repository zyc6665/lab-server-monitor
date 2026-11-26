/**
 * Integration tests for the alerts routes (P2 Task 13).
 *
 * Every case mounts the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. DPAPI is replaced with an identity stub so the
 * silence write guard behaves like a writable Windows install by default; a
 * per-test `writable:false` dependency exercises the read-only branch.
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
import { registerAlertsRoutes, type AlertsRouteDeps } from '../../src/web/routes/alerts';
import { setAdminPassword } from '../../src/web/routes/auth';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { insertAlert, listAlerts, updateAlert } from '../../src/storage/alerts';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

const CSRF = '{{SECRET_csrf_alrt01}}';

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

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/alerts-test.db',
    host: '0.0.0.0',
    port: 8080,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

interface Harness {
  fresh: FreshDb;
  app: Express;
  cookie: string;
  config: AppConfig;
}

function setup(options: { authenticate?: boolean; servers?: HostConfig[]; deps?: Partial<AlertsRouteDeps> } = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'secret-password', username: 'admin' });
  const config = makeConfig(
    options.servers ?? [
      makeServer({ name: 'alpha', host: '10.0.0.1', group: 'Web' }),
      makeServer({ name: 'beta', host: '10.0.0.2' }),
    ],
  );
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerAlertsRoutes(instance, { db: fresh.db, config, appVersion: 'test', ...(options.deps ?? {}) });
    },
  });
  const cookie =
    options.authenticate === false
      ? ''
      : (app.locals.session as SessionManager).createCookie({
          logged_in: true,
          username: 'admin',
          csrf_token: CSRF,
        });
  return { fresh, app, cookie, config };
}

/** Auth headers for an unsafe method. */
function authHeaders(h: Harness): Record<string, string> {
  return { Cookie: h.cookie, 'X-CSRF-Token': CSRF };
}

/** Seeds one active alert, optionally backdated. */
function seedAlert(
  fresh: FreshDb,
  overrides: { host_name?: string; severity?: string; title?: string; status?: string; createdAt?: Date } = {},
): number {
  const id = insertAlert(
    fresh.db,
    {
      host_name: overrides.host_name ?? 'alpha',
      category: 'cpu',
      severity: overrides.severity ?? 'critical',
      title: overrides.title ?? 'CPU high',
      message: 'cpu usage above threshold',
      fingerprint: `fp-${Math.random().toString(36).slice(2)}`,
    },
    overrides.createdAt ? { createdAt: overrides.createdAt } : {},
  );
  if (overrides.status && overrides.status !== 'active') {
    updateAlert(fresh.db, id, { status: overrides.status });
  }
  return id;
}

const HOUR_MS = 60 * 60 * 1000;

function silencePlot(scopeType: string, scope: string): Record<string, unknown> {
  return {
    scope_type: scopeType,
    scope,
    reason: 'maintenance',
    starts_at: new Date(Date.now() - HOUR_MS).toISOString(),
    ends_at: new Date(Date.now() + HOUR_MS).toISOString(),
  };
}

describe('alerts routes — authentication', () => {
  it('redirects the page to /login when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/alerts');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 for the API when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/api/alerts');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /alerts', () => {
  it('renders the alerts page with counts and rows', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'Disk almost full' });
    const res = await request(h.app).get('/alerts').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="alerts-body"');
    expect(res.text).toContain('告警列表');
    expect(res.text).toContain('Disk almost full');
    expect(res.text).toContain('共 1 条');
    expect(res.text).toContain('id="alert-status-count-active"');
  });

  it('defaults to the active status filter', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'Active one', status: 'active' });
    seedAlert(h.fresh, { title: 'Acked one', status: 'acknowledged' });
    const res = await request(h.app).get('/alerts').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('共 1 条');
    expect(res.text).toContain('Active one');
    expect(res.text).not.toContain('Acked one');
  });

  it('shows every status with status=all', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'Active one', status: 'active' });
    seedAlert(h.fresh, { title: 'Acked one', status: 'acknowledged' });
    const res = await request(h.app).get('/alerts?status=all').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('共 2 条');
    expect(res.text).toContain('Acked one');
  });

  it('ignores an unknown range and falls back to all time', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'Recent' });
    const res = await request(h.app).get('/alerts?range=bogus').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('共 1 条');
  });
});

describe('GET /api/alerts', () => {
  it('returns alerts and counts, defaulting to active', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'A', status: 'active' });
    seedAlert(h.fresh, { title: 'B', status: 'acknowledged' });
    const res = await request(h.app).get('/api/alerts').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].title).toBe('A');
    expect(res.body.counts).toMatchObject({ active: 1, acknowledged: 1, resolved: 0, total: 2 });
  });

  it('returns every status with status=all', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'A', status: 'active' });
    seedAlert(h.fresh, { title: 'B', status: 'acknowledged' });
    const res = await request(h.app).get('/api/alerts?status=all').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(2);
  });

  it('filters by a valid range preset', async () => {
    const h = setup();
    seedAlert(h.fresh, { title: 'old', createdAt: new Date(Date.now() - 40 * 24 * HOUR_MS) });
    seedAlert(h.fresh, { title: 'recent' });
    const res = await request(h.app).get('/api/alerts?range=24h').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].title).toBe('recent');
    expect(res.body.counts.total).toBe(1);
  });

  it('rejects an invalid range with 400', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/alerts?range=37h').set('Cookie', h.cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid range' });
  });

  it('localizes created_at into the display timezone', async () => {
    const h = setup();
    seedAlert(h.fresh);
    const res = await request(h.app).get('/api/alerts').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.alerts[0].created_at).toMatch(/[+-]\d{2}:\d{2}$/);
  });
});

describe('POST /api/alerts/{id}/ack', () => {
  it('acknowledges an active alert', async () => {
    const h = setup();
    const id = seedAlert(h.fresh);
    const res = await request(h.app)
      .post(`/api/alerts/${id}/ack`)
      .set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const row = listAlerts(h.fresh.db, { status: 'acknowledged' })[0];
    expect(row.id).toBe(id);
    expect(row.ack_at).toBeTruthy();
  });

  it('succeeds as a no-op for an unknown alert id', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/alerts/999999/ack')
      .set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe('GET /api/settings/silences', () => {
  it('returns an empty list by default', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/settings/silences').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ silences: [] });
  });

  it('lists a created silence', async () => {
    const h = setup();
    await request(h.app).post('/api/settings/silences').set(authHeaders(h)).send(silencePlot('host', 'alpha'));
    const res = await request(h.app).get('/api/settings/silences').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.silences).toHaveLength(1);
    expect(res.body.silences[0]).toMatchObject({ scope_type: 'host', scope: 'alpha' });
  });
});

describe('POST /api/settings/silences', () => {
  it('creates a silence and resolves open alerts in scope', async () => {
    const h = setup();
    seedAlert(h.fresh, { host_name: 'alpha', status: 'active' });
    await seedAlert(h.fresh, { host_name: 'beta', status: 'active' });
    const res = await request(h.app)
      .post('/api/settings/silences')
      .set(authHeaders(h))
      .send(silencePlot('host', 'alpha'));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.id).toBe('number');
    // alpha in-scope alert resolved, beta untouched.
    expect(listAlerts(h.fresh.db, { status: 'resolved' })).toHaveLength(1);
    expect(listAlerts(h.fresh.db, { status: 'active' })).toHaveLength(1);
  });

  it('rejects a non-object payload with 400 invalid_payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/silences')
      .set(authHeaders(h))
      .set('Content-Type', 'application/json')
      .send('[1,2,3]');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects an invalid silence with the oracle message', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/silences')
      .set(authHeaders(h))
      .send({ ...silencePlot('host', 'alpha'), scope_type: 'bogus' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('scope_type');
  });

  it('returns 409 when settings are not writable', async () => {
    const h = setup({ deps: { writable: false } });
    const res = await request(h.app)
      .post('/api/settings/silences')
      .set(authHeaders(h))
      .send(silencePlot('host', 'alpha'));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'settings_not_writable' });
  });
});

describe('DELETE /api/settings/silences/{id}', () => {
  it('deletes an existing silence', async () => {
    const h = setup();
    const created = await request(h.app)
      .post('/api/settings/silences')
      .set(authHeaders(h))
      .send(silencePlot('host', 'alpha'));
    const res = await request(h.app)
      .delete(`/api/settings/silences/${created.body.id}`)
      .set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const list = await request(h.app).get('/api/settings/silences').set('Cookie', h.cookie);
    expect(list.body.silences).toHaveLength(0);
  });

  it('returns 404 for an unknown silence id', async () => {
    const h = setup();
    const res = await request(h.app).delete('/api/settings/silences/424242').set(authHeaders(h));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('returns 409 when settings are not writable', async () => {
    const h = setup({ deps: { writable: false } });
    const res = await request(h.app).delete('/api/settings/silences/1').set(authHeaders(h));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'settings_not_writable' });
  });
});
