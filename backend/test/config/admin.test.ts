import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AdminError,
  backupInfo,
  directorySize,
  exportConfig,
  maintenance,
  maintenanceInfo,
  readSecretJson,
  readSecretText,
  restoreFromUpload,
  secretStatuses,
  storeSecret,
} from '../../src/config/admin';
import { SECRET_ADMIN, SECRET_SESSION, SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL } from '../../src/config/secrets';
import { publicSettings } from '../../src/config/service';
import { backupDatabase, validateBackupDatabase } from '../../src/storage/runtime';
import { getSecret } from '../../src/storage/secrets';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

const protectStub = (plain: Buffer): Buffer => Buffer.concat([Buffer.from('enc:'), plain]);
const unprotectStub = (blob: Buffer): Buffer => blob.subarray(4);

function errorFrom(fn: () => unknown): AdminError {
  try {
    fn();
  } catch (err) {
    return err as AdminError;
  }
  throw new Error('expected a throw');
}

describe('directorySize', () => {
  it('sums file and directory contents and treats missing paths as zero', () => {
    const { dbPath } = freshDb();
    const dir = path.dirname(dbPath);
    const logs = path.join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(path.join(logs, 'a.log'), 'xxxxx');

    expect(directorySize(path.join(logs, 'a.log'))).toBe(5);
    expect(directorySize(logs)).toBe(5);
    expect(directorySize(path.join(dir, 'does-not-exist'))).toBe(0);
  });
});

describe('maintenanceInfo', () => {
  it('reports usage, db_path and a 24h log retention window', () => {
    const { db, dbPath } = freshDb();
    const dir = path.dirname(dbPath);
    mkdirSync(path.join(dir, 'logs'), { recursive: true });
    writeFileSync(path.join(dir, 'logs', 'servermonitor.log'), 'hello');

    const info = maintenanceInfo(db);
    expect(info.db_path).toBe(dbPath);
    expect(info.log_retention_hours).toBe(24);
    expect(info.usage.database).toBeGreaterThan(0);
    expect(info.usage.logs).toBeGreaterThanOrEqual(5);
    expect(info.usage.total).toBeGreaterThanOrEqual(info.usage.database + info.usage.logs);
    expect(Object.keys(info.usage).sort()).toEqual([
      'database',
      'electron',
      'logs',
      'total',
      'updates',
    ]);
    expect(maintenance(db)).toEqual(info);
  });
});

describe('backupInfo', () => {
  it('lists the .db files living in the backup directory', () => {
    const { db, dbPath } = freshDb();
    const backupsDir = path.join(path.dirname(dbPath), 'backups');
    mkdirSync(backupsDir, { recursive: true });
    writeFileSync(path.join(backupsDir, 'one.db'), 'x');
    writeFileSync(path.join(backupsDir, 'two.db'), 'yy');
    writeFileSync(path.join(backupsDir, 'ignore.txt'), 'zzz');

    const info = backupInfo(db);
    expect(info.backup_dir).toBe(backupsDir);
    expect(info.backups.map((entry) => entry.name).sort()).toEqual(['one.db', 'two.db']);
    expect(info.backups.find((entry) => entry.name === 'two.db')?.size).toBe(2);
    expect(info.latest?.name).toBeDefined();
  });
});

describe('exportConfig', () => {
  it('serialises public settings as indented JSON with the oracle filename/mimetype', () => {
    const { db } = freshDb();
    const exported = exportConfig(db);
    expect(exported.filename).toBe('servermonitor-config.json');
    expect(exported.mimetype).toBe('application/json');
    expect(exported.body).toBe(JSON.stringify(publicSettings(db), null, 2));
    expect(JSON.parse(exported.body)).toEqual(publicSettings(db));
  });
});

describe('secret helpers', () => {
  it('round-trips text and JSON through the injected protect/unprotect', () => {
    const { db } = freshDb();
    storeSecret(db, 'demo:text', 'hello', { protect: protectStub, writable: true });
    expect(getSecret(db, 'demo:text')?.toString('utf8')).toBe('enc:hello');
    expect(readSecretText(db, 'demo:text', { unprotect: unprotectStub })).toBe('hello');

    storeSecret(db, 'demo:json', JSON.stringify({ hash: 'h', iterations: 1000 }), {
      protect: protectStub,
      writable: true,
    });
    expect(readSecretJson(db, 'demo:json', { unprotect: unprotectStub })).toEqual({
      hash: 'h',
      iterations: 1000,
    });
    // A non-JSON payload is reported as null rather than throwing.
    expect(readSecretJson(db, 'demo:text', { unprotect: unprotectStub })).toBeNull();
    // Missing secret -> null.
    expect(readSecretText(db, 'demo:missing', { unprotect: unprotectStub })).toBeNull();
  });

  it('refuses to store when settings are not writable', () => {
    const { db } = freshDb();
    const err = errorFrom(() => storeSecret(db, 'demo', 'x', { protect: protectStub, writable: false }));
    expect(err).toBeInstanceOf(AdminError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('settings are not writable on this platform');
  });
});

describe('secretStatuses', () => {
  it('reports which well-known secrets exist', () => {
    const { db } = freshDb();
    const empty = secretStatuses(db);
    expect(empty).toMatchObject({
      smtp_password: false,
      webhook_url: false,
      admin: false,
      session: false,
      total: 0,
      names: [],
    });

    storeSecret(db, SECRET_SMTP_PASSWORD, 'pw', { protect: protectStub, writable: true });
    storeSecret(db, SECRET_WEBHOOK_URL, 'url', { protect: protectStub, writable: true });
    storeSecret(db, SECRET_ADMIN, '{}', { protect: protectStub, writable: true });
    storeSecret(db, SECRET_SESSION, 's', { protect: protectStub, writable: true });

    const statuses = secretStatuses(db);
    expect(statuses).toMatchObject({
      smtp_password: true,
      webhook_url: true,
      admin: true,
      session: true,
      total: 4,
    });
    expect(statuses.names.sort()).toEqual(
      [SECRET_ADMIN, SECRET_SESSION, SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL].sort(),
    );
  });
});

describe('restoreFromUpload', () => {
  it('rejects a missing upload with a 400 error', async () => {
    const { db } = freshDb();
    await expect(restoreFromUpload(db, null)).rejects.toMatchObject({
      message: '请选择备份文件',
      status: 400,
    });
    await expect(restoreFromUpload(db, '')).rejects.toMatchObject({ message: '请选择备份文件' });
  });

  it('rejects an oversized upload with a 413 error', async () => {
    const { db, dbPath } = freshDb();
    const upload = path.join(path.dirname(dbPath), 'big.db');
    writeFileSync(upload, 'hello');
    await expect(restoreFromUpload(db, upload, { maxBytes: 4 })).rejects.toMatchObject({
      message: '备份文件不能超过 100 MB',
      status: 413,
    });
  });

  it('maps a validation failure to a 400 error carrying the reason', async () => {
    const { db, dbPath } = freshDb();
    const upload = path.join(path.dirname(dbPath), 'bad.db');
    writeFileSync(upload, 'not sqlite');
    await expect(
      restoreFromUpload(db, upload, {
        validate: () => {
          throw new Error('不是有效的 SQLite 数据库文件');
        },
      }),
    ).rejects.toMatchObject({ message: '不是有效的 SQLite 数据库文件', status: 400 });
  });

  it('takes a safety backup, restores and schedules a restart', async () => {
    const { db, dbPath } = freshDb();
    const dir = path.dirname(dbPath);
    const upload = path.join(dir, 'upload.db');
    writeFileSync(upload, 'x');

    const calls: { backup?: string; restore?: { source: string; destination: string }; init?: number } = {};
    const result = await restoreFromUpload(db, upload, {
      now: new Date('2026-03-01T00:00:00Z'),
      validate: () => undefined,
      backup: async (_db, destination) => {
        calls.backup = destination;
      },
      restore: async (source, destination) => {
        calls.restore = { source, destination };
      },
      initSchema: () => {
        calls.init = (calls.init ?? 0) + 1;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      restart_required: true,
      message: '数据库已恢复，请关闭并重新打开工具使配置生效。',
    });
    expect(path.dirname(result.safety_backup)).toBe(path.join(dir, 'backups'));
    expect(path.basename(result.safety_backup)).toMatch(/^pre-restore-.*\.db$/);
    expect(calls.backup).toBe(result.safety_backup);
    expect(calls.restore).toEqual({ source: upload, destination: dbPath });
    expect(calls.init).toBe(1);
  });

  it('accepts a real backup produced by backupDatabase', async () => {
    const { db, dbPath } = freshDb();
    const backupPath = path.join(path.dirname(dbPath), 'backups', 'real.db');
    await backupDatabase(db, backupPath);
    expect(() => validateBackupDatabase(backupPath)).not.toThrow();
    expect(backupInfo(db).backups.map((entry) => entry.name)).toContain('real.db');
  });
});
