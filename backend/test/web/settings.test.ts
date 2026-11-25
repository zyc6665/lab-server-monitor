/**
 * Integration tests for the settings routes (P2 Task 12).
 *
 * Every case mounts the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. Outbound dial-outs (SSH / SMTP / desktop /
 * webhook) are injected stubs, so no test opens a real connection. DPAPI is
 * replaced with an identity stub so secrets round-trip without the Windows
 * store.
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
import { registerSettingsRoutes, type SettingsRouteDeps } from '../../src/web/routes/settings';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveSection } from '../../src/config/service';
import { upsertHost } from '../../src/config/hosts';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

function makeConfig(servers: HostConfig[] = []): AppConfig {
  return {
    dbPath: '/tmp/settings-test.db',
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

/** Builds a fully wired app with `registerSettingsRoutes` mounted. */
function setup(options: {
  authenticate?: boolean;
  servers?: HostConfig[];
  userMode?: boolean;
  deps?: Partial<SettingsRouteDeps>;
} = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'secret-password', username: 'admin' });
  if (options.userMode) {
    saveSection(fresh.db, 'monitoring', { mode: 'user', member_account: 'alice' });
  }
  const config = makeConfig(options.servers ?? []);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSettingsRoutes(instance, { db: fresh.db, config, appVersion: 'test', ...(options.deps ?? {}) });
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

/** Auth headers for an unsafe method. */
function authHeaders(h: Harness): Record<string, string> {
  return { Cookie: h.cookie, 'X-CSRF-Token': 'csrf-test' };
}

describe('settings routes — authentication', () => {
  it('redirects the page to /login when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/settings');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 for the API when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/api/settings');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });
});

describe('settings page', () => {
  it('renders the admin settings page', async () => {
    const h = setup();
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('id="settings-root"');
    expect(res.text).toContain('设置');
  });

  it('renders the user settings page in user mode', async () => {
    const h = setup({ userMode: true });
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="settings-user-root"');
    expect(res.text).toContain('使用模式');
  });
});

describe('GET /api/settings', () => {
  it('returns the masked settings payload', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.writable).toBe(true);
    expect(res.body.version).toBe('test');
    expect(res.body.monitoring.mode).toBe('admin');
    expect(res.body.smtp.password_configured).toBe(false);
    expect(res.body.alerts.webhook.url_configured).toBe(false);
  });

  it('masks a saved SMTP password as a boolean', async () => {
    const h = setup();
    const saved = await request(h.app)
      .put('/api/settings/smtp')
      .set(authHeaders(h))
      .send({
        host: 'smtp.example.com',
        port: 465,
        username: 'mailer',
        password: 'top-secret-pw',
        from_addr: 'monitor@example.com',
        to_addrs: ['ops@example.com'],
        use_ssl: true,
      });
    expect(saved.status).toBe(200);
    const res = await request(h.app).get('/api/settings').set('Cookie', h.cookie);
    expect(res.body.smtp.password_configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('top-secret-pw');
  });

  it('includes the masked host inventory', async () => {
    const h = setup();
    upsertHost(
      h.fresh.db,
      {
        name: 'web-1',
        host: '10.0.0.1',
        port: 22,
        username: 'root',
        auth_type: 'password',
        password: 'pw',
      },
      { writable: true, baseServers: h.config.servers },
    );
    const res = await request(h.app).get('/api/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.hosts).toHaveLength(1);
    expect(res.body.hosts[0].name).toBe('web-1');
    expect(res.body.hosts[0].password_configured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('"pw"');
  });
});

describe('PUT /api/settings/<section>', () => {
  it('saves a valid section', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .send({ poll_interval_seconds: 300 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, restart_required: false });
    const read = await request(h.app).get('/api/settings').set('Cookie', h.cookie);
    expect(read.body.monitoring.poll_interval_seconds).toBe(300);
  });

  it('reports restart_required for the dashboard section', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/dashboard')
      .set(authHeaders(h))
      .send({ host: '0.0.0.0', port: 9090 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, restart_required: true });
  });

  it('returns 400 with errors for invalid values', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .send({ host_metrics_max_points: 5 });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('returns 404 for an unknown section', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/nope')
      .set(authHeaders(h))
      .send({ foo: 'bar' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'unknown_section' });
  });

  it('returns 409 when settings are not writable', async () => {
    const h = setup({ deps: { writable: false } });
    const res = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .send({ poll_interval_seconds: 300 });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'settings_not_writable' });
  });

  it('rejects a non-object payload with 400 invalid_payload', async () => {
    const h = setup();
    const res = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .set('Content-Type', 'application/json')
      .send([]);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_payload' });
  });

  it('restricts user-mode writes to mode + member_account', async () => {
    const h = setup({ userMode: true });
    const extra = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .send({ mode: 'user', member_account: 'alice', poll_interval_seconds: 60 });
    expect(extra.status).toBe(403);
    expect(extra.body).toEqual({
      error: 'admin_only',
      message: '用户模式下只能修改使用模式与账号名',
    });

    const ok = await request(h.app)
      .put('/api/settings/monitoring')
      .set(authHeaders(h))
      .send({ mode: 'user', member_account: 'bob' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });
});

describe('POST /api/settings/test-ssh', () => {
  it('rejects an empty host with HTTP 200', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/test-ssh')
      .set(authHeaders(h))
      .send({ host: '  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, detail: 'host 不能为空' });
  });

  it('blocks an internal target', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/test-ssh')
      .set(authHeaders(h))
      .send({ host: '127.0.0.1' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).toContain('内网');
  });

  it('returns the probe output on success', async () => {
    const h = setup({ deps: { testSsh: () => 'ok\n' } });
    const res = await request(h.app)
      .post('/api/settings/test-ssh')
      .set(authHeaders(h))
      .send({ host: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, detail: 'ok\n' });
  });

  it('returns a failure detail when the probe throws', async () => {
    const h = setup({
      deps: {
        testSsh: () => {
          throw new Error('connection refused');
        },
      },
    });
    const res = await request(h.app)
      .post('/api/settings/test-ssh')
      .set(authHeaders(h))
      .send({ host: '8.8.8.8' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, detail: 'connection refused' });
  });
});

describe('POST /api/settings/test-email', () => {
  it('rejects an empty host', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/test-email')
      .set(authHeaders(h))
      .send({ host: '' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, detail: 'host 不能为空' });
  });

  it('reports SMTP success through the injected tester', async () => {
    let observed: unknown;
    const h = setup({
      deps: {
        testSmtp: (config) => {
          observed = config;
        },
      },
    });
    const res = await request(h.app)
      .post('/api/settings/test-email')
      .set(authHeaders(h))
      .send({ host: '8.8.8.8', port: 465, username: 'u', password: 'pw', use_ssl: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, detail: 'SMTP 连接与登录成功' });
    expect(observed).toEqual({ host: '8.8.8.8', port: 465, username: 'u', password: 'pw', use_ssl: true });
  });
});

describe('POST /api/settings/test-desktop', () => {
  it('reports success when the notifier delivers', async () => {
    const h = setup({ deps: { sendDesktopNotification: () => true } });
    const res = await request(h.app).post('/api/settings/test-desktop').set(authHeaders(h)).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, detail: '已发送桌面通知' });
  });

  it('reports failure when no notifier is injected', async () => {
    const h = setup();
    const res = await request(h.app).post('/api/settings/test-desktop').set(authHeaders(h)).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).toContain('桌面通知发送失败');
  });
});

describe('POST /api/settings/test-webhook', () => {
  it('rejects an empty url', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/test-webhook')
      .set(authHeaders(h))
      .send({ url: '' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, detail: 'url 不能为空' });
  });

  it('blocks an internal URL', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/settings/test-webhook')
      .set(authHeaders(h))
      .send({ url: 'http://127.0.0.1:9000/hook' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.detail).toContain('内网');
  });

  it('sends through the injected webhook sender', async () => {
    const h = setup({ deps: { sendWebhook: () => true } });
    const res = await request(h.app)
      .post('/api/settings/test-webhook')
      .set(authHeaders(h))
      .send({ url: 'http://8.8.8.8/hook', type: 'feishu' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, detail: '已发送' });
  });
});
