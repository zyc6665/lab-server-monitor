/**
 * Integration tests for the hosts routes (P2 Task 11).
 *
 * Each case mounts the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. SSH/network collaborators are injected stubs, so
 * no test ever opens a real connection. DPAPI is replaced with an identity stub
 * so the admin credential + host secrets round-trip without the Windows store.
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
import { registerHostsRoutes, type HostsRouteDeps } from '../../src/web/routes/hosts';
import { setAdminPassword } from '../../src/web/routes/auth';
import { upsertHost } from '../../src/config/hosts';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { getHostCheckResults } from '../../src/storage/hosts';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/hosts-test.db',
    host: '127.0.0.1',
    port: 0,
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

/** Builds a fully wired app with `registerHostsRoutes` mounted. */
function setup(options: {
  authenticate?: boolean;
  servers?: HostConfig[];
  deps?: Partial<HostsRouteDeps>;
} = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'secret-password', username: 'admin' });
  const config = makeConfig(options.servers ?? []);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerHostsRoutes(instance, { db: fresh.db, config, appVersion: 'test', ...(options.deps ?? {}) });
    },
  });
  const cookie =
    options.authenticate === false
      ? ''
      : (app.locals.session as SessionManager).createCookie({
          logged_in: true,
          username: 'admin',
          csrf_token: 'csrf-test',
        });
  return { fresh, app, cookie, config };
}

/** Persists one host directly through the settings layer. */
function seedHost(h: Harness, name: string, overrides: Record<string, unknown> = {}): void {
  upsertHost(
    h.fresh.db,
    {
      name,
      host: '10.0.0.1',
      port: 22,
      username: 'root',
      auth_type: 'password',
      password: 'pw',
      ...overrides,
    },
    { writable: true, baseServers: h.config.servers },
  );
}

describe('hosts routes — authentication gating', () => {
  it('redirects the hosts page to /login when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/hosts');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 JSON for an inventory API when unauthenticated', async () => {
    const { app } = setup({ authenticate: false });
    const res = await request(app).get('/api/settings/hosts');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('hosts routes — pages', () => {
  it('renders the hosts page with seeded host names and groups', async () => {
    const h = setup();
    seedHost(h, 'alpha', { group: 'Web', tags: ['prod'] });
    const res = await request(h.app).get('/hosts').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.text).toContain('alpha');
    expect(res.text).toContain('Web');
  });

  it('renders the host detail page for an existing host', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/host/alpha').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.text).toContain('alpha');
  });

  it('returns 404 for the host detail page of an unknown host', async () => {
    const h = setup();
    const res = await request(h.app).get('/host/missing').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(404);
  });
});

describe('hosts routes — host detail JSON / report / history', () => {
  it('returns host detail JSON including collection_uptime and uptime_strip', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/api/host/alpha').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('alpha');
    expect(res.body).toHaveProperty('collection_uptime');
    expect(res.body).toHaveProperty('uptime_strip');
    expect(res.body).toHaveProperty('check_history');
  });

  it('returns 404 JSON for an unknown host detail', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/host/missing').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });

  it('streams a BOM-prefixed plain-text report as an attachment', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/api/host/alpha/report').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="host-report-alpha-\d{8}-\d{6}\.txt"$/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    expect(res.text).toContain('alpha');
  });

  it('rejects an unsupported history range with 400 invalid_range', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/api/host/alpha/history?range=99h').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_range' });
  });

  it('returns an empty point list for a valid range', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/api/host/alpha/history?range=24h').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ range: '24h', points: [] });
  });

  it('returns 404 history for an unknown host', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/host/missing/history').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not found' });
  });
});

describe('hosts routes — inventory', () => {
  it('lists masked host entries', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const res = await request(h.app).get('/api/settings/hosts').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body.hosts.map((entry: { name: string }) => entry.name)).toContain('alpha');
  });

  it('returns 404 settings_unavailable when the settings service is absent', async () => {
    const h = setup({ deps: { settingsAvailable: () => false } });
    const res = await request(h.app).get('/api/settings/hosts').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'settings_unavailable' });
  });

  it('creates a host (payload without name inherits the URL name)', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/hosts/web1')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '10.0.0.7', username: 'root', auth_type: 'password', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const list = await request(h.app).get('/api/settings/hosts').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(list.body.hosts.map((entry: { name: string }) => entry.name)).toContain('web1');
  });

  it('rejects a non-JSON upsert body with 400 invalid_payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/hosts/web1')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .set('Content-Type', 'text/plain')
      .send('not json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects an upsert with a mismatched payload name', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/hosts/web1')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ name: 'other', host: '10.0.0.7', username: 'root', auth_type: 'password', password: 'pw' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('does not match');
  });

  it('rejects an upsert missing a password with the settings error message', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/hosts/web1')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '10.0.0.7', username: 'root', auth_type: 'password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('SSH 密码未设置');
  });

  it('returns 409 settings_not_writable when writes are disabled', async () => {
    const h = setup({ deps: { isWritable: () => false } });
    const res = await request(h.app)
      .put('/api/settings/hosts/web1')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '10.0.0.7', username: 'root', auth_type: 'password', password: 'pw' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'settings_not_writable' });
  });

  it('deletes an existing host and 404s for a missing one', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const ok = await request(h.app).delete('/api/settings/hosts/alpha').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    const missing = await request(h.app).delete('/api/settings/hosts/ghost').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });

  it('copies a host and validates the new name', async () => {
    const h = setup();
    seedHost(h, 'alpha');
    const ok = await request(h.app)
      .post('/api/settings/hosts/alpha/copy')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ new_name: 'alpha-copy' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, name: 'alpha-copy' });
    const empty = await request(h.app)
      .post('/api/settings/hosts/alpha/copy')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ new_name: '  ' });
    expect(empty.status).toBe(400);
    expect(empty.body).toEqual({ error: 'new_name 不能为空' });
    const missing = await request(h.app)
      .post('/api/settings/hosts/ghost/copy')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ new_name: 'ghost-copy' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('源主机不存在: ghost');
  });
});

describe('hosts routes — import preview / import', () => {
  it('previews a CSV payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/import/preview')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ format: 'csv', content: 'name,host\nweb,10.0.0.9\n' });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0].name).toBe('web');
    expect(res.body.errors).toEqual([]);
  });

  it('rejects an unsupported import format with 400 unsupported_format', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/import/preview')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ format: 'xml', content: '<x/>' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unsupported_format' });
  });

  it('rejects a non-string import content with 400 invalid_payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/import/preview')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ format: 'csv', content: 123 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('imports hosts from a pasted CSV payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/import')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({
        format: 'csv',
        content: 'name,host,port,username,auth_type,key_path\nweb9,10.0.0.30,22,root,key,/root/.ssh/id_rsa\n',
      });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toContain('web9');
  });
});

describe('hosts routes — ssh config preview / import', () => {
  const preview: HostsRouteDeps['previewSshConfig'] = () => ({
    path: '/home/tester/.ssh/config',
    exists: true,
    default_username: 'tester',
    candidates: [
      {
        name: 'sshhost',
        host: '10.0.0.20',
        port: 22,
        port_explicit: false,
        username: 'root',
        auth_type: 'key',
        key_path: null,
        tags: [],
        disk_mounts: ['/', '/data'],
        group: '',
        owner: '',
        location: '',
        notes: '',
        warnings: [],
        valid: true,
        error: null,
      },
    ],
    errors: [],
    warnings: [],
  });

  it('returns the ssh config preview', async () => {
    const h = setup({ deps: { previewSshConfig: preview } });
    const res = await request(h.app).get('/api/settings/hosts/ssh-config').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('/home/tester/.ssh/config');
    expect(res.body.exists).toBe(true);
    expect(res.body.default_username).toBe('tester');
    expect(res.body.candidates).toHaveLength(1);
  });

  it('imports the selected ssh config hosts', async () => {
    const h = setup({ deps: { previewSshConfig: preview } });
    const res = await request(h.app)
      .post('/api/settings/hosts/ssh-config/import')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: ['sshhost'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.created).toContain('sshhost');
    expect(res.body).toHaveProperty('parse_errors');
  });

  it('rejects an ssh import selection that matches no candidates', async () => {
    const h = setup({ deps: { previewSshConfig: preview } });
    const res = await request(h.app)
      .post('/api/settings/hosts/ssh-config/import')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: ['ghost'] });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, error: 'no_matching_hosts', candidates: [] });
  });
});

describe('hosts routes — connectivity', () => {
  it('runs the batch connectivity test against injected runners', async () => {
    const h = setup({
      deps: {
        runner: (server) => ({
          exitStatus: server.name === 'alpha' ? 0 : 1,
          stdout: server.name === 'alpha' ? 'pong' : '',
          stderr: server.name === 'alpha' ? '' : 'denied',
        }),
      },
    });
    seedHost(h, 'alpha');
    const res = await request(h.app)
      .post('/api/settings/hosts/test-batch')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: ['alpha', 'ghost'] });
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.results.map((row: { name: string; ok: boolean; detail: string }) => [row.name, row]),
    );
    expect(byName.alpha.ok).toBe(true);
    expect(byName.alpha.detail).toBe('pong');
    expect(byName.ghost.ok).toBe(false);
    expect(byName.ghost.detail).toBe('主机不存在');
  });

  it('rejects a non-list batch names field with 400 invalid_payload', async () => {
    const h = setup({ deps: { runner: () => ({ exitStatus: 0 }) } });
    const res = await request(h.app)
      .post('/api/settings/hosts/test-batch')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: 'alpha' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('rejects an empty ad-hoc probe with 400 invalid', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/probe')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, status: 'invalid', message: '请填写服务器地址' });
  });

  it('blocks an ad-hoc probe that targets a private address', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/hosts/probe')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '127.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('blocked');
    expect(String(res.body.message)).toContain('已拒绝访问');
  });

  it('forwards an allow-listed ad-hoc probe to the injected prober', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1')],
      deps: { probeHost: () => ({ ok: true, latency_ms: 5 }) },
    });
    const res = await request(h.app)
      .post('/api/settings/hosts/probe')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '10.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, latency_ms: 5 });
  });

  it('reports a probe failure with 探测失败 prefix', async () => {
    const h = setup({
      servers: [makeServer('alpha', '10.0.0.1')],
      deps: {
        probeHost: () => {
          throw new Error('boom');
        },
      },
    });
    const res = await request(h.app)
      .post('/api/settings/hosts/probe')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ host: '10.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, status: 'error', message: '探测失败：boom' });
  });

  it('probes a saved host and 404s for an unknown one', async () => {
    const h = setup({ deps: { probeHost: () => ({ ok: true, status: 'ok' }) } });
    seedHost(h, 'alpha');
    const ok = await request(h.app).post('/api/settings/hosts/alpha/probe').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, status: 'ok' });
    const missing = await request(h.app)
      .post('/api/settings/hosts/ghost/probe')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});

describe('hosts routes — checks and container stats', () => {
  it('tests one posted check against a saved host', async () => {
    const h = setup({
      deps: { runHostChecks: (_host, checks) => checks.map((check) => ({ ...check, status: 'ok' })) },
    });
    seedHost(h, 'alpha');
    const res = await request(h.app)
      .post('/api/settings/hosts/alpha/checks/test')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ name: 'ssh', type: 'tcp', target: '22' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.results[0].status).toBe('ok');
  });

  it('rejects an invalid posted check with 400', async () => {
    const h = setup({ deps: { runHostChecks: () => [] } });
    seedHost(h, 'alpha');
    const res = await request(h.app)
      .post('/api/settings/hosts/alpha/checks/test')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ type: 'tcp', target: '22' });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('checks[0].name');
  });

  it('runs enabled checks, persists results and returns the outcome', async () => {
    const h = setup({
      deps: {
        runHostChecks: (_host, checks) =>
          checks.map((check) => ({ name: check.name, type: check.type, target: check.target, status: 'ok', latency_ms: 7 })),
      },
    });
    seedHost(h, 'alpha', { checks: [{ name: 'ssh', type: 'tcp', target: '22' }] });
    const res = await request(h.app).post('/api/host/alpha/checks/run').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.checks[0].name).toBe('ssh');
    expect(getHostCheckResults(h.fresh.db, 'alpha')).toHaveLength(1);
  });

  it('reports no configured checks without failing', async () => {
    const h = setup({ deps: { runHostChecks: () => [] } });
    seedHost(h, 'alpha');
    const res = await request(h.app).post('/api/host/alpha/checks/run').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, error: '该主机还没有配置服务检查' });
  });

  it('collects one container stats sample and 404s for an unknown host', async () => {
    const h = setup({ deps: { collectContainerStats: () => [{ name: 'web', cpu: '1%' }] } });
    seedHost(h, 'alpha');
    const ok = await request(h.app).post('/api/host/alpha/containers/stats').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(ok.body.containers).toHaveLength(1);
    expect(typeof ok.body.collected_at).toBe('string');
    const missing = await request(h.app).post('/api/host/ghost/containers/stats').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });
});

describe('hosts routes — collection status and immediate collection', () => {
  it('returns an empty status map without a provider', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/settings/hosts/collection-status').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statuses: {} });
  });

  it('delegates collection status to the provider', async () => {
    const h = setup({ deps: { collectionStatus: (names) => ({ alpha: { names } }) } });
    const res = await request(h.app)
      .get('/api/settings/hosts/collection-status?names=alpha,beta')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test');
    expect(res.status).toBe(200);
    expect(res.body.statuses).toEqual({ alpha: { names: ['alpha', 'beta'] } });
  });

  it('collects one host, 409s without a callback and 404s for an unknown host', async () => {
    const names: string[] = [];
    const h = setup({ deps: { collectHosts: (selected) => void names.push(...selected) } });
    seedHost(h, 'alpha');
    const ok = await request(h.app).post('/api/settings/hosts/alpha/collect').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true });
    expect(names).toEqual(['alpha']);

    const unavailable = setup();
    seedHost(unavailable, 'alpha');
    const conflict = await request(unavailable.app)
      .post('/api/settings/hosts/alpha/collect')
      .set('Cookie', unavailable.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({});
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ error: 'collection_unavailable' });

    const missing = await request(h.app).post('/api/settings/hosts/ghost/collect').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'not_found' });
  });

  it('collects selected saved hosts and reports the count', async () => {
    const calls: string[][] = [];
    const h = setup({ deps: { collectHosts: (selected) => void calls.push([...selected]) } });
    seedHost(h, 'alpha');
    seedHost(h, 'beta');
    const ok = await request(h.app)
      .post('/api/settings/hosts/collect')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: ['alpha', 'ghost'] });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, count: 1 });
    expect(calls).toEqual([['alpha']]);

    const empty = await request(h.app)
      .post('/api/settings/hosts/collect')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test')
      .send({ names: [] });
    expect(empty.body).toEqual({ ok: true, count: 0 });
  });

  it('maps collection failures to 500 collection_failed', async () => {
    const h = setup({
      deps: {
        collectHosts: () => {
          throw new Error('boom');
        },
      },
    });
    seedHost(h, 'alpha');
    const res = await request(h.app).post('/api/settings/hosts/alpha/collect').set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-test').send({});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'collection_failed' });
  });
});

/** Minimal HostConfig fixture (no DB row) for config-only servers. */
function makeServer(name: string, host: string): HostConfig {
  return {
    name,
    host,
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
  };
}
