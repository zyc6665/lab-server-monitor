/**
 * Settings page layout (v0.3.12): left sidebar with grouped navigation.
 *
 * Guards the structural intent of the settings rewrite:
 *  - the three groups (数据采集 / 告警与通知 / 系统) are rendered;
 *  - 「看板与安全」and「运行日志」are no longer tabs;
 *  - listen address / port are no longer editable in the UI;
 *  - 修改密码 + 软件更新 + 运行日志 live inside 系统状态.
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
import { registerSettingsRoutes } from '../../src/web/routes/settings';
import { setAdminPassword } from '../../src/web/routes/auth';
import { loadEffectiveSettings, saveSection } from '../../src/config/service';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
  delete process.env.SERVERMONITOR_DESKTOP;
});

function makeConfig(servers: HostConfig[] = []): AppConfig {
  return {
    dbPath: '/tmp/settings-layout.db',
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

function setup(): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'test-pass', username: 'admin' });
  const config = makeConfig();
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSettingsRoutes(instance, { db: fresh.db, config, appVersion: 'test' });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: 'csrf-layout',
  });
  return { fresh, app, cookie, config };
}

describe('settings page layout', () => {
  it('renders the grouped left sidebar', async () => {
    const h = setup();
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('class="settings-sidebar"');
    expect(res.text).toContain('class="settings-layout"');
    expect(res.text).toContain('class="settings-content"');
    for (const label of ['数据采集', '告警与通知', '系统']) {
      expect(res.text).toContain(`class="settings-nav-title">${label}</p>`);
    }
  });

  it('no longer exposes dashboard or logs as tabs', async () => {
    const h = setup();
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    const tabs = [...res.text.matchAll(/data-settings-tab="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(tabs)).toEqual(
      new Set(['monitoring', 'hosts', 'user_monitoring', 'disk_health', 'alerts', 'smtp', 'report', 'health']),
    );
    expect(tabs).not.toContain('dashboard');
    expect(tabs).not.toContain('logs');
  });

  it('folds the account-safety, update and log viewer into the system section', async () => {
    const h = setup();
    process.env.SERVERMONITOR_DESKTOP = '1';
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('账号与安全');
    expect(res.text).toContain('修改管理员密码');
    expect(res.text).toContain('id="software-update"');
    expect(res.text).toContain('id="settings-logs"');
    expect(res.text).toContain('id="logs-output"');
    const healthStart = res.text.indexOf('data-section="health"');
    expect(healthStart).toBeGreaterThan(-1);
    const healthHtml = res.text.slice(healthStart);
    expect(healthHtml.indexOf('id="software-update"')).toBeGreaterThan(-1);
    expect(healthHtml.indexOf('id="settings-logs"')).toBeGreaterThan(-1);
  });

  it('drops the editable listen address and port fields', async () => {
    const h = setup();
    const res = await request(h.app).get('/settings').set('Cookie', h.cookie);
    const dashStart = res.text.indexOf('data-section="dashboard"');
    expect(dashStart).toBeGreaterThan(-1);
    const dashHtml = res.text.slice(dashStart, dashStart + 1500);
    expect(dashHtml).not.toContain('data-field="host"');
    expect(dashHtml).not.toContain('data-field="port"');
    expect(dashHtml).not.toContain('data-field="username"');
    expect(dashHtml).toContain('data-field="session_lifetime_hours"');
  });

  it('saves the login lifetime from the security block', async () => {
    const h = setup();
    saveSection(h.fresh.db, 'dashboard', { session_lifetime_hours: 12 });
    const res = await request(h.app)
      .put('/api/settings/dashboard')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', 'csrf-layout')
      .send({ session_lifetime_hours: 24 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, restart_required: true });
    const stored = loadEffectiveSettings(h.fresh.db).dashboard as Record<string, unknown>;
    expect(stored.session_lifetime_hours).toBe(24);
  });
});
