/**
 * Integration tests for the system routes (P2 Task 15).
 *
 * Every case mounts the full middleware chain through {@link createWebApp} on a
 * fresh temp SQLite database. External collaborators (SSH known-host store,
 * runtime-state file, administrative cleanup targets and restore hooks) are
 * injected so no test opens a real connection or rewrites the live database.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebApp } from '../../src/web/app';
import { registerSystemRoutes, type SystemRouteDeps } from '../../src/web/routes/system';
import { setAdminPassword } from '../../src/web/routes/auth';
import { saveSection } from '../../src/config/service';
import { backupDatabase } from '../../src/storage/runtime';
import type { AppConfig, HostConfig } from '../../src/config/config';
import type { SessionManager } from '../../src/web/session';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';

afterEach(() => {
  cleanupStorageTests();
});

const CSRF_TOKEN = 'csrf-system-token';
const createdRoots: string[] = [];

/** Builds a minimal {@link AppConfig} for the harness. */
function makeConfig(servers: HostConfig[] = []): AppConfig {
  return {
    dbPath: '/tmp/system-test.db',
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
  root: string;
}

/** Builds a fully wired app with {@link registerSystemRoutes} mounted. */
function setup(options: {
  authenticate?: boolean;
  servers?: HostConfig[];
  userMode?: boolean;
  deps?: Partial<SystemRouteDeps>;
} = {}): Harness {
  const fresh = freshDb();
  setAdminPassword(fresh.db, { newPassword: 'admin-secret', username: 'admin' });
  if (options.userMode) {
    saveSection(fresh.db, 'monitoring', { mode: 'user', member_account: 'alice' });
  }
  const root = mkdtempSync(path.join(tmpdir(), 'sm-system-'));
  createdRoots.push(root);
  const config = makeConfig(options.servers ?? []);
  const app = createWebApp({
    db: fresh.db,
    config,
    mountStatic: false,
    registerRoutes: (instance) => {
      registerSystemRoutes(instance, {
        db: fresh.db,
        config,
        appVersion: '9.9.9-test',
        logFile: path.join(root, 'servermonitor.log'),
        runtimeFile: path.join(root, 'runtime.json'),
        ...(options.deps ?? {}),
      });
    },
  });
  const cookie = options.authenticate === false
    ? ''
    : (app.locals.session as SessionManager).createCookie({
        logged_in: true,
        username: 'admin',
        csrf_token: CSRF_TOKEN,
      });
  return { fresh, app, cookie, config, root };
}

function authHeaders(h: Harness): Record<string, string> {
  return { Cookie: h.cookie, 'X-CSRF-Token': CSRF_TOKEN };
}

afterEach(() => {
  // Clean up the per-test log/runtime temp directories created by setup().
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('system routes — authentication', () => {
  it('returns 401 for an API endpoint when unauthenticated', async () => {
    const h = setup({ authenticate: false });
    const res = await request(h.app).get('/api/system/health');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('blocks the admin API in user mode with 403', async () => {
    const h = setup({ userMode: true });
    const res = await request(h.app).get('/api/system/health').set('Cookie', h.cookie);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'admin_only', message: '该功能仅在管理员模式下可用' });
  });

  it('still allows /api/runtime in user mode (allowlisted)', async () => {
    const h = setup({ userMode: true });
    const res = await request(h.app).get('/api/runtime').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
  });

  it('rejects a state-changing request without a CSRF token', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/system/maintenance')
      .set('Cookie', h.cookie)
      .send({ target: 'database' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'csrf_failed', message: '页面已过期，请刷新页面后重试' });
  });
});

describe('GET /api/system/host-keys', () => {
  it('returns the injected host-key map', async () => {
    const h = setup({ deps: { listKnownHostKeys: () => ({ 'example.com': { key: 'ssh-ed25519 AAA' } }) } });
    const res = await request(h.app).get('/api/system/host-keys').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: { 'example.com': { key: 'ssh-ed25519 AAA' } } });
  });

  it('defaults to an empty host map when no store is injected', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/system/host-keys').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: {} });
  });
});

describe('DELETE /api/system/host-keys/:hostname', () => {
  it('returns ok when the key was removed', async () => {
    const h = setup({ deps: { forgetHostKey: () => true } });
    const res = await request(h.app)
      .delete('/api/system/host-keys/example.com')
      .set(authHeaders(h));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, host: 'example.com' });
  });

  it('returns 404 when no key record existed', async () => {
    const h = setup({ deps: { forgetHostKey: () => false } });
    const res = await request(h.app)
      .delete('/api/system/host-keys/ghost.example')
      .set(authHeaders(h));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found', message: '没有这个主机的密钥记录' });
  });
});

describe('GET /api/system/health', () => {
  it('returns the full health structure with diagnostics and stats', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/system/health').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('9.9.9-test');
    expect(res.body.runtime).toEqual({});
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.hosts_configured).toBe(0);
    expect(res.body.diagnostics).toBeTypeOf('object');
    expect(Array.isArray(res.body.diagnostics.checks)).toBe(true);
    const dbCheck = res.body.diagnostics.checks.find(
      (check: { key: string }) => check.key === 'database',
    );
    expect(dbCheck.status).toBe('ok');
    expect(dbCheck.message).toBe('完整性检查通过');
    // system_stats spread
    expect(res.body.db_path).toBe(h.fresh.dbPath);
    expect(typeof res.body.db_size_bytes).toBe('number');
    expect(res.body.host_snapshots).toBe(0);
    expect(res.body.history_rows).toBe(0);
    expect(res.body.disk_batches).toBe(0);
    expect(res.body.alerts_active).toBe(0);
  });

  it('reports the configured host count and runtime state', async () => {
    const h = setup({ servers: [host('alpha')] });
    writeFileSync(
      path.join(h.root, 'runtime.json'),
      JSON.stringify({ url: 'http://127.0.0.1:9000', port: 9000, pid: 4321 }),
    );
    const res = await request(h.app).get('/api/system/health').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.hosts_configured).toBe(1);
    expect(res.body.runtime).toEqual({ url: 'http://127.0.0.1:9000', port: 9000, pid: 4321 });
  });
});

describe('GET /api/system/storage', () => {
  it('returns the disk-usage snapshot', async () => {
    const usage = { database: 100, logs: 20, updates: 0, electron: 0, total: 120 };
    const h = setup({ deps: { storageUsage: () => usage } });
    const res = await request(h.app).get('/api/system/storage').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ usage, db_path: h.fresh.dbPath, log_retention_hours: 24 });
  });
});

describe('POST /api/system/maintenance', () => {
  it('rejects an unknown target with 400', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/system/maintenance')
      .set(authHeaders(h))
      .send({ target: 'nonsense' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_target' });
  });

  it('rejects an empty target with 400', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/system/maintenance')
      .set(authHeaders(h))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'unknown_target' });
  });

  it('runs the database target and returns the usage', async () => {
    const usage = { database: 1, logs: 2, updates: 3, electron: 4, total: 10 };
    const h = setup({
      deps: {
        storageUsage: () => usage,
        maintenanceTargets: { database: () => ({ vacuumed: true, incremental: false, free_pages: 0 }) },
      },
    });
    const res = await request(h.app)
      .post('/api/system/maintenance')
      .set(authHeaders(h))
      .send({ target: 'database' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      target: 'database',
      result: { vacuumed: true, incremental: false, free_pages: 0 },
      usage,
    });
  });

  it('dispatches each cleanup target to the injected handler', async () => {
    const calls: string[] = [];
    const h = setup({
      deps: {
        storageUsage: () => ({ database: 0, logs: 0, updates: 0, electron: 0, total: 0 }),
        maintenanceTargets: {
          logs: () => { calls.push('logs'); return { deleted: 1, bytes: 2 }; },
          updates: () => { calls.push('updates'); return { deleted: 3, bytes: 4 }; },
          cache: () => { calls.push('cache'); return { deleted: 5, bytes: 6 }; },
        },
      },
    });
    for (const target of ['logs', 'updates', 'cache']) {
      const res = await request(h.app)
        .post('/api/system/maintenance')
        .set(authHeaders(h))
        .send({ target });
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.target).toBe(target);
    }
    expect(calls).toEqual(['logs', 'updates', 'cache']);
  });

  it('deletes rotated .log.N files with the default logs handler', async () => {
    // Build a db whose grandparent directory is a temp root, so the route's
    // `appDir = dirname(dirname(db.name))` resolves to `<root>` and its logs
    // directory is `<root>/logs`.
    const root = mkdtempSync(path.join(tmpdir(), 'sm-system-logs-'));
    createdRoots.push(root);
    const dataDir = path.join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    const db = openDatabase(path.join(dataDir, 'servermonitor.db'));
    initSchema(db);
    try {
      setAdminPassword(db, { newPassword: 'admin-secret', username: 'admin' });
      const logsDir = path.join(root, 'logs');
      mkdirSync(logsDir, { recursive: true });
      const oldTs = new Date(Date.now() - 48 * 60 * 60 * 1000);
      for (const name of ['app.log', 'app.log.1']) {
        const filePath = path.join(logsDir, name);
        writeFileSync(filePath, 'old');
        utimesSync(filePath, oldTs, oldTs);
      }
      writeFileSync(path.join(logsDir, 'servermonitor.log'), 'live');

      const config = makeConfig();
      const app = createWebApp({
        db,
        config,
        mountStatic: false,
        registerRoutes: (instance) => {
          registerSystemRoutes(instance, {
            db,
            config,
            appVersion: '9.9.9-test',
            logFile: path.join(root, 'servermonitor.log'),
            runtimeFile: path.join(root, 'runtime.json'),
          });
        },
      });
      const cookie = (app.locals.session as SessionManager).createCookie({
        logged_in: true,
        username: 'admin',
        csrf_token: CSRF_TOKEN,
      });

      const res = await request(app)
        .post('/api/system/maintenance')
        .set({ Cookie: cookie, 'X-CSRF-Token': CSRF_TOKEN })
        .send({ target: 'logs' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.result.deleted).toBe(2);
      expect(existsSync(path.join(logsDir, 'app.log.1'))).toBe(false);
      expect(existsSync(path.join(logsDir, 'app.log'))).toBe(false);
      expect(existsSync(path.join(logsDir, 'servermonitor.log'))).toBe(true);
    } finally {
      if (db.open) {
        db.close();
      }
    }
  });
});

describe('GET /api/system/backup', () => {
  it('streams a SQLite snapshot as an attachment', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/system/backup').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="servermonitor-backup-\d{8}-\d{6}\.db"/,
    );
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.subarray(0, 15).toString('latin1')).toBe('SQLite format 3');
  });
});

describe('POST /api/system/restore', () => {
  it('returns 400 when no file is uploaded', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/system/restore')
      .set(authHeaders(h))
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: '请选择备份文件' });
  });

  it('returns 400 when the upload is not a valid backup', async () => {
    const h = setup();
    const res = await request(h.app)
      .post('/api/system/restore')
      .set(authHeaders(h))
      .attach('file', Buffer.from('not a database at all'), 'garbage.db');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('不是有效的 SQLite 数据库文件');
  });

  it('returns 413 when the upload exceeds the configured ceiling', async () => {
    const h = setup({ deps: { maxRestoreBytes: 8 } });
    const res = await request(h.app)
      .post('/api/system/restore')
      .set(authHeaders(h))
      .attach('file', Buffer.alloc(64, 0x41), 'big.db');
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: '备份文件不能超过 100 MB' });
  });

  it('restores a valid backup and reports restart_required', async () => {
    const h = setup();
    // Produce a real, validated SQLite backup to upload.
    const backupDir = mkdtempSync(path.join(tmpdir(), 'sm-backup-src-'));
    const backupPath = path.join(backupDir, 'valid.db');
    await backupDatabase(h.fresh.db, backupPath);
    const bytes = readFileSync(backupPath) as Buffer;

    const restores: string[] = [];
    const h2 = setup({
      deps: {
        restore: {
          backup: async () => { restores.push('backup'); },
          restore: async () => { restores.push('restore'); },
          initSchema: () => { restores.push('initSchema'); },
        },
      },
    });
    const res = await request(h2.app)
      .post('/api/system/restore')
      .set(authHeaders(h2))
      .attach('file', bytes, 'valid.db');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.restart_required).toBe(true);
    expect(typeof res.body.safety_backup).toBe('string');
    expect(res.body.safety_backup).toContain('pre-restore-');
    expect(res.body.message).toBe('数据库已恢复，请关闭并重新打开工具使配置生效。');
    expect(restores).toEqual(['backup', 'restore', 'initSchema']);

    rmSync(backupDir, { recursive: true, force: true });
  });
});

describe('GET /api/system/config-export', () => {
  it('downloads the masked configuration as JSON', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/system/config-export').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename=servermonitor-config.json',
    );
    expect(typeof res.body).toBe('object');
  });

  it('returns 404 when the settings service is unavailable', async () => {
    const h = setup({ deps: { exportConfig: () => null } });
    const res = await request(h.app).get('/api/system/config-export').set('Cookie', h.cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'settings service unavailable' });
  });
});

describe('GET /api/logs', () => {
  it('returns an empty tail when the log file is missing', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/logs').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      path: path.join(h.root, 'servermonitor.log'),
      lines: '',
      text: '',
      line_count: 0,
    });
  });

  it('returns the requested tail of the log file', async () => {
    const h = setup();
    writeFileSync(path.join(h.root, 'servermonitor.log'), 'one\ntwo\nthree\nfour\n');
    const res = await request(h.app).get('/api/logs?lines=2').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.line_count).toBe(2);
    expect(res.body.lines).toBe('three\nfour\n');
    expect(res.body.text).toBe('three\nfour\n');
  });

  it('falls back to 200 lines for a non-numeric parameter', async () => {
    const h = setup();
    writeFileSync(path.join(h.root, 'servermonitor.log'), 'a\nb\nc\n');
    const res = await request(h.app).get('/api/logs?lines=abc').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.line_count).toBe(3);
  });
});

describe('GET /api/logs/download', () => {
  it('returns 404 when the log file is missing', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/logs/download').set('Cookie', h.cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'log file not found' });
  });

  it('downloads the log file as an attachment', async () => {
    const h = setup();
    writeFileSync(path.join(h.root, 'servermonitor.log'), 'hello log\n');
    const res = await request(h.app).get('/api/logs/download').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['content-disposition']).toContain('servermonitor.log');
    expect(res.text).toBe('hello log\n');
  });
});

describe('GET /api/runtime', () => {
  it('returns {url:null} when there is no runtime state', async () => {
    const h = setup();
    const res = await request(h.app).get('/api/runtime').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: null });
  });

  it('returns the runtime state when present', async () => {
    const h = setup();
    writeFileSync(
      path.join(h.root, 'runtime.json'),
      JSON.stringify({ url: 'http://127.0.0.1:63610', port: 63610, pid: 777 }),
    );
    const res = await request(h.app).get('/api/runtime').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'http://127.0.0.1:63610', port: 63610, pid: 777 });
  });
});

/** Builds a minimal {@link HostConfig} for diagnostics tests. */
function host(name: string): HostConfig {
  return {
    name,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { type: 'password', password: 'x' },
    tags: [],
    disk_mounts: ['/'],
    group: 'default',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
  } as HostConfig;
}
