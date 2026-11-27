/**
 * Disk-health trend endpoint (M6): `GET /api/disk-health/history` returns a
 * host's recent batches for the trend chart, and the disk-health page renders
 * one 「趋势」 toggle per host.
 */
import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebApp } from '../../src/web/app';
import { registerDiskHealthRoutes } from '../../src/web/routes/disk-health';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveDiskHealth } from '../../src/storage/disk';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

const DAY = 86_400_000;
const BASE = new Date('2026-11-01T00:00:00.000Z');

function makeConfig(servers: HostConfig[] = []): AppConfig {
  return {
    dbPath: '/tmp/disk-history-test.db',
    host: '0.0.0.0',
    port: 8080,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: '9.9.9-test',
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
  setAdminPassword(fresh.db, { newPassword: '{{SECRET_vwipbw7c}}', username: 'admin' });
  const config = makeConfig([{ name: 'h1', host: '10.0.0.1', group: 'gpu' } as HostConfig]);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerDiskHealthRoutes(instance, { db: fresh.db, config, appVersion: '9.9.9-test' });
    },
  });
  const cookie = (app.locals.session as SessionManager).createCookie({
    logged_in: true,
    username: 'admin',
    csrf_token: 'csrf-disk-trend',
  });
  return { fresh, app, cookie, config };
}

function seed(
  db: FreshDb['db'],
  hostName: string,
  dayOffset: number,
  status: string,
  health: string,
  temp: number,
): void {
  saveDiskHealth(db, {
    host_name: hostName,
    collected_at: new Date(BASE.getTime() + dayOffset * DAY),
    status,
    physical_drives: [{ controller: 0, enclosure: 0, slot: 0, health, temperature_c: temp }],
  });
}

describe('GET /api/disk-health/history', () => {
  it('returns the host trend points, oldest-first', async () => {
    const h = setup();
    seed(h.fresh.db, 'h1', 0, 'ok', 'healthy', 30);
    seed(h.fresh.db, 'h1', 1, 'degraded', 'warning', 44);

    const res = await request(h.app)
      .get('/api/disk-health/history?host=h1&days=30')
      .set('Cookie', h.cookie);

    expect(res.status).toBe(200);
    expect(res.body.host).toBe('h1');
    expect(res.body.days).toBe(30);
    expect(res.body.points).toHaveLength(2);
    expect(res.body.points[1].status).toBe('degraded');
    expect(res.body.points[1].max_temp).toBe(44);
  });

  it('rejects a missing host with 400', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/disk-health/history').set('Cookie', h.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_host');
  });

  it('rejects an out-of-range days value with 400', async () => {
    const h = setup();
    const res = await request(h.app)
      .get('/api/disk-health/history?host=h1&days=0')
      .set('Cookie', h.cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_days');
  });

  it('requires authentication', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/disk-health/history?host=h1');
    expect(res.status).toBe(401);
  });

  it('renders a trend toggle per host on the page', async () => {
    const h = setup();
    seed(h.fresh.db, 'h1', 0, 'ok', 'healthy', 30);
    const res = await request(h.app).get('/disk-health').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-disk-trend-toggle');
    expect(res.text).toContain('data-disk-trend');
    expect(res.text).toContain('/static/disk-health.js');
  });
});
