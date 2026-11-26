/**
 * Track C tests — bulk acknowledge/silence, delivery-failure listing and the
 * manual "resend failed channels" action.
 *
 * Mounts the full middleware chain (CSRF / auth / user-mode) through
 * {@link createWebApp}, like `alerts.test.ts`, and injects a fake notifier so
 * the resend path is exercised without real SMTP/webhooks.
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
import type { DispatchHooks, NotifierProtocol } from '../../src/alerts/engine';
import { insertAlert, listAlerts, listSilences } from '../../src/storage/alerts';
import { recordDeliveryFailure } from '../../src/storage/alert-delivery';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

const CSRF = 'track-c-csrf-token';

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
    dbPath: '/tmp/alerts-track-c.db',
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

function setup(options: { servers?: HostConfig[]; notifier?: NotifierProtocol } = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'track-c-password', username: 'admin' });
  const config = makeConfig(
    options.servers ?? [
      makeServer({ name: 'alpha', host: '10.0.0.1', group: 'Web' }),
      makeServer({ name: 'beta', host: '10.0.0.2' }),
    ],
  );
  const deps: Partial<AlertsRouteDeps> = {};
  if (options.notifier) {
    deps.notifier = options.notifier;
  }
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerAlertsRoutes(instance, {
        db: fresh.db,
        config,
        appVersion: 'test',
        ...deps,
      });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: CSRF,
  });
  return { fresh, app, cookie, config };
}

function authHeaders(h: Harness): Record<string, string> {
  return { Cookie: h.cookie, 'X-CSRF-Token': CSRF };
}

function seedAlert(fresh: FreshDb, overrides: { host_name?: string } = {}): number {
  return insertAlert(fresh.db, {
    host_name: overrides.host_name ?? 'alpha',
    category: 'cpu',
    severity: 'critical',
    title: 'CPU high',
    message: 'cpu usage above threshold',
    fingerprint: `fp-${Math.random().toString(36).slice(2)}`,
  });
}

interface FakeNotifier {
  notifier: NotifierProtocol;
  calls: Array<{ only: string[] }>;
}

/** A fake notifier recording dispatch calls; `result` controls acceptance. */
function fakeNotifier(result: string[] = ['email']): FakeNotifier {
  const calls: Array<{ only: string[] }> = [];
  return {
    calls,
    notifier: {
      dispatch: (_event, _config, hooks?: DispatchHooks) => {
        calls.push({ only: hooks?.only ? [...hooks.only] : [] });
        return Promise.resolve([...result]);
      },
    },
  };
}

/** A fake notifier whose channels always throw again. */
function failingNotifier(message = 'still down'): FakeNotifier {
  const calls: Array<{ only: string[] }> = [];
  return {
    calls,
    notifier: {
      dispatch: (_event, _config, hooks?: DispatchHooks) => {
        calls.push({ only: hooks?.only ? [...hooks.only] : [] });
        if (hooks?.onChannelFailure) {
          hooks.onChannelFailure({ channel: 'email', target: null, error: message });
        }
        return Promise.resolve([]);
      },
    },
  };
}

describe('alerts routes — bulk acknowledge', () => {
  it('acknowledges every id in one request', async () => {
    const h = setup();
    const ids = [seedAlert(h.fresh), seedAlert(h.fresh, { host_name: 'beta' }), seedAlert(h.fresh)];

    const res = await request(h.app)
      .post('/api/alerts/bulk/ack')
      .set(authHeaders(h))
      .send({ ids });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, acknowledged: 3 });
    expect(listAlerts(h.fresh.db, { status: 'acknowledged' })).toHaveLength(3);
  });

  it('rejects more than 200 ids with invalid_payload', async () => {
    const h = setup();
    const ids = Array.from({ length: 201 }, (_value, index) => index + 1);

    const res = await request(h.app)
      .post('/api/alerts/bulk/ack')
      .set(authHeaders(h))
      .send({ ids });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects non-integer ids with invalid_payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/alerts/bulk/ack')
      .set(authHeaders(h))
      .send({ ids: [1, 'two'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects an empty id list', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/alerts/bulk/ack')
      .set(authHeaders(h))
      .send({ ids: [] });
    expect(res.status).toBe(400);
  });
});

describe('alerts routes — bulk silence', () => {
  it('creates a host-scoped silence for each alert host', async () => {
    const h = setup();
    const alpha = seedAlert(h.fresh, { host_name: 'alpha' });
    const beta = seedAlert(h.fresh, { host_name: 'beta' });

    const res = await request(h.app)
      .post('/api/alerts/bulk/silence')
      .set(authHeaders(h))
      .send({ ids: [alpha, beta], hours: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, silenced: 2 });

    const scopes = listSilences(h.fresh.db, { activeOnly: true })
      .map((silence) => silence.scope)
      .sort();
    expect(scopes).toEqual(['alpha', 'beta']);
  });

  it('rejects an out-of-range hours value', async () => {
    const h = setup();
    const id = seedAlert(h.fresh);
    for (const hours of [0, 721, 1.5]) {
      const res = await request(h.app)
        .post('/api/alerts/bulk/silence')
        .set(authHeaders(h))
        .send({ ids: [id], hours });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_payload' });
    }
  });
});

describe('alerts routes — delivery failures', () => {
  it('lists failures for a single alert', async () => {
    const h = setup();
    const id = seedAlert(h.fresh);
    const other = seedAlert(h.fresh);
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'email', error: 'smtp down' });
    recordDeliveryFailure(h.fresh.db, { alertId: other, channel: 'webhook', error: 'timeout' });

    const res = await request(h.app)
      .get('/api/alerts/delivery-failures')
      .query({ alert_id: id })
      .set(authHeaders(h));

    expect(res.status).toBe(200);
    expect(res.body.failures).toHaveLength(1);
    expect(res.body.failures[0]).toMatchObject({
      alertId: id,
      channel: 'email',
      error: 'smtp down',
    });
  });

  it('lists every failure without a filter', async () => {
    const h = setup();
    const id = seedAlert(h.fresh);
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'email', error: 'a' });
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'webhook', error: 'b' });

    const res = await request(h.app).get('/api/alerts/delivery-failures').set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.body.failures).toHaveLength(2);
  });

  it('rejects a malformed alert_id', async () => {
    const h = setup();
    const res = await request(h.app)
      .get('/api/alerts/delivery-failures')
      .query({ alert_id: 'abc' })
      .set(authHeaders(h));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });
});

describe('alerts routes — resend failed channels', () => {
  it('resends only the channels that previously failed', async () => {
    const fake = fakeNotifier(['email']);
    const h = setup({ notifier: fake.notifier });
    const id = seedAlert(h.fresh);
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'email', error: 'smtp down' });
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'webhook', error: 'timeout' });

    const res = await request(h.app)
      .post(`/api/alerts/${id}/resend`)
      .set(authHeaders(h))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, resent: ['email'] });
    expect(fake.calls).toHaveLength(1);
    expect([...fake.calls[0].only].sort()).toEqual(['email', 'webhook']);
  });

  it('returns an empty resend list when nothing failed', async () => {
    const fake = fakeNotifier(['email']);
    const h = setup({ notifier: fake.notifier });
    const id = seedAlert(h.fresh);

    const res = await request(h.app)
      .post(`/api/alerts/${id}/resend`)
      .set(authHeaders(h))
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, resent: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('returns 404 for an unknown alert', async () => {
    const fake = fakeNotifier(['email']);
    const h = setup({ notifier: fake.notifier });
    const res = await request(h.app)
      .post('/api/alerts/9999/resend')
      .set(authHeaders(h))
      .send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('returns 502 when the channels fail again', async () => {
    const h = setup({ notifier: failingNotifier().notifier });
    const id = seedAlert(h.fresh);
    recordDeliveryFailure(h.fresh.db, { alertId: id, channel: 'email', error: 'smtp down' });

    const res = await request(h.app)
      .post(`/api/alerts/${id}/resend`)
      .set(authHeaders(h))
      .send({});

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: 'resend_failed', message: 'still down' });
  });
});

describe('alerts page — Track C markup', () => {
  it('renders the bulk bar, failure hooks and page module', async () => {
    const h = setup();
    seedAlert(h.fresh);
    const res = await request(h.app).get('/alerts').set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="alert-bulk-bar"');
    expect(res.text).toContain('id="alert-bulk-count"');
    expect(res.text).toContain('id="alert-bulk-silence"');
    expect(res.text).toContain('批量静默');
    expect(res.text).toContain('id="alert-bulk-hours"');
    expect(res.text).toContain('id="alerts-body"');
    expect(res.text).toContain('pages/alerts.js');
  });
});
