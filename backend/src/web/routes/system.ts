/**
 * System routes — the Express equivalent of
 * `servermanage/web/routes/system.py` (P2 Task 15).
 *
 * Registers the eleven `system` endpoints with the same URL rules, HTTP
 * methods, JSON field names, status codes and error messages as the Python
 * oracle:
 *
 *   GET    /api/system/host-keys             list trusted SSH host keys
 *   DELETE /api/system/host-keys/<hostname>  forget one host key
 *   GET    /api/system/health                version / runtime / tasks / stats
 *   GET    /api/system/storage               disk-usage snapshot
 *   POST   /api/system/maintenance           run one maintenance target
 *   GET    /api/system/backup                download a DB snapshot
 *   POST   /api/system/restore               restore from an uploaded backup
 *   GET    /api/system/config-export         download the masked config JSON
 *   GET    /api/logs                         tail of the dashboard log
 *   GET    /api/logs/download                download the dashboard log file
 *   GET    /api/runtime                      single-instance runtime state
 *
 * Anything that touches the outside world (the SSH known-host store, the
 * runtime state file, administrative cleanup targets and the diagnostics
 * builder) is injected through {@link SystemRouteDeps} so the route module can
 * be exercised without real SSH / filesystem side effects. The pure storage
 * helpers (`storage/runtime`, `storage/*`) and the admin helpers
 * (`config/admin`) are reused unchanged.
 *
 * The middleware gate chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers. Responses never render
 * templates (the oracle registers JSON endpoints only).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig } from '../../config/config';
import {
  directorySize,
  exportConfig,
  restoreFromUpload,
  type ExportedConfig,
  type RestoreOptions,
  type StorageUsage,
} from '../../config/admin';
import { loadEffectiveSettings } from '../../config/service';
import { getAllDiskHealth } from '../../storage/disk';
import { countActiveCriticalAlerts } from '../../storage/alerts';
import { getAllHostSnapshots } from '../../storage/hosts';
import { listStorageSamples } from '../../storage/storage-samples';
import { listTaskStates } from '../../storage/tasks';
import {
  backupDatabase,
  databaseIntegrity,
  systemStats,
} from '../../storage/runtime';
import { cleanupLogs as runCleanupLogs } from '../../runtime/maintenance';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** One check in the system-health panel (`_system_diagnostics`). */
export interface DiagnosticCheck {
  key: string;
  label: string;
  status: 'ok' | 'warning' | 'error';
  message: string;
}

/** Result of {@link DiagnosticCheck} aggregation. */
export interface Diagnostics {
  status: 'ok' | 'warning' | 'error';
  checks: DiagnosticCheck[];
}

/** Administrative maintenance target handlers (injected by the composition root). */
export interface MaintenanceTargets {
  logs: (dir: string) => unknown;
  updates: (dir: string) => unknown;
  cache: (dir: string) => unknown;
  database: (db: SqliteDatabase) => unknown;
}

/** Injected collaborators for {@link registerSystemRoutes}. Only `db` + `config` are required. */
export interface SystemRouteDeps {
  /** Open SQLite handle (storage + settings). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, paths, app version). */
  config: AppConfig;
  /** `APP_VERSION` reported by `/api/system/health` (defaults to `config.appVersion`). */
  appVersion?: string;
  /** Absolute path of the fixed dashboard log (`logs/servermonitor.log`). */
  logFile?: string;
  /** Absolute path of the single-instance runtime state (`data/runtime.json`). */
  runtimeFile?: string;
  /** Lists trusted SSH host keys. Defaults to an empty object. */
  listKnownHostKeys?: () => Obj;
  /** Forgets one host key; returns whether a record was removed. Defaults to `false`. */
  forgetHostKey?: (hostname: string) => boolean;
  /** Reads the runtime state file. Defaults to a local JSON reader. */
  readRuntimeState?: (filePath: string) => Obj | null;
  /** Builds system diagnostics. Defaults to a port of `_system_diagnostics`. */
  diagnostics?: (db: SqliteDatabase, config: AppConfig) => Diagnostics;
  /** Disk-usage snapshot for storage/maintenance. Defaults to the oracle layout. */
  storageUsage?: (db: SqliteDatabase) => StorageUsage;
  /** Administrative maintenance target handlers. */
  maintenanceTargets?: Partial<MaintenanceTargets>;
  /** Masked config export; `null` → 404 `settings service unavailable`. */
  exportConfig?: (db: SqliteDatabase) => ExportedConfig | null;
  /** Options forwarded to {@link restoreFromUpload} (validate/backup/restore hooks). */
  restore?: RestoreOptions;
  /** Restore upload ceiling in bytes (defaults to 100 MB). */
  maxRestoreBytes?: number;
  /** Clock injection for filename stamps / diagnostics. */
  now?: () => Date;
}

/** Converts an `ENDPOINTS` template (`/x/{name}`) into an Express path. */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Wraps an async handler so rejected promises reach the Express error handler. */
function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Python `_as_int(value, default)`: only base-10 integer strings parse. */
function asInt(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[+-]?\d+$/.test(text)) {
      return Number(text);
    }
  }
  return fallback;
}

/** Extracts a user-facing message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `strftime('%Y%m%d-%H%M%S')` in the server's local timezone. */
function compactStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Parses a stored ISO-8601 instant; a naive timestamp is treated as UTC. */
function parseInstant(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).trim();
  if (text === '') {
    return null;
  }
  const withZone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text}Z`;
  const epoch = Date.parse(withZone);
  return Number.isNaN(epoch) ? null : epoch;
}

// ---------------------------------------------------------------------------
// Diagnostics (port of `_core.py::_system_diagnostics`)
// ---------------------------------------------------------------------------

interface TimezoneStatus {
  name: string;
  available: boolean;
  effective: string;
  detail: string;
}

/** Port of `timeutil.timezone_status`: probes whether an IANA zone resolves. */
function timezoneStatus(name: string): TimezoneStatus {
  try {
    // Throws RangeError for an unknown zone in both browsers and Node.
    new Intl.DateTimeFormat('en-US', { timeZone: name }).format(new Date(0));
    return { name, available: true, effective: name, detail: '' };
  } catch (err) {
    return { name, available: false, effective: 'UTC', detail: errorMessage(err) };
  }
}

/** Port of `_core.py::_is_online` (success + collected within 3× poll interval). */
function isOnline(snapshot: Obj, pollIntervalSeconds: number, nowMs: number): boolean {
  if (!snapshot.success) {
    return false;
  }
  const collected = parseInstant(snapshot.collected_at);
  if (collected === null) {
    return false;
  }
  const maxAge = Math.max(Math.trunc(pollIntervalSeconds), 1) * 3;
  return (nowMs - collected) / 1000 <= maxAge;
}

/** Builds the system-health diagnostics, byte-aligned with the Python oracle. */
function buildDiagnostics(
  db: SqliteDatabase,
  config: AppConfig,
  nowMs: number,
): Diagnostics {
  const checks: DiagnosticCheck[] = [];

  const [dbOk, dbMessage] = databaseIntegrity(db, 300_000);
  checks.push({
    key: 'database',
    label: '数据库',
    status: dbOk ? 'ok' : 'error',
    message: dbMessage,
  });

  const settings = loadEffectiveSettings(db);
  const monitoring = isPlainObject(settings.monitoring) ? settings.monitoring : {};
  const tzName = typeof monitoring.timezone === 'string' && monitoring.timezone
    ? monitoring.timezone
    : 'Asia/Shanghai';
  const rawPoll = monitoring.poll_interval_seconds;
  const pollInterval = typeof rawPoll === 'number' && Number.isFinite(rawPoll)
    ? Math.max(Math.trunc(rawPoll), 1)
    : 600;

  const tzState = timezoneStatus(tzName);
  const tzMessage = tzState.available
    ? `时区 ${tzState.name} 已生效`
    : `时区 ${tzState.name} 不可用，已回退 ${tzState.effective}，`
      + `页面与报告的本地时间会偏移；请确认打包产物包含 tzdata 时区数据（${tzState.detail}）`;
  checks.push({
    key: 'timezone',
    label: '时区',
    status: tzState.available ? 'ok' : 'warning',
    message: tzMessage,
  });

  const snapshots = new Map<string, Obj>();
  for (const item of getAllHostSnapshots(db)) {
    snapshots.set(item.host_name, item as unknown as Obj);
  }
  const offline: string[] = [];
  const stale: string[] = [];
  const missing: string[] = [];
  for (const server of config.servers) {
    const snapshot = snapshots.get(server.name);
    if (snapshot === undefined) {
      missing.push(server.name);
    } else if (!snapshot.success) {
      offline.push(server.name);
    } else if (!isOnline(snapshot, pollInterval, nowMs)) {
      stale.push(server.name);
    }
  }
  const total = config.servers.length;
  const healthy = total - missing.length - offline.length - stale.length;
  let hostStatus: DiagnosticCheck['status'];
  let hostMessage: string;
  if (total === 0) {
    hostStatus = 'warning';
    hostMessage = '尚未配置监控主机';
  } else if (healthy <= 0) {
    hostStatus = 'error';
    hostMessage = `${total} 台主机均未成功采集`;
  } else if (missing.length > 0 || offline.length > 0 || stale.length > 0) {
    hostStatus = 'warning';
    const problems: string[] = [];
    if (offline.length > 0) problems.push('离线：' + offline.slice(0, 3).join('、'));
    if (stale.length > 0) problems.push('数据过期：' + stale.slice(0, 3).join('、'));
    if (missing.length > 0) problems.push('无数据：' + missing.slice(0, 3).join('、'));
    hostMessage = `${healthy}/${total} 台采集正常；` + problems.join('；');
  } else {
    hostStatus = 'ok';
    hostMessage = `${total}/${total} 台采集正常`;
  }
  checks.push({ key: 'hosts', label: '主机采集', status: hostStatus, message: hostMessage });

  const diskReports = getAllDiskHealth(db);
  const badDisks = diskReports.filter(
    (item) => !['ok', 'healthy'].includes(String(item.status ?? '').toLowerCase()),
  );
  let diskStatus: DiagnosticCheck['status'];
  let diskMessage: string;
  if (diskReports.length === 0) {
    diskStatus = 'ok';
    diskMessage = '尚未采集磁盘健康';
  } else if (badDisks.length > 0) {
    diskStatus = 'warning';
    diskMessage = '异常主机：' + badDisks.slice(0, 3).map((item) => String(item.host_name ?? '未知')).join('、');
  } else {
    diskStatus = 'ok';
    diskMessage = `${diskReports.length} 台磁盘阵列健康`;
  }
  checks.push({ key: 'disk', label: '磁盘阵列', status: diskStatus, message: diskMessage });

  const tasks = listTaskStates(db);
  const failedTasks = tasks.filter(
    (task) => task.last_result !== null && String(task.last_result) !== 'ok',
  );
  if (failedTasks.length > 0) {
    checks.push({
      key: 'tasks',
      label: '调度任务',
      status: 'warning',
      message: '最近失败：' + failedTasks.slice(0, 3).map((task) => String(task.task_name ?? '未知')).join('、'),
    });
  } else {
    checks.push({
      key: 'tasks',
      label: '调度任务',
      status: 'ok',
      message: tasks.length > 0 ? `${tasks.length} 个调度任务正常` : '暂无调度记录',
    });
  }

  const criticalCount = countActiveCriticalAlerts(db);
  if (criticalCount > 0) {
    checks.push({
      key: 'alerts',
      label: '严重告警',
      status: 'warning',
      message: `${criticalCount} 条严重告警待处理`,
    });
  } else {
    checks.push({ key: 'alerts', label: '严重告警', status: 'ok', message: '没有未处理的严重告警' });
  }

  let overall: Diagnostics['status'] = 'ok';
  if (checks.some((check) => check.status === 'error')) {
    overall = 'error';
  } else if (checks.some((check) => check.status === 'warning')) {
    overall = 'warning';
  }
  return { status: overall, checks };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/** Reads the runtime state file, tolerating a missing / malformed file. */
function defaultReadRuntimeState(filePath: string): Obj | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Disk-usage snapshot. In the single-stack layout the data/log directories are
 * user-configurable and no longer live under `{app_dir}/data`, so the sizes are
 * derived from the effective config instead of `dirname(dirname(dbPath))` —
 * otherwise `total` would walk the entire drive that hosts the data directory. */
function defaultStorageUsage(db: SqliteDatabase, config: AppConfig): StorageUsage {
  const dataDir = config.dataDir;
  return {
    database: directorySize(config.dbPath || db.name),
    logs: directorySize(config.logDir),
    updates: directorySize(join(dataDir, 'updates')),
    electron: directorySize(join(dataDir, 'electron')),
    total: directorySize(dataDir),
  };
}

/**
 * Deletes rotated `*.log` / `*.log.N` files older than 24h, protecting the
 * live log files. Delegates to the shared runtime maintenance helper, which
 * also matches rotated suffixes (`.log.1`, `.log.2`, …) — the previous local
 * implementation only matched files ending in `.log` and silently left the
 * rotated files behind.
 */
function cleanupLogs(logDir: string): { deleted: number; bytes: number } {
  return runCleanupLogs(logDir);
}

/** Recursively collects `*.zip` files under `root`. */
function collectZips(root: string): string[] {
  const result: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile() && entry.name.endsWith('.zip')) {
        result.push(child);
      }
    }
  };
  walk(root);
  return result;
}

/** Deletes stale update packages (`retention_hours=0` removes them all). */
function cleanupUpdates(updatesDir: string, retentionHours = 0): { deleted: number; bytes: number } {
  let deleted = 0;
  let bytes = 0;
  try {
    if (!statSync(updatesDir).isDirectory()) {
      return { deleted, bytes };
    }
  } catch {
    return { deleted, bytes };
  }
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  for (const filePath of collectZips(updatesDir)) {
    try {
      const stat = statSync(filePath);
      if (retentionHours > 0 && stat.mtimeMs >= cutoff) {
        continue;
      }
      rmSync(filePath, { force: true });
      deleted += 1;
      bytes += stat.size;
    } catch {
      // Ignore unlink failures.
    }
  }
  return { deleted, bytes };
}

const ELECTRON_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GrShaderCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
];

/** Removes Electron renderer cache directories, returning a byte tally. */
function cleanupElectronCache(userDataDir: string): { deleted: number; bytes: number } {
  let deleted = 0;
  let bytes = 0;
  for (const name of ELECTRON_CACHE_DIRS) {
    const target = join(userDataDir, name);
    let stat;
    try {
      stat = statSync(target);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }
    const size = directorySize(target);
    try {
      rmSync(target, { recursive: true, force: true });
      deleted += 1;
      bytes += size;
    } catch {
      // Ignore directories held open by a running renderer.
    }
  }
  return { deleted, bytes };
}

/** Port of `storage/maintain_database(force=True)` for an open handle. */
function maintainDatabase(db: SqliteDatabase): Record<string, unknown> {
  try {
    let autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }));
    const pageCount = Number(db.pragma('page_count', { simple: true }));
    let freePages = Number(db.pragma('freelist_count', { simple: true }));
    let vacuumed = false;
    let incremental = false;
    if (autoVacuum === 0) {
      db.pragma('auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
      vacuumed = true;
      autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }));
      freePages = Number(db.pragma('freelist_count', { simple: true }));
    } else {
      db.exec('PRAGMA incremental_vacuum');
      incremental = true;
      freePages = Number(db.pragma('freelist_count', { simple: true }));
    }
    return { vacuumed, incremental, auto_vacuum: autoVacuum, page_count: pageCount, free_pages: freePages };
  } catch {
    return { vacuumed: false, incremental: false, free_pages: 0 };
  }
}

// ---------------------------------------------------------------------------
// Multipart upload parsing (no external dependency)
// ---------------------------------------------------------------------------

interface UploadedFile {
  filename: string;
  data: Buffer;
}

/** Reads the full request body as a Buffer. */
async function readBody(req: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Extracts one `multipart/form-data` file field. Returns `null` when the field
 * is absent (or the body is not multipart). The returned `filename` may be an
 * empty string, which the route treats as "no file chosen".
 */
function parseMultipartFile(body: Buffer, contentType: string, field = 'file'): UploadedFile | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (match === null) {
    return null;
  }
  const boundary = `--${(match[1] ?? match[2]).trim()}`;
  const boundaryBuf = Buffer.from(boundary);
  const crlf = Buffer.from('\r\n\r\n');

  let index = body.indexOf(boundaryBuf);
  while (index !== -1) {
    const next = body.indexOf(boundaryBuf, index + boundaryBuf.length);
    if (next === -1) {
      break;
    }
    let start = index + boundaryBuf.length;
    if (body[start] === 0x0d && body[start + 1] === 0x0a) {
      start += 2;
    }
    let end = next;
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) {
      end -= 2;
    }
    const part = body.subarray(start, end);
    const headerEnd = part.indexOf(crlf);
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
      const nameMatch = /name="([^"]*)"/i.exec(disposition);
      const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
      if (nameMatch !== null && nameMatch[1] === field && filenameMatch !== null) {
        return { filename: filenameMatch[1], data: part.subarray(headerEnd + crlf.length) };
      }
    }
    index = next;
  }
  return null;
}

/** Writes an uploaded buffer to a private temp directory. */
function writeTempFile(data: Buffer, prefix: string): { filePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const filePath = join(dir, 'upload.db');
  writeFileSync(filePath, data);
  return {
    filePath,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** Registers the eleven system endpoints on `app`. */
export function registerSystemRoutes(app: Express, deps: SystemRouteDeps): void {
  const { db, config } = deps;
  const appVersion = deps.appVersion ?? config.appVersion ?? '0.0.0';
  const now = (): Date => (deps.now ? deps.now() : new Date());
  const maxRestoreBytes = deps.maxRestoreBytes ?? 100 * 1024 * 1024;

  const resolveLogFile = (): string =>
    deps.logFile
    ?? join(config.logDir || 'logs', 'servermonitor.log');
  const resolveRuntimeFile = (): string =>
    deps.runtimeFile
    ?? config.runtimePath
    ?? join(config.dataDir || 'data', 'runtime.json');
  const usage = (): StorageUsage =>
    deps.storageUsage ? deps.storageUsage(db) : defaultStorageUsage(db, config);
  const diagnostics = (): Diagnostics =>
    deps.diagnostics ? deps.diagnostics(db, config) : buildDiagnostics(db, config, now().getTime());

  // GET /api/system/host-keys ------------------------------------------------
  app.get(ENDPOINTS.api_system_host_keys, (_req: Request, res: Response) => {
    const hosts = deps.listKnownHostKeys ? deps.listKnownHostKeys() : {};
    res.json({ hosts });
  });

  // DELETE /api/system/host-keys/:hostname ----------------------------------
  app.delete(routePath(ENDPOINTS.api_system_host_key_forget), (req: Request, res: Response) => {
    const hostname = String(req.params.hostname ?? '');
    const removed = deps.forgetHostKey ? deps.forgetHostKey(hostname) : false;
    if (!removed) {
      res.status(404).json({ error: 'not_found', message: '没有这个主机的密钥记录' });
      return;
    }
    res.json({ ok: true, host: hostname });
  });

  // GET /api/system/health ---------------------------------------------------
  app.get(ENDPOINTS.api_system_health, (_req: Request, res: Response) => {
    const stats = systemStats(db, db.name);
    const runtime = deps.readRuntimeState
      ? deps.readRuntimeState(resolveRuntimeFile()) ?? {}
      : defaultReadRuntimeState(resolveRuntimeFile()) ?? {};
    res.json({
      version: appVersion,
      runtime,
      tasks: listTaskStates(db),
      hosts_configured: config.servers.length,
      diagnostics: diagnostics(),
      ...stats,
    });
  });

  // GET /api/system/storage --------------------------------------------------
  app.get(ENDPOINTS.api_system_storage, (_req: Request, res: Response) => {
    res.json({
      usage: usage(),
      db_path: db.name,
      log_retention_hours: 24,
      db_size_history: listStorageSamples(db, 90),
    });
  });

  // POST /api/system/maintenance --------------------------------------------
  app.post(ENDPOINTS.api_system_maintenance, (req: Request, res: Response) => {
    const payload = isPlainObject(req.body) ? req.body : {};
    const target = String(payload.target ?? '').trim();
    const targets: Partial<MaintenanceTargets> = deps.maintenanceTargets ?? {};

    let result: unknown;
    switch (target) {
      case 'logs':
        result = (targets.logs ?? cleanupLogs)(config.logDir);
        break;
      case 'updates':
        result = (targets.updates ?? ((dir) => cleanupUpdates(dir, 0)))(join(config.dataDir, 'updates'));
        break;
      case 'cache':
        result = (targets.cache ?? cleanupElectronCache)(join(config.dataDir, 'electron'));
        break;
      case 'database':
        result = (targets.database ?? maintainDatabase)(db);
        break;
      default:
        res.status(400).json({ error: 'unknown_target' });
        return;
    }
    res.json({ ok: true, target, result, usage: usage() });
  });

  // GET /api/system/backup ---------------------------------------------------
  app.get(
    ENDPOINTS.api_system_backup,
    wrap(async (_req: Request, res: Response) => {
      const dir = mkdtempSync(join(tmpdir(), 'servermonitor-backup-'));
      const tempPath = join(dir, 'snapshot.db');
      const cleanup = (): void => {
        rmSync(dir, { recursive: true, force: true });
      };
      try {
        await backupDatabase(db, tempPath);
      } catch (err) {
        cleanup();
        throw err;
      }
      const stamp = compactStamp(now());
      const data = readFileSync(tempPath);
      cleanup();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="servermonitor-backup-${stamp}.db"`,
      );
      res.send(data);
    }),
  );

  // POST /api/system/restore -------------------------------------------------
  app.post(
    ENDPOINTS.api_system_restore,
    wrap(async (req: Request, res: Response) => {
      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > 0 && contentLength > maxRestoreBytes) {
        res.status(413).json({ error: '备份文件不能超过 100 MB' });
        return;
      }
      const contentType = String(req.headers['content-type'] ?? '');
      let upload: UploadedFile | null;
      if (/multipart\/form-data/i.test(contentType)) {
        const body = await readBody(req);
        if (body.length > maxRestoreBytes) {
          res.status(413).json({ error: '备份文件不能超过 100 MB' });
          return;
        }
        upload = parseMultipartFile(body, contentType, 'file');
      } else {
        upload = null;
      }
      if (upload === null || upload.filename === '') {
        res.status(400).json({ error: '请选择备份文件' });
        return;
      }

      const temp = writeTempFile(upload.data, 'servermonitor-restore-');
      try {
        const options: RestoreOptions = { ...(deps.restore ?? {}) };
        options.maxBytes = deps.maxRestoreBytes ?? options.maxBytes;
        options.now = now();
        const result = await restoreFromUpload(db, temp.filePath, options);
        res.json(result);
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number') {
          res.status(status).json({ error: errorMessage(err) });
          return;
        }
        throw err;
      } finally {
        temp.cleanup();
      }
    }),
  );

  // GET /api/system/config-export -------------------------------------------
  app.get(ENDPOINTS.api_system_config_export, (_req: Request, res: Response) => {
    const exported = deps.exportConfig ? deps.exportConfig(db) : exportConfig(db);
    if (exported === null) {
      res.status(404).json({ error: 'settings service unavailable' });
      return;
    }
    res.setHeader('Content-Type', exported.mimetype);
    res.setHeader('Content-Disposition', `attachment; filename=${exported.filename}`);
    res.send(exported.body);
  });

  // GET /api/logs ------------------------------------------------------------
  app.get(ENDPOINTS.api_logs, (req: Request, res: Response) => {
    const requested = asInt(req.query.lines, 200);
    const lines = Math.max(1, Math.min(requested, 2000));
    const logFile = resolveLogFile();
    let content: string;
    try {
      content = readFileSync(logFile, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') {
        res.json({ path: logFile, lines: '', text: '', line_count: 0 });
        return;
      }
      res.status(500).json({ error: errorMessage(err) });
      return;
    }
    const all = content === '' ? [] : content.split(/(?<=\n)/);
    if (all.length > 0 && all[all.length - 1] === '') {
      all.pop();
    }
    const tail = all.slice(-lines);
    const text = tail.join('');
    res.json({ path: logFile, lines: text, text, line_count: tail.length });
  });

  // GET /api/logs/download ---------------------------------------------------
  app.get(ENDPOINTS.api_logs_download, (_req: Request, res: Response) => {
    const logFile = resolveLogFile();
    let stat;
    try {
      stat = statSync(logFile);
    } catch {
      res.status(404).json({ error: 'log file not found' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: 'log file not found' });
      return;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="servermonitor.log"');
    res.send(readFileSync(logFile));
  });

  // GET /api/runtime ---------------------------------------------------------
  app.get(ENDPOINTS.api_runtime, (_req: Request, res: Response) => {
    const state = deps.readRuntimeState
      ? deps.readRuntimeState(resolveRuntimeFile())
      : defaultReadRuntimeState(resolveRuntimeFile());
    if (state === null || Object.keys(state).length === 0) {
      res.json({ url: null });
      return;
    }
    res.json({ url: state.url ?? null, port: state.port ?? null, pid: state.pid ?? null });
  });
}
