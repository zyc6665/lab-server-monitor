/**
 * Admin / maintenance helpers, mirroring the Python oracle's
 * `servermanage/maintenance.py`, `servermanage/settings/admin.py` and the
 * `/api/system/*` routes in `servermanage/web/routes/system.py`.
 *
 * Everything here is pure logic over an injected `better-sqlite3` handle: the
 * route layer (Task 15) is responsible for turning these results into HTTP
 * responses. Backups/restores reuse `../storage/runtime`; secret blobs are
 * DPAPI-protected through injectable `protect` / `unprotect` hooks so tests can
 * run without the platform API.
 */
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { protect, unprotect } from '../storage/dpapi';
import { backupDatabase, restoreDatabase, validateBackupDatabase } from '../storage/runtime';
import { initSchema } from '../storage/schema';
import { getSecret, listSecretNames, setSecret } from '../storage/secrets';

import { ConfigError } from './errors';
import { publicSettings } from './service';
import { SECRET_ADMIN, SECRET_SESSION, SECRET_SMTP_PASSWORD, SECRET_WEBHOOK_URL } from './secrets';

type SqliteDatabase = import('better-sqlite3').Database;

/** Upload size ceiling mirrored from the oracle's restore route (100 MB). */
const MAX_RESTORE_BYTES = 100 * 1024 * 1024;
/** How long log files are kept (the oracle reports a fixed 24h window). */
const LOG_RETENTION_HOURS = 24;

/** Thrown on an invalid admin/maintenance request (status 400 / 413). */
export class AdminError extends ConfigError {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'AdminError';
    this.status = options.status ?? 400;
    this.code = options.code ?? 'admin_error';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Disk usage / maintenance
// ---------------------------------------------------------------------------

/** Size in bytes of a file, or the recursive sum of a directory's files. */
export function directorySize(target: string): number {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return 0;
  }
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;

  let total = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      try {
        if (entry.isDirectory()) {
          walk(child);
        } else if (entry.isFile()) {
          total += statSync(child).size;
        }
      } catch {
        // Ignore files that vanish or cannot be stat-ed mid-walk.
      }
    }
  };
  walk(target);
  return total;
}

export interface StorageUsage {
  database: number;
  logs: number;
  updates: number;
  electron: number;
  total: number;
}

export interface MaintenanceInfo {
  usage: StorageUsage;
  db_path: string;
  log_retention_hours: number;
}

export interface MaintenanceOptions {
  dataDir?: string;
  logsDir?: string;
  updatesDir?: string;
  electronDir?: string;
}

/** Disk-usage snapshot for `GET /api/system/storage`. */
export function maintenanceInfo(
  db: SqliteDatabase,
  options: MaintenanceOptions = {},
): MaintenanceInfo {
  const dbPath = db.name;
  const dataDir = options.dataDir ?? dirname(dbPath);
  const logsDir = options.logsDir ?? join(dataDir, 'logs');
  const updatesDir = options.updatesDir ?? join(dataDir, 'updates');
  const electronDir = options.electronDir ?? join(dataDir, 'electron');

  const usage: StorageUsage = {
    database: directorySize(dbPath),
    logs: directorySize(logsDir),
    updates: directorySize(updatesDir),
    electron: directorySize(electronDir),
    total: directorySize(dataDir),
  };
  return { usage, db_path: dbPath, log_retention_hours: LOG_RETENTION_HOURS };
}

/** Alias matching the plan's advertised `maintenance` export. */
export const maintenance = maintenanceInfo;

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export interface BackupEntry {
  name: string;
  path: string;
  size: number;
  modified_at: string;
}

export interface BackupInfo {
  backup_dir: string;
  backups: BackupEntry[];
  latest: BackupEntry | null;
}

/** List the `.db` files in the backup directory, newest first. */
export function backupInfo(
  db: SqliteDatabase,
  options: { backupDir?: string } = {},
): BackupInfo {
  const backupDir = options.backupDir ?? join(dirname(db.name), 'backups');
  const backups: BackupEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(backupDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith('.db')) continue;
    const filePath = join(backupDir, name);
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) continue;
      backups.push({
        name,
        path: filePath,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
      });
    } catch {
      // Skip entries that cannot be stat-ed.
    }
  }
  backups.sort((a, b) => (a.modified_at < b.modified_at ? 1 : a.modified_at > b.modified_at ? -1 : 0));
  return { backup_dir: backupDir, backups, latest: backups[0] ?? null };
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

export interface RestoreOptions {
  /** Maximum accepted upload size in bytes (defaults to 100 MB). */
  maxBytes?: number;
  /** Destination directory for the pre-restore safety backup. */
  backupDir?: string;
  /** Timestamp used in the safety-backup filename (defaults to now). */
  now?: Date;
  validate?: (filePath: string) => void;
  backup?: (db: SqliteDatabase, destination: string) => Promise<void>;
  restore?: (source: string, destination: string) => Promise<void>;
  initSchema?: (db: SqliteDatabase) => void;
}

export interface RestoreResult {
  ok: true;
  restart_required: true;
  safety_backup: string;
  message: string;
}

function formatStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

/**
 * Validate an uploaded backup, take a safety backup, restore it over the live
 * database and re-initialise the schema. Mirrors the oracle restore route.
 */
export async function restoreFromUpload(
  db: SqliteDatabase,
  sourcePath: string | null | undefined,
  options: RestoreOptions = {},
): Promise<RestoreResult> {
  if (sourcePath === null || sourcePath === undefined || String(sourcePath).trim() === '') {
    throw new AdminError('请选择备份文件', { status: 400, code: 'missing_upload' });
  }
  const upload = sourcePath;

  let size: number | null = null;
  try {
    const stat = statSync(upload);
    if (stat.isFile()) size = stat.size;
  } catch {
    size = null;
  }
  const maxBytes = options.maxBytes ?? MAX_RESTORE_BYTES;
  if (size !== null && size > maxBytes) {
    throw new AdminError('备份文件不能超过 100 MB', { status: 413, code: 'payload_too_large' });
  }

  const validate = options.validate ?? validateBackupDatabase;
  try {
    validate(upload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdminError(message, { status: 400, code: 'invalid_backup' });
  }

  const dbPath = db.name;
  const backupDir = options.backupDir ?? join(dirname(dbPath), 'backups');
  const safetyBackup = join(backupDir, `pre-restore-${formatStamp(options.now ?? new Date())}.db`);

  mkdirSync(backupDir, { recursive: true });
  await (options.backup ?? backupDatabase)(db, safetyBackup);
  await (options.restore ?? restoreDatabase)(upload, dbPath);
  (options.initSchema ?? ((database: SqliteDatabase) => initSchema(database)))(db);

  return {
    ok: true,
    restart_required: true,
    safety_backup: safetyBackup,
    message: '数据库已恢复，请关闭并重新打开工具使配置生效。',
  };
}

// ---------------------------------------------------------------------------
// Config export
// ---------------------------------------------------------------------------

export interface ExportedConfig {
  filename: string;
  mimetype: string;
  body: string;
}

/** The `GET /api/system/config-export` payload: masked settings as JSON. */
export function exportConfig(db: SqliteDatabase): ExportedConfig {
  return {
    filename: 'servermonitor-config.json',
    mimetype: 'application/json',
    body: JSON.stringify(publicSettings(db), null, 2),
  };
}

// ---------------------------------------------------------------------------
// Secret helpers (DPAPI-protected blobs in app_secrets)
// ---------------------------------------------------------------------------

export interface StoreSecretOptions {
  protect?: (plain: Buffer) => Buffer;
  writable?: boolean;
}

/** Store a UTF-8 secret, DPAPI-protected, into `app_secrets`. */
export function storeSecret(
  db: SqliteDatabase,
  name: string,
  value: string,
  options: StoreSecretOptions = {},
): void {
  if (!(options.writable ?? true)) {
    throw new AdminError('settings are not writable on this platform', {
      status: 400,
      code: 'not_writable',
    });
  }
  const protector = options.protect ?? protect;
  setSecret(db, name, protector(Buffer.from(value, 'utf8')));
}

export interface ReadSecretOptions {
  unprotect?: (blob: Buffer) => Buffer;
}

/** Read a secret back as UTF-8 text, or null when absent / undecryptable. */
export function readSecretText(
  db: SqliteDatabase,
  name: string,
  options: ReadSecretOptions = {},
): string | null {
  const blob = getSecret(db, name);
  if (blob === null) return null;
  try {
    return (options.unprotect ?? unprotect)(blob).toString('utf8');
  } catch {
    return null;
  }
}

/** Read a JSON secret back as an object, or null when absent / malformed. */
export function readSecretJson(
  db: SqliteDatabase,
  name: string,
  options: ReadSecretOptions = {},
): Record<string, unknown> | null {
  const text = readSecretText(db, name, options);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface SecretStatuses {
  smtp_password: boolean;
  webhook_url: boolean;
  admin: boolean;
  session: boolean;
  total: number;
  names: string[];
}

/** Presence report for the well-known secrets (for the admin UI). */
export function secretStatuses(db: SqliteDatabase): SecretStatuses {
  const names = listSecretNames(db).sort();
  const present = new Set(names);
  return {
    smtp_password: present.has(SECRET_SMTP_PASSWORD),
    webhook_url: present.has(SECRET_WEBHOOK_URL),
    admin: present.has(SECRET_ADMIN),
    session: present.has(SECRET_SESSION),
    total: names.length,
    names,
  };
}
