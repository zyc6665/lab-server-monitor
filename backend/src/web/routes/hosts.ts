/**
 * Hosts routes — the Express equivalent of `servermanage/web/routes/hosts.py`
 * (P2 Task 11).
 *
 * Registers the full hosts surface with the same URL rules, HTTP methods, JSON
 * field names, status codes, error messages and template context keys as the
 * Python oracle:
 *
 *   GET    /hosts                                      hosts page (`hosts.html`)
 *   GET    /host/<name>                                host detail page (`host.html`)
 *   POST   /api/settings/hosts/probe                   ad-hoc host probe
 *   GET    /api/host/<name>                            host detail JSON
 *   GET    /api/host/<name>/report                     plain-text host report
 *   GET    /api/host/<name>/history                    host metric history
 *   GET    /api/settings/hosts/collection-status       collection status provider
 *   GET    /api/settings/hosts                         masked host inventory
 *   PUT    /api/settings/hosts/<name>                  create/replace a host
 *   DELETE /api/settings/hosts/<name>                  delete a host
 *   POST   /api/settings/hosts/import/preview          parse an import payload
 *   GET    /api/settings/hosts/ssh-config              preview `~/.ssh/config`
 *   POST   /api/settings/hosts/ssh-config/import       import selected ssh hosts
 *   POST   /api/settings/hosts/import                  import a pasted payload
 *   POST   /api/settings/hosts/test-batch              batch connectivity probe
 *   POST   /api/settings/hosts/<name>/probe            probe a saved host
 *   POST   /api/settings/hosts/<name>/checks/test      run one posted check
 *   POST   /api/host/<name>/containers/stats           one `docker stats` sample
 *   POST   /api/host/<name>/checks/run                 run enabled service checks
 *   POST   /api/settings/hosts/<name>/collect          collect one saved host
 *   POST   /api/settings/hosts/collect                 collect many saved hosts
 *   POST   /api/settings/hosts/<name>/copy             duplicate a saved host
 *
 * SSH/network operations (probe, connectivity batch, checks, container stats,
 * immediate collection) are never performed directly: they are delegated to
 * injected collaborators in {@link HostsRouteDeps} so tests can run without a
 * real SSH connection. Read-only storage queries and settings mutations reuse
 * the existing `config/hosts.ts` / `storage/*` modules unchanged.
 *
 * The middleware gate chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig, HostCheckConfig, HostConfig } from '../../config/config';
import { loadEffectiveSettings, publicSettings } from '../../config/service';
import {
  HostSettingsError,
  buildServers,
  copyHost,
  deleteHost,
  getHost,
  importHosts,
  listHosts,
  previewHostImport,
  previewSshConfigImport,
  testHostsBatch,
  upsertHost,
  type HostRunner,
  type SshConfigPreview,
} from '../../config/hosts';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';
import { assertSafeTarget, SSRFError } from '../security/ssrf';
import {
  countActiveAlertsByHost,
  listAlertsForHost,
} from '../../storage/alerts';
import { getAllDiskHealth, getDiskHealth, type DiskHealthSnapshot } from '../../storage/disk';
import {
  getAllHostCheckResults,
  getAllHostSnapshots,
  getHostCheckResults,
  getHostSnapshot,
  saveHostCheckResults,
  type HostCheckResultRow,
  type HostSnapshot,
} from '../../storage/hosts';
import {
  appendHostCheckHistory,
  getHostCheckHistory,
} from '../../storage/metrics-write';
import {
  countRecentSamples,
  fetchHostHistory,
  fetchHostUptimeStrip,
  type UptimeStrip,
} from '../../storage/metrics-read';
import { nowIsoUtc } from '../../storage/time';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/**
 * Optional collaborators. Only `db` and `config` are required.
 *
 * Every SSH/network capability is injected so the route module never opens a
 * real connection. Page/data builders default to a locally-computed fallback
 * that reads the SQLite store directly; the fully-featured `overview.ts`
 * builders (which also emit diagnostics / users / alert-day history) can be
 * supplied here by the composition root until they are exported upstream.
 */
export interface HostsRouteDeps {
  /** Open SQLite handle (settings + snapshots + history). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, paths, app version). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /** Builds the `/hosts` page context. Defaults to a local store-backed impl. */
  buildOverview?: () => Obj;
  /** Builds one host detail; `null` → 404. Defaults to a local impl. */
  buildHostDetail?: (name: string) => Obj | null;
  /** Renders the plain-text report body. Defaults to a condensed impl. */
  buildHostReport?: (detail: Obj, generatedAt: Date) => string;
  /** Ad-hoc/`saved-host` probe. Receives the payload object or a HostConfig. */
  probeHost?: (target: unknown) => unknown | Promise<unknown>;
  /** SSH runner used by the batch connectivity test. */
  runner?: HostRunner;
  /** Runs one or more checks against a saved host. */
  runHostChecks?: (host: HostConfig, checks: HostCheckConfig[]) => unknown[] | Promise<unknown[]>;
  /** Validates one posted check payload into a `HostCheckConfig`. */
  prepareHostCheck?: (payload: Obj) => HostCheckConfig;
  /** Collects one `docker stats` sample for a saved host. */
  collectContainerStats?: (host: HostConfig) => unknown[] | Promise<unknown[]>;
  /** Collection-status provider (`COLLECTION_STATUS_PROVIDER`). */
  collectionStatus?: (names: string[] | null) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Immediate collection callback (`ON_HOSTS_IMPORTED`). */
  collectHosts?: (names: string[]) => void | Promise<void>;
  /** Triggered after a sudo password is stored (`_request_user_refresh`). */
  requestUserRefresh?: (forceUsage?: boolean) => void;
  /** Reloads the runtime config after a mutation (`_refresh_config`). */
  refreshConfig?: () => void;
  /** Notifies listeners that hosts were imported (`_notify_hosts_imported`). */
  notifyHostsImported?: (names: string[]) => void;
  /** Whether settings are writable; defaults to `publicSettings(db).writable`. */
  isWritable?: () => boolean;
  /** Whether the settings service is available; defaults to `true`. */
  settingsAvailable?: () => boolean;
  /** Current composed servers; defaults to `buildServers(db, {baseServers})`. */
  currentServers?: () => HostConfig[];
  /** Fresh `~/.ssh/config` preview; defaults to a real filesystem read. */
  previewSshConfig?: () => SshConfigPreview;
}

// ---------------------------------------------------------------------------
// Small value helpers (mirrors of the private `_core.py` / overview helpers)
// ---------------------------------------------------------------------------

function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asFloat(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isMapping(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Reads a JSON body only when the request actually carried JSON (Python `get_json(silent=True)` → None). */
function jsonBody(req: Request): unknown {
  if (!req.is('application/json')) {
    return null;
  }
  return req.body;
}

/** Python `_truthy_arg`: `None`→default; bool→itself; else trimmed string not in the falsy set. */
function truthyArg(value: unknown, defaultValue = false): boolean {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  return !['0', 'false', 'no', 'off', ''].includes(text);
}

/** Converts an `ENDPOINTS` template (`/x/{name}`) into an Express path (`/x/:name`). */
function routePath(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, ':$1');
}

/** Wraps an async handler so rejected promises reach the Express error handler. */
function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

interface HostsSettings {
  timezone: string;
  pollIntervalSeconds: number;
}

/** `readOverviewSettings` equivalent, limited to what the hosts routes need. */
function readHostsSettings(db: SqliteDatabase): HostsSettings {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const rawTz = monitoring.timezone;
  const timezone = typeof rawTz === 'string' && rawTz ? rawTz : 'Asia/Shanghai';
  const rawPoll = monitoring.poll_interval_seconds;
  const pollIntervalSeconds =
    typeof rawPoll === 'number' && Number.isFinite(rawPoll) ? Math.trunc(rawPoll) : 600;
  return { timezone, pollIntervalSeconds };
}

/** Formats an instant as an offset-qualified ISO string in `timeZone`. */
function toLocalIso(value: unknown, timeZone: string): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    const wallAsUtc = Date.UTC(
      Number(get('year')),
      Number(get('month')) - 1,
      Number(get('day')),
      Number(get('hour')) % 24,
      Number(get('minute')),
      Number(get('second')),
    );
    const offsetMinutes = Math.round((wallAsUtc - date.getTime()) / 60000);
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMinutes);
    return (
      `${get('year')}-${get('month')}-${get('day')}` +
      `T${pad2(Number(get('hour')) % 24)}:${get('minute')}:${get('second')}` +
      `${sign}${pad2(Math.trunc(abs / 60))}:${pad2(abs % 60)}`
    );
  } catch {
    return date.toISOString();
  }
}

/** `%Y%m%d-%H%M%S` for an instant in `timeZone` (report filename stamp). */
function compactStamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}${get('month')}${get('day')}-${pad2(Number(get('hour')) % 24)}${get('minute')}${get('second')}`;
}

/** `_report_filename`: ASCII-safe host slug + compact local timestamp. */
function reportFilename(name: string, generatedAt: Date, timeZone: string): string {
  const safe =
    [...name]
      .map((ch) => (/[A-Za-z0-9_-]/.test(ch) ? ch : '_'))
      .join('')
      .replace(/^_+|_+$/g, '') || 'host';
  return `host-report-${safe}-${compactStamp(generatedAt, timeZone)}.txt`;
}

// ---------------------------------------------------------------------------
// Metric helpers (condensed ports used by the fallback builders)
// ---------------------------------------------------------------------------

function memoryPercent(metrics: Obj): number | null {
  const memory = asObj(metrics.memory);
  const used = asFloat(memory.used_mb);
  const total = asFloat(memory.total_mb);
  return used !== null && total !== null && total !== 0 ? (used / total) * 100 : null;
}

function diskPercent(metrics: Obj, mounts: string[] | undefined): number | null {
  const wanted = mounts && mounts.length ? mounts : ['/'];
  const usage = asArray(metrics.disk_usage);
  for (const mount of wanted) {
    for (const raw of usage) {
      const row = asObj(raw);
      if (String(row.mountpoint ?? '') === mount) {
        const percent = asFloat(row.percent);
        if (percent !== null) return percent;
      }
    }
  }
  return null;
}

function gpuMemoryPercent(metrics: Obj): number | null {
  const gpus = asArray(metrics.gpu_summary);
  let used = 0;
  let total = 0;
  let seen = false;
  for (const raw of gpus) {
    const row = asObj(raw);
    const usedMb = asFloat(row.memory_used_mb);
    const totalMb = asFloat(row.memory_total_mb);
    if (usedMb !== null && totalMb !== null && totalMb > 0) {
      used += usedMb;
      total += totalMb;
      seen = true;
    }
  }
  return seen && total > 0 ? (used / total) * 100 : null;
}

function loggedInUserCount(metrics: Obj): number {
  const users = new Set<string>();
  for (const raw of asArray(metrics.logged_in_users)) {
    const username = asObj(raw).username;
    if (username) users.add(String(username));
  }
  return users.size;
}

function diskHealthSummary(health: DiskHealthSnapshot | undefined): Obj {
  const counts = { healthy: 0, warning: 0, critical: 0 };
  if (!health) return { status: 'unknown', ...counts };
  for (const raw of asArray(health.physical_drives)) {
    const value = String(asObj(raw).health ?? '').toLowerCase();
    if (value in counts) counts[value as keyof typeof counts] += 1;
  }
  return { status: String(health.status ?? 'unknown') || 'unknown', ...counts };
}

function summarizeChecks(results: HostCheckResultRow[]): Obj {
  const total = results.length;
  let ok = 0;
  let failed = 0;
  for (const row of results) {
    const status = String(row.status);
    if (status === 'ok') ok += 1;
    else if (status === 'failed' || status === 'error') failed += 1;
  }
  return { total, ok, failed, unknown: total - ok - failed };
}

function isOnline(snapshot: HostSnapshot, pollIntervalSeconds: number, now: Date): boolean {
  if (!snapshot.success) return false;
  const collected = new Date(snapshot.collected_at);
  if (Number.isNaN(collected.getTime())) return false;
  const maxAge = Math.max(Math.trunc(pollIntervalSeconds), 1) * 3;
  return (now.getTime() - collected.getTime()) / 1000 <= maxAge;
}

// ---------------------------------------------------------------------------
// Minimal single-check sanitizer (mirrors `_sanitize_host_checks([payload])`)
// ---------------------------------------------------------------------------

const EXPECTED_STATUS_RE = /^\d{3}(-\d{3})?$/;

/**
 * Validates one posted check. Deep target syntax validation lives in the
 * config layer; this reproduces the field/timeout/expected rules the oracle
 * surfaces to the browser for an inline "test this check" request.
 */
function sanitizeSingleCheck(payload: Obj): HostCheckConfig {
  const name = String(payload['name'] ?? '').trim();
  if (!name) throw new HostSettingsError('checks[0].name 不能为空');
  if (name.length > 64) throw new HostSettingsError('checks[0].name 最多 64 个字符');
  const type = String(payload['type'] ?? '').trim().toLowerCase();
  if (!['tcp', 'http', 'process', 'service'].includes(type)) {
    throw new HostSettingsError('checks[0].type 必须是 tcp/http/process/service 之一');
  }
  const target = String(payload['target'] ?? '').trim();
  if (!target) throw new HostSettingsError('checks[0].target 不能为空');
  if (target.length > 256) throw new HostSettingsError('checks[0].target 最多 256 个字符');
  const timeoutRaw = payload['timeout_seconds'] === undefined ? 5 : payload['timeout_seconds'];
  if (typeof timeoutRaw === 'boolean' || !Number.isInteger(timeoutRaw)) {
    throw new HostSettingsError('checks[0].timeout_seconds 必须是整数');
  }
  const timeout = timeoutRaw as number;
  if (timeout < 1 || timeout > 30) {
    throw new HostSettingsError('checks[0].timeout_seconds 必须在 1 到 30 之间');
  }
  let expected: string | undefined;
  if (payload['expected'] !== null && payload['expected'] !== undefined) {
    const text = String(payload['expected']).trim();
    if (text) {
      if (!EXPECTED_STATUS_RE.test(text)) {
        throw new HostSettingsError('checks[0].expected 必须是 200 或 200-299 这样的状态码');
      }
      expected = text;
    }
  }
  const check: HostCheckConfig = {
    name,
    type,
    target,
    timeout_seconds: timeout,
    enabled: payload['enabled'] === undefined ? true : Boolean(payload['enabled']),
  };
  if (expected !== undefined) check.expected = expected;
  return check;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers every hosts endpoint on `app`.
 *
 * @param app  Express app (middleware gate chain already installed).
 * @param deps db + resolved config + optional injected capabilities.
 */
export function registerHostsRoutes(app: Express, deps: HostsRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });

  const isWritable = (): boolean => deps.isWritable?.() ?? Boolean(publicSettings(db).writable);
  const settingsAvailable = (): boolean => deps.settingsAvailable?.() ?? true;

  const currentServers = (): HostConfig[] => {
    if (deps.currentServers) return deps.currentServers();
    try {
      return buildServers(db, { baseServers: config.servers });
    } catch {
      return config.servers;
    }
  };

  const findServer = (name: string): HostConfig | undefined =>
    currentServers().find((server) => server.name === name);

  const refreshConfig = (): void => {
    deps.refreshConfig?.();
  };
  const notifyHostsImported = (names: string[]): void => {
    deps.notifyHostsImported?.(names);
  };

  // -- fallback builders (used only when the composition root does not supply) --

  const buildOverviewLocal = (): Obj => {
    const settings = readHostsSettings(db);
    const now = new Date();
    const snapshots = new Map<string, HostSnapshot>();
    for (const item of getAllHostSnapshots(db)) snapshots.set(item.host_name, item);
    const disks = new Map<string, DiskHealthSnapshot>();
    for (const item of getAllDiskHealth(db)) disks.set(item.host_name, item);
    const checksGrouped = getAllHostCheckResults(db);
    const alerts = countActiveAlertsByHost(db);

    const hosts: Obj[] = [];
    const tags = new Set<string>();
    const groups = new Set<string>();
    let online = 0;
    let activeAlerts = 0;
    for (const server of currentServers()) {
      const snapshot = snapshots.get(server.name);
      const metrics = asObj(snapshot?.metrics);
      const checks = checksGrouped[server.name] ?? [];
      const group = server.group || '未分组';
      const rowOnline = snapshot ? isOnline(snapshot, settings.pollIntervalSeconds, now) : false;
      if (rowOnline) online += 1;
      if (group) groups.add(group);
      for (const tag of server.tags) tags.add(tag);
      activeAlerts += Math.trunc(alerts[server.name] ?? 0);
      hosts.push({
        name: server.name,
        host: server.host ?? null,
        online: rowOnline,
        collected_at: snapshot ? toLocalIso(snapshot.collected_at, settings.timezone) : null,
        cpu_percent: asFloat(metrics.cpu_usage_percent),
        memory_percent: memoryPercent(metrics),
        disk_percent: diskPercent(metrics, server.disk_mounts),
        gpu_memory_percent: gpuMemoryPercent(metrics),
        logged_in_user_count: loggedInUserCount(metrics),
        disk_health: diskHealthSummary(disks.get(server.name)),
        checks: summarizeChecks(checks),
        silenced: false, // TODO: port silence lookup (`listSilences` + `silenceApplies`).
        silenced_until: null,
        active_alert_count: Math.trunc(alerts[server.name] ?? 0),
        group,
        owner: server.owner || '',
        location: server.location || '',
        tags: [...server.tags],
      });
    }

    const sortedGroups = [...groups].sort();
    const sortedTags = [...tags].sort();
    return {
      summary: { online, offline: hosts.length - online, active_alerts: activeAlerts },
      meta: {
        groups: sortedGroups,
        tags: sortedTags,
        has_groups: sortedGroups.length > 0,
        has_tags: sortedTags.length > 0,
      },
      hosts,
    };
  };

  const buildHostDetailLocal = (name: string): Obj | null => {
    const server = findServer(name);
    if (!server) return null;
    const settings = readHostsSettings(db);
    const snapshot = getHostSnapshot(db, name);
    const disk = getDiskHealth(db, name);
    const alerts = listAlertsForHost(db, name, { limit: 20 }).map((alert) => ({
      ...alert,
      created_at: toLocalIso(alert.created_at, settings.timezone),
    }));
    const checks = getHostCheckResults(db, name);
    const checkHistory = getHostCheckHistory(db, name, { limit: 40 });
    const uptimeStrip: UptimeStrip = fetchHostUptimeStrip(db, name, { hours: 24 });
    const samples = countRecentSamples(db, name, { hours: 24 });
    const expected = Math.max(1, Math.trunc((24 * 3600) / Math.max(60, settings.pollIntervalSeconds)));

    return {
      name,
      host: server.host,
      collected_at: snapshot ? toLocalIso(snapshot.collected_at, settings.timezone) : null,
      success: snapshot ? snapshot.success : null,
      group: server.group || '未分组',
      owner: server.owner || '',
      location: server.location || '',
      tags: [...server.tags],
      metrics: snapshot ? snapshot.metrics : {},
      errors: snapshot ? snapshot.errors : [],
      disk: disk
        ? {
            status: disk.status,
            message: disk.message,
            collected_at: toLocalIso(disk.collected_at, settings.timezone),
            controllers: disk.controllers,
            virtual_drives: disk.virtual_drives,
            physical_drives: disk.physical_drives,
          }
        : {},
      alerts,
      checks,
      check_history: checkHistory,
      // TODO: port `_network_rate_pair` (rx/tx rate needs consecutive history rows).
      network: {},
      // TODO: port `_build_user_rows` once the user-collection module is migrated.
      users: [],
      collection_uptime: { samples, expected },
      uptime_strip: uptimeStrip,
      // TODO: port the diagnostics module (`diagnostics` / `diagnostics_summary`).
      diagnostics: [],
      diagnostics_summary: {},
      // TODO: port `_host_alert_days` (per-day alert counts for the report strip).
      alert_days: [],
    };
  };

  const buildHostReportLocal = (detail: Obj, generatedAt: Date): string => {
    // TODO: full parity with `_build_host_report` (disk/session/alert sections).
    const settings = readHostsSettings(db);
    const metrics = asObj(detail['metrics']);
    const cpu = asFloat(metrics.cpu_usage_percent);
    const mem = memoryPercent(metrics);
    const lines = [
      `主机巡检报告：${String(detail['name'] ?? '')}`,
      `地址：${String(detail['host'] ?? '')}`,
      `生成时间：${toLocalIso(generatedAt, settings.timezone) ?? ''}`,
      `采集时间：${String(detail['collected_at'] ?? '—')}`,
      `采集状态：${detail['success'] === true ? '成功' : detail['success'] === false ? '失败' : '等待采集'}`,
      `分组：${String(detail['group'] ?? '未分组')}`,
      `CPU：${cpu === null ? '—' : `${cpu.toFixed(1)}%`}`,
      `内存：${mem === null ? '—' : `${mem.toFixed(1)}%`}`,
    ];
    return `${lines.join('\n')}\n`;
  };

  const buildOverview = (): Obj => (deps.buildOverview ? deps.buildOverview() : buildOverviewLocal());
  const buildHostDetail = (name: string): Obj | null =>
    deps.buildHostDetail ? deps.buildHostDetail(name) : buildHostDetailLocal(name);
  const buildHostReport = (detail: Obj, generatedAt: Date): string =>
    deps.buildHostReport ? deps.buildHostReport(detail, generatedAt) : buildHostReportLocal(detail, generatedAt);

  // -- helpers shared by the settings-style endpoints --------------------------

  /** Returns `false` and emits the 404 payload when settings are unavailable. */
  const requireSettings = (res: Response): boolean => {
    if (settingsAvailable()) return true;
    res.status(404).json({ error: 'settings_unavailable' });
    return false;
  };

  /** Returns `false` and emits the 409 payload when settings are not writable. */
  const requireWritable = (res: Response): boolean => {
    if (isWritable()) return true;
    res.status(409).json({ error: 'settings_not_writable' });
    return false;
  };

  /** Runs `fn` and converts a `HostSettingsError` into the oracle's 400 body. */
  const withSettingsError = (res: Response, fn: () => unknown): boolean => {
    try {
      fn();
      return true;
    } catch (err) {
      if (err instanceof HostSettingsError) {
        res.status(400).json({ error: err.message });
        return false;
      }
      throw err;
    }
  };

  const settingsOptions = (): { writable: boolean; baseServers: HostConfig[]; secrets?: undefined } => ({
    writable: isWritable(),
    baseServers: config.servers,
  });

  // =========================================================================
  // Pages
  // =========================================================================

  app.get(ENDPOINTS.hosts_page, (_req: Request, res: Response) => {
    const data = buildOverview();
    templating.renderPage(res, 'hosts.html', {
      active_page: 'hosts',
      summary: data.summary,
      meta: data.meta,
      hosts: data.hosts,
    });
  });

  app.get(routePath(ENDPOINTS.host_page), (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const detail = buildHostDetail(name);
    if (detail === null) {
      templating.renderPage(res, 'host.html', { active_page: 'hosts', name, detail: null }, 404);
      return;
    }
    templating.renderPage(res, 'host.html', { active_page: 'hosts', name, detail });
  });

  // =========================================================================
  // Host detail / report / history
  // =========================================================================

  app.get(routePath(ENDPOINTS.api_host), (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const detail = buildHostDetail(name);
    if (detail === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json(detail);
  });

  app.get(routePath(ENDPOINTS.api_host_report), (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const detail = buildHostDetail(name);
    if (detail === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const settings = readHostsSettings(db);
    const generatedAt = new Date();
    const text = buildHostReport(detail, generatedAt);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${reportFilename(name, generatedAt, settings.timezone)}"`,
    );
    res.status(200).send(`\ufeff${text}`);
  });

  app.get(routePath(ENDPOINTS.api_host_history), (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const rawRange = req.query['range'];
    const rangeKey = rawRange === undefined ? '24h' : String(rawRange);
    if (!['24h', '7d', '30d'].includes(rangeKey)) {
      res.status(400).json({ error: 'invalid_range' });
      return;
    }
    const detail = buildHostDetail(name);
    if (detail === null) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const settings = readHostsSettings(db);
    const points = fetchHostHistory(db, name, { rangeKey, tz: settings.timezone });
    res.json({ range: rangeKey, points });
  });

  // =========================================================================
  // Inventory
  // =========================================================================

  app.get(ENDPOINTS.api_list_hosts, (_req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    res.json({ hosts: listHosts(db, settingsOptions()) });
  });

  app.get(ENDPOINTS.api_host_collection_status, wrap(async (req: Request, res: Response) => {
    if (!deps.collectionStatus) {
      res.json({ statuses: {} });
      return;
    }
    const rawNames = req.query['names'];
    let names: string[] | null = null;
    if (rawNames !== undefined) {
      names = String(rawNames)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    }
    let statuses: Record<string, unknown> = {};
    try {
      statuses = await deps.collectionStatus(names);
    } catch {
      statuses = {};
    }
    res.json({ statuses });
  }));

  app.put(routePath(ENDPOINTS.api_upsert_host), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    if (!requireWritable(res)) return;
    const name = String(req.params['name'] ?? '');
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    // Python treats a missing/null `name` as the URL name; an explicit mismatch
    // is a 400. Mirror that before delegating to `upsertHost`.
    const body: Obj = { ...payload };
    if (body['name'] === undefined || body['name'] === null) body['name'] = name;
    const ok = withSettingsError(res, () => {
      upsertHost(db, body, { name, writable: isWritable(), baseServers: config.servers });
    });
    if (!ok) return;
    refreshConfig();
    notifyHostsImported([name]);
    if (body['sudo_password']) {
      deps.requestUserRefresh?.(true);
    }
    res.json({ ok: true });
  });

  app.delete(routePath(ENDPOINTS.api_delete_host), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    if (!requireWritable(res)) return;
    const name = String(req.params['name'] ?? '');
    if (getHost(db, name, settingsOptions()) === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const ok = withSettingsError(res, () => {
      deleteHost(db, name, settingsOptions());
    });
    if (!ok) return;
    refreshConfig();
    res.json({ ok: true });
  });

  app.post(routePath(ENDPOINTS.api_copy_host), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    if (!requireWritable(res)) return;
    const name = String(req.params['name'] ?? '');
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const newName = String(payload['new_name'] ?? '').trim();
    if (!newName) {
      res.status(400).json({ error: 'new_name 不能为空' });
      return;
    }
    const ok = withSettingsError(res, () => {
      copyHost(db, name, newName, settingsOptions());
    });
    if (!ok) return;
    refreshConfig();
    notifyHostsImported([newName]);
    res.json({ ok: true, name: newName });
  });

  // =========================================================================
  // Import
  // =========================================================================

  app.post(routePath(ENDPOINTS.api_preview_host_import), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    let preview: ReturnType<typeof previewHostImport>;
    try {
      preview = previewHostImport(db, { format: payload['format'], content: payload['content'] });
    } catch (err) {
      if (err instanceof HostSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    res.json({
      candidates: preview.candidates,
      errors: preview.errors,
      warnings: preview.warnings,
    });
  });

  app.get(routePath(ENDPOINTS.api_ssh_config_preview), (_req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    const preview = (deps.previewSshConfig ?? (() => previewSshConfigImport()))();
    res.json({
      path: preview.path,
      exists: preview.exists,
      default_username: preview.default_username,
      candidates: preview.candidates,
      errors: preview.errors,
      warnings: preview.warnings,
    });
  });

  app.post(routePath(ENDPOINTS.api_ssh_config_import), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    if (!requireWritable(res)) return;
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const rawNames = payload['names'];
    if (rawNames !== null && rawNames !== undefined) {
      if (!Array.isArray(rawNames) || !rawNames.every((n) => typeof n === 'string')) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
    }
    const preview = (deps.previewSshConfig ?? (() => previewSshConfigImport()))();
    const selected = Array.isArray(rawNames) ? new Set(rawNames as string[]) : null;
    const candidates = preview.candidates.filter(
      (candidate) => selected === null || selected.has(candidate.name),
    );
    if (selected !== null && candidates.length === 0) {
      res.status(400).json({ ok: false, error: 'no_matching_hosts', candidates: [] });
      return;
    }
    let result: ReturnType<typeof importHosts>;
    try {
      result = importHosts(db, candidates, {
        overwrite: truthyArg(payload['overwrite']),
        allowMissingCredentials: true,
        writable: isWritable(),
        baseServers: config.servers,
      });
    } catch (err) {
      if (err instanceof HostSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    refreshConfig();
    notifyHostsImported([...result.created, ...result.updated]);
    res.json({
      ok: true,
      exists: preview.exists,
      parse_errors: preview.errors,
      warnings: preview.warnings,
      ...result,
    });
  });

  app.post(routePath(ENDPOINTS.api_import_hosts), (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    if (!requireWritable(res)) return;
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    let preview: ReturnType<typeof previewHostImport>;
    try {
      preview = previewHostImport(db, { format: payload['format'], content: payload['content'] });
    } catch (err) {
      if (err instanceof HostSettingsError) {
        // `_parse_import_payload` returns the bare code (`unsupported_format` /
        // `invalid_payload`) as the `error` value.
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    let result: ReturnType<typeof importHosts>;
    try {
      result = importHosts(db, preview.candidates, {
        overwrite: truthyArg(payload['overwrite']),
        writable: isWritable(),
        baseServers: config.servers,
      });
    } catch (err) {
      if (err instanceof HostSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    refreshConfig();
    notifyHostsImported([...result.created, ...result.updated]);
    res.json({ ok: true, parse_errors: preview.errors, ...result });
  });

  // =========================================================================
  // Connectivity / probes
  // =========================================================================

  app.post(routePath(ENDPOINTS.api_test_hosts_batch), wrap(async (req: Request, res: Response) => {
    if (!requireSettings(res)) return;
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const names = payload['names'];
    if (!Array.isArray(names) || !names.every((n) => typeof n === 'string')) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    const runner: HostRunner =
      deps.runner ??
      (() => {
        throw new Error('SSH 运行器尚未迁移');
      });
    const result = await testHostsBatch(db, names as string[], runner, {
      writable: isWritable(),
      baseServers: config.servers,
    });
    res.json({ results: result.results });
  }));

  app.post(routePath(ENDPOINTS.probe_host_settings), wrap(async (req: Request, res: Response) => {
    const payload = jsonBody(req);
    const body = isMapping(payload) ? payload : {};
    if (!isMapping(payload) || String(body['host'] ?? '').trim() === '') {
      res.status(400).json({ ok: false, status: 'invalid', message: '请填写服务器地址' });
      return;
    }
    const host = String(body['host'] ?? '').trim();
    const allowlist = currentServers()
      .flatMap((server) => [server.name, server.host])
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value) => value.trim().toLowerCase());
    try {
      await assertSafeTarget(host, { allowlist });
    } catch (err) {
      if (err instanceof SSRFError) {
        res.status(200).json({ ok: false, status: 'blocked', message: err.message });
        return;
      }
      // Unresolvable targets are allowed through (nothing to dial), matching
      // the oracle's `getaddrinfo` failure branch.
    }
    if (!deps.probeHost) {
      // TODO: wire `host_probe.probe_host` once that module is migrated.
      res.status(200).json({ ok: false, status: 'error', message: '探测功能尚未迁移' });
      return;
    }
    try {
      const result = await deps.probeHost(body);
      res.status(200).json(result);
    } catch (err) {
      res.status(200).json({ ok: false, status: 'error', message: `探测失败：${(err as Error).message}` });
    }
  }));

  app.post(routePath(ENDPOINTS.api_probe_saved_host), wrap(async (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const host = findServer(name);
    if (!host) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!deps.probeHost) {
      // TODO: wire `host_probe.probe_host(host_config, timeout=…)` upstream.
      res.status(200).json({ ok: false, status: 'error', message: '探测功能尚未迁移' });
      return;
    }
    const result = await deps.probeHost(host);
    res.json(result);
  }));

  app.post(routePath(ENDPOINTS.api_test_saved_host_check), wrap(async (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const host = findServer(name);
    if (!host) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const payload = jsonBody(req);
    if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    }
    let check: HostCheckConfig;
    try {
      check = (deps.prepareHostCheck ?? sanitizeSingleCheck)(payload);
    } catch (err) {
      if (err instanceof HostSettingsError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    if (!deps.runHostChecks) {
      // TODO: wire `availability.run_host_checks` once SSH is migrated.
      res.status(200).json({ ok: false, error: '服务检查功能尚未迁移' });
      return;
    }
    try {
      const results = await deps.runHostChecks(host, [check]);
      res.status(200).json({ ok: true, results });
    } catch (err) {
      res.status(200).json({ ok: false, error: (err as Error).message });
    }
  }));

  app.post(routePath(ENDPOINTS.api_host_container_stats), wrap(async (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const host = findServer(name);
    if (!host) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!deps.collectContainerStats) {
      // TODO: wire `container_stats.collect_container_stats` once migrated.
      res.status(200).json({ ok: false, error: '容器统计功能尚未迁移' });
      return;
    }
    try {
      const containers = await deps.collectContainerStats(host);
      res.status(200).json({ ok: true, collected_at: nowIsoUtc(), containers });
    } catch (err) {
      res.status(200).json({ ok: false, error: (err as Error).message });
    }
  }));

  app.post(routePath(ENDPOINTS.api_run_host_checks), wrap(async (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    const host = findServer(name);
    if (!host) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const checks = (host.checks ?? []).filter((check) => check.enabled !== false);
    if (checks.length === 0) {
      res.status(200).json({ ok: false, error: '该主机还没有配置服务检查' });
      return;
    }
    if (!deps.runHostChecks) {
      // TODO: wire `availability.run_host_checks` once SSH is migrated.
      res.status(200).json({ ok: false, error: '服务检查功能尚未迁移' });
      return;
    }
    let results: unknown[];
    try {
      results = await deps.runHostChecks(host, checks);
    } catch (err) {
      res.status(200).json({ ok: false, error: (err as Error).message });
      return;
    }
    // Persist opportunistically; metrics already computed, never fail the call.
    try {
      const rows = results.map((raw) => {
        const row = asObj(raw);
        return {
          name: String(row['name'] ?? ''),
          type: String(row['type'] ?? ''),
          target: String(row['target'] ?? ''),
          status: String(row['status'] ?? 'unknown'),
          message: row['message'] === undefined || row['message'] === null ? null : String(row['message']),
          latency_ms: asFloat(row['latency_ms']),
        };
      });
      saveHostCheckResults(db, name, rows);
      appendHostCheckHistory(
        db,
        name,
        rows.map((row) => ({ name: row.name, status: row.status, latency_ms: row.latency_ms })),
      );
    } catch {
      // Best-effort persistence — ignore.
    }
    res.status(200).json({
      ok: true,
      checked_at: nowIsoUtc(),
      checks: results.map((raw) => {
        const row = asObj(raw);
        return {
          name: row['name'] ?? null,
          type: row['type'] ?? null,
          target: row['target'] ?? null,
          status: row['status'] ?? null,
          message: row['message'] ?? null,
          latency_ms: row['latency_ms'] ?? null,
        };
      }),
    });
  }));

  // =========================================================================
  // Immediate collection
  // =========================================================================

  app.post(routePath(ENDPOINTS.api_collect_saved_host), wrap(async (req: Request, res: Response) => {
    const name = String(req.params['name'] ?? '');
    if (!findServer(name)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    if (!deps.collectHosts) {
      res.status(409).json({ error: 'collection_unavailable' });
      return;
    }
    try {
      await deps.collectHosts([name]);
    } catch {
      res.status(500).json({ error: 'collection_failed' });
      return;
    }
    res.json({ ok: true });
  }));

  app.post(routePath(ENDPOINTS.api_collect_saved_hosts), wrap(async (req: Request, res: Response) => {
    const savedNames = currentServers().map((server) => server.name);
    const payload = jsonBody(req);
    let selected: string[];
    if (payload === null || payload === undefined) {
      selected = savedNames;
    } else if (!isMapping(payload)) {
      res.status(400).json({ error: 'invalid_payload' });
      return;
    } else {
      const rawNames = payload['names'];
      if (rawNames === null || rawNames === undefined) {
        selected = savedNames;
      } else if (!Array.isArray(rawNames)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      } else {
        const wanted = new Set(rawNames.map((value) => String(value)));
        selected = savedNames.filter((name) => wanted.has(name));
      }
    }
    if (selected.length === 0) {
      res.json({ ok: true, count: 0 });
      return;
    }
    if (!deps.collectHosts) {
      res.status(409).json({ error: 'collection_unavailable' });
      return;
    }
    try {
      await deps.collectHosts(selected);
    } catch {
      res.status(500).json({ error: 'collection_failed' });
      return;
    }
    res.json({ ok: true, count: selected.length });
  }));
}
