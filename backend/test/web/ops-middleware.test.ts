/** Operational middleware (P3-2): audit rows, rate limiting, slow-request log. */
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { recordAudit, listAudit } from '../../src/storage/audit';
import { registerOpsMiddleware } from '../../src/web/ops-middleware';
import type { AppConfig } from '../../src/config/config';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(() => {
  cleanupStorageTests();
});

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    dbPath: '/tmp/ops.db',
    host: '0.0.0.0',
    port: 8080,
    dataDir: '',
    logDir: '',
    servers: [],
    appVersion: 'test',
    ...overrides,
  };
}

describe('ops middleware', () => {
  it('records an audit row for mutating requests, not for reads', async () => {
    const fresh = freshDb();
    const app = express();
    registerOpsMiddleware(app, { db: fresh.db, config: makeConfig(), disableRateLimit: true });
    app.post('/api/things', (_req, res) => res.status(201).json({ ok: true }));
    app.get('/api/things', (_req, res) => res.json({ items: [] }));
    await request(app).post('/api/things').expect(201);
    await request(app).get('/api/things').expect(200);
    const rows = listAudit(fresh.db, { limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('POST /api/things');
    expect(rows[0].target).toBe('/api/things');
    expect(rows[0].result).toBe('ok');
  });

  it('records a non-2xx mutating request as an error result', async () => {
    const fresh = freshDb();
    const app = express();
    registerOpsMiddleware(app, { db: fresh.db, config: makeConfig(), disableRateLimit: true });
    app.post('/api/fail', (_req, res) => res.status(400).json({ error: 'bad' }));
    await request(app).post('/api/fail').expect(400);
    const rows = listAudit(fresh.db, { limit: 5 });
    expect(rows[0].result).toBe('error:400');
  });

  it('rate limits writes above the per-minute budget with 429', async () => {
    const fresh = freshDb();
    const app = express();
    registerOpsMiddleware(app, { db: fresh.db, config: makeConfig(), writeLimitPerMinute: 3 });
    app.post('/api/things', (_req, res) => res.json({ ok: true }));
    expect((await request(app).post('/api/things')).status).toBe(200);
    expect((await request(app).post('/api/things')).status).toBe(200);
    expect((await request(app).post('/api/things')).status).toBe(200);
    expect((await request(app).post('/api/things')).status).toBe(429);
  });

  it('writes slow requests to slow.log when logDir is set', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const logDir = mkdtempSync(join(tmpdir(), 'ops-slow-'));
    const fresh = freshDb();
    const app = express();
    registerOpsMiddleware(app, { db: fresh.db, config: makeConfig({ logDir }), slowMs: -1, disableRateLimit: true });
    app.get('/api/slow', (_req, res) => res.json({ ok: true }));
    await request(app).get('/api/slow').expect(200);
    const content = readFileSync(join(logDir, 'slow.log'), 'utf8');
    expect(content).toContain('GET /api/slow');
  });
});

describe('audit storage', () => {
  it('filters by actor and action and enforces the limit', () => {
    const fresh = freshDb();
    recordAudit(fresh.db, { actor: 'admin', action: 'POST /a', target: '/a', result: 'ok' });
    recordAudit(fresh.db, { actor: 'ops', action: 'PUT /b', target: '/b', result: 'ok' });
    recordAudit(fresh.db, { actor: 'admin', action: 'DELETE /c', target: '/c', result: 'ok' });
    expect(listAudit(fresh.db, { actor: 'admin' })).toHaveLength(2);
    expect(listAudit(fresh.db, { action: 'PUT /b' })).toHaveLength(1);
    expect(listAudit(fresh.db, { limit: 2 })).toHaveLength(2);
  });

  it('never throws when the audit table is missing', () => {
    const fresh = freshDb();
    fresh.db.exec('DROP TABLE audit_log');
    expect(() => recordAudit(fresh.db, { action: 'POST /x' })).not.toThrow();
  });
});
