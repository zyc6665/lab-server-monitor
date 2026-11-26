import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import type { AppConfig } from '../../src/config/config';
import { saveSection } from '../../src/config/service';
import { buildDailyReport, generateWeeklyReport } from '../../src/report/assemble';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { listReportRuns } from '../../src/storage/report-runs';
import { createWebApp } from '../../src/web/app';
import { setAdminPassword } from '../../src/web/routes/auth';
import { registerReportsRoutes, type ReportsRouteDeps } from '../../src/web/routes/reports';
import type { SessionManager } from '../../src/web/session';

const CSRF_TOKEN = 'csrf-reports-test';

const openDbs: Array<ReturnType<typeof openDatabase>> = [];

function memoryDb(): ReturnType<typeof openDatabase> {
  const db = openDatabase(':memory:');
  initSchema(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
});

function makeConfig(): AppConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers: [],
    appVersion: 'test',
  };
}

interface Harness {
  db: ReturnType<typeof openDatabase>;
  app: Express;
  cookie: string;
  sent: Array<{ subject: string; to: string[] }>;
}

function setup(options: {
  authenticate?: boolean;
  smtpReady?: boolean;
  sendImpl?: () => Promise<void>;
} = {}): Harness {
  const db = memoryDb();
  setAdminPassword(db, { newPassword: 'admin-password-1', username: 'admin' });
  if (options.smtpReady !== false) {
    saveSection(db, 'smtp', { host: 'smtp.local', port: 25, from_addr: 'noreply@example.com', to_addrs: ['ops@example.com'] });
  }
  const config = makeConfig();
  const sent: Array<{ subject: string; to: string[] }> = [];
  const deps: ReportsRouteDeps = {
    db,
    config,
    appVersion: 'test',
    buildReports: async (handle) => ({
      daily: buildDailyReport([], { generatedAt: '2026-01-01T00:00:00.000Z', subjectPrefix: '[Test]' }),
      weekly: generateWeeklyReport(handle, { tz: 'UTC' }),
    }),
    sendReport: async (_smtp, message) => {
      if (options.sendImpl) {
        await options.sendImpl();
      }
      sent.push({ subject: message.subject, to: message.toAddrs });
    },
  };
  const app = createWebApp({
    db,
    config,
    mountStatic: false,
    registerRoutes: (instance: Express) => {
      registerReportsRoutes(instance, deps);
    },
  });
  const cookie =
    options.authenticate === false
      ? ''
      : (app.locals.session as SessionManager).createCookie({
          logged_in: true,
          username: 'admin',
          csrf_token: CSRF_TOKEN,
        });
  return { db, app, cookie, sent };
}

describe('reports routes — auth + validation', () => {
  it('401 for the preview API when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/api/reports/preview?variant=technical');
    expect(res.status).toBe(401);
  });

  it('rejects an unknown variant', async () => {
    const h = setup();
    const res = await request(h.app)
      .get('/api/reports/preview?variant=nope')
      .set('Cookie', h.cookie);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_variant' });
  });

  it('renders the reports page', async () => {
    const h = setup();
    const res = await request(h.app).get('/reports').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('报表');
    expect(res.text).toContain('/static/pages/reports.js');
  });
});

describe('reports routes — preview', () => {
  it('returns subject/text/html for each variant', async () => {
    const h = setup();
    for (const variant of ['technical', 'executive', 'weekly']) {
      const res = await request(h.app)
        .get('/api/reports/preview?variant=' + variant)
        .set('Cookie', h.cookie);
      expect(res.status).toBe(200);
      expect(res.body.variant).toBe(variant);
      expect(typeof res.body.subject).toBe('string');
      expect(typeof res.body.text).toBe('string');
      expect(typeof res.body.html).toBe('string');
    }
  });
});

describe('reports routes — send', () => {
  it('sends and records a successful run', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/reports/send')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ variant: 'technical' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const runs = listReportRuns(h.db);
    expect(runs[0]).toMatchObject({ kind: 'daily', variant: 'technical', status: 'sent' });
  });

  it('records a failure and returns 502', async () => {
    const h = setup({ sendImpl: async () => { throw new Error('smtp down'); } });
    const res = await request(h.app)
      .post('/api/reports/send')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ variant: 'weekly' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('send_failed');
    const runs = listReportRuns(h.db);
    expect(runs[0]).toMatchObject({ kind: 'weekly', status: 'error', error: 'smtp down' });
  });

  it('rejects when SMTP is not configured', async () => {
    const h = setup({ smtpReady: false });
    const res = await request(h.app)
      .post('/api/reports/send')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ variant: 'technical' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('smtp_not_configured');
  });

  it('requires a CSRF token', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/reports/send')
      .set('Cookie', h.cookie)
      .send({ variant: 'technical' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('csrf_failed');
  });

  it('lists history after a send', async () => {
    const h = setup();
    await request(h.app)
      .post('/api/reports/send')
      .set('Cookie', h.cookie)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ variant: 'technical' });
    const res = await request(h.app).get('/api/reports/history').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.runs.length).toBe(1);
  });
});
