/**
 * Users routes — the Express equivalent of `servermanage/web/routes/users.py`
 * (P2 Task 14).
 *
 * Registers the full server-user monitoring surface with the same URL rules,
 * HTTP methods, JSON field names, status codes, error codes/messages and
 * template context keys as the Python oracle:
 *
 *   GET  /api/users                  → api_users                 (fleet payload)
 *   POST /api/users/refresh          → api_users_refresh         (trigger a scan)
 *   GET  /api/users/history          → api_users_history         (30-day series)
 *   GET  /api/users/top              → api_users_top             (top growth)
 *   GET  /api/users/refresh-status   → api_users_refresh_status  (scan progress)
 *   POST /api/users/baseline/remove  → api_users_baseline_remove (forget a baseline)
 *   POST /api/users/plan             → api_users_plan            (preview a plan)
 *   POST /api/users/execute          → api_users_execute         (run a plan)
 *   GET  /api/users/execute/status   → api_users_execute_status  (poll a job)
 *   GET  /api/users/operations       → api_users_operations     (audit trail)
 *   GET  /users                      → users_page                (`users.html`)
 *
 * Read-only storage queries reuse `storage/users.ts`, `storage/hosts.ts` and
 * `storage/alerts.ts` unchanged. The SSH/scan/provisioning capabilities are
 * never performed directly: they are delegated to injected collaborators in
 * {@link UsersRouteDeps} so tests run without a real connection.
 *
 * The middleware gate chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 *
 * NOT PORTED (minimal placeholder + TODO):
 *   - The `user_admin.py` planner (`build_plan`, ~160 lines, one branch per
 *     operation) and the SSH `execute_plan` runner are not ported in this task.
 *     `/api/users/plan` delegates to an injected {@link UsersAdminApi}; when it
 *     is absent the endpoint returns `503 {error:'unavailable'}`. `/api/users/execute`
 *     delegates the background run to an injected `runExecuteJob`; with no cached
 *     plan it returns `410 plan_expired` exactly like the oracle.
 *   - The in-worker `refresh_users` / `user_scan_status` capabilities are injected
 *     via {@link UsersMonitorService}.
 */
import { randomBytes } from 'node:crypto';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import type { AppConfig, HostConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import {
  deleteUserBaseline,
  getAllHostUserSnapshots,
  getAllUserBaselines,
  getAllUserScanStates,
  getAllUserUsageDeltas,
  getHostUserSnapshot,
  getUserBaseline,
  getUserUsageDeltas,
  getUserUsageSeries,
  listUserOperations,
  topUserGrowth,
  type UserRow,
  type UserScanState,
  type UserUsageDelta,
  type UserUsagePoint,
} from '../../storage/users';
import {
  getAllHostSnapshots,
  getHostSnapshot,
  type HostSnapshot,
} from '../../storage/hosts';
import { listAlerts, updateAlert } from '../../storage/alerts';
import { nowIsoUtc } from '../../storage/time';
import { createTemplating, type Templating } from '../templating';
import type { SessionManager } from '../session';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Worker capabilities the users page needs (scan trigger + progress). */
export interface UsersMonitorService {
  /** Trigger a background user scan. `force_usage` bypasses the usage interval. */
  refresh_users?: (options?: { force_usage?: boolean }) => unknown | Promise<unknown>;
  /** Snapshot of the in-flight user scan (or `{running:false}`). */
  user_scan_status?: () => unknown;
}

/**
 * Ported-or-injected equivalent of the `user_admin` planner helpers.
 *
 * Declared as an interface so this task can ship the route surface without the
 * 160-line `build_plan` port; the composition root wires the real planner here.
 */
export interface UsersAdminApi {
  /** Error class raised by validation/plan failures (`AdminPlanError`). */
  AdminPlanError: new (message: string) => Error;
  /** Normalise an account name or throw {@link UsersAdminApi.AdminPlanError}. */
  validateAccountName: (value: unknown) => string;
  /** Build a human-reviewable plan (contains `stdin` secrets server-side). */
  buildPlan: (operation: string, options: Record<string, unknown>) => Obj;
  /** Strip every secret from a plan before it reaches the browser. */
  publicPlan: (plan: Obj) => Obj;
}

/** Background runner for a provisioning plan (the SSH `execute_plan` equivalent). */
export type UsersExecuteRunner = (job: Obj, plan: Obj) => void | Promise<void>;

/** Options accepted by {@link registerUsersRoutes}. Only `db`/`config` required. */
export interface UsersRouteDeps {
  /** Open SQLite handle (settings + snapshots + history + alerts). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers + app version). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /** Current composed servers; defaults to `config.servers`. */
  currentServers?: () => HostConfig[];
  /** Worker scan service (`refresh_users` / `user_scan_status`). */
  monitorService?: UsersMonitorService | null;
  /** Planner helpers (`validate_account_name` / `build_plan` / `public_plan`). */
  admin?: UsersAdminApi | null;
  /** Background provisioning runner; defaults to a no-op (job stays `running`). */
  runExecuteJob?: UsersExecuteRunner;
}

// ---------------------------------------------------------------------------
// Small value helpers (mirrors of the private `_core.py` helpers)
// ---------------------------------------------------------------------------

function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isMapping(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Reads a JSON body only when the request carried JSON (`get_json(silent=True)` → None). */
function jsonBody(req: Request): unknown {
  if (!req.is('application/json')) {
    return null;
  }
  return req.body;
}

/** Query-string value as a trimmed string (`None` / array → ""). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Wraps an async handler so rejected promises reach the Express error handler. */
function wrap(fn: (req: Request, res: Response) => unknown): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Python `int()` on a query value; `null`/`""` → fallback, bad → 'invalid'. */
function parseIntArg(value: unknown, fallback: number): number | 'invalid' {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (text === '') return fallback;
  if (!/^[+-]?\d+$/.test(text)) return 'invalid';
  return Number.parseInt(text, 10);
}

/** Python `_as_int`: best-effort int, default on failure. */
function asIntDefault(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  if (!/^[+-]?\d+$/.test(text)) return fallback;
  return Number.parseInt(text, 10);
}

/** Python `float(x or 0)` for GPU memory values. */
function floatOr0(value: unknown): number {
  if (value === null || value === undefined || value === '' || value === false || value === 0) {
    return 0;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Python `round(value, 1)` (round-half-to-even on the scaled value). */
function pyRound1(value: number): number {
  const scaled = value * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (Math.abs(diff - 0.5) < 1e-9) {
    return (floor % 2 === 0 ? floor : floor + 1) / 10;
  }
  return Math.round(scaled) / 10;
}

/** Parses a stored ISO timestamp; a naive value is treated as UTC. */
function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const text = value.trim();
  const hasZone = /[zZ]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(text);
  const date = new Date(hasZone ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Renders a stored ISO timestamp as offset-qualified local ISO (`_to_local_iso`). */
function toLocalIso(value: unknown, timeZone: string): unknown {
  const date = parseIsoDate(value);
  if (date === null) return value;
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

/** Renders a stored ISO timestamp as `YYYY-MM-DD HH:MM` local time (`_to_local_text`). */
function toLocalText(value: unknown, timeZone: string): unknown {
  const date = parseIsoDate(value);
  if (date === null) return value;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(date);
    const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
    return `${get('year')}-${get('month')}-${get('day')} ${pad2(Number(get('hour')) % 24)}:${get('minute')}`;
  } catch {
    return value;
  }
}

// ---------------------------------------------------------------------------
// Settings / mode / session readers
// ---------------------------------------------------------------------------

interface UserMonitoringSettings {
  enabled: boolean;
  write_enabled: boolean;
}

interface UserSettings {
  timezone: string;
  user_monitoring: UserMonitoringSettings;
}

/** Reads the timezone + user-monitoring switches the routes need from the DB. */
function readUserSettings(db: SqliteDatabase): UserSettings {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const userMonitoring = asObj(settings.user_monitoring);
  const rawTz = monitoring.timezone;
  const timezone = typeof rawTz === 'string' && rawTz ? rawTz : 'Asia/Shanghai';
  return {
    timezone,
    user_monitoring: {
      enabled: userMonitoring.enabled !== false,
      write_enabled: userMonitoring.write_enabled === true,
    },
  };
}

/** `is_user_monitoring_enabled`: per-host tri-state overrides the global switch. */
function isUserMonitoringEnabled(server: HostConfig, settings: UserSettings): boolean {
  if (typeof server.user_monitoring === 'boolean') {
    return server.user_monitoring;
  }
  return settings.user_monitoring.enabled;
}

/** `_view_mode`: the active view mode ('user' only when the web settings say so). */
function viewMode(req: Request): string {
  const locals = req.app?.locals as { webSettings?: { mode?: unknown } } | undefined;
  return locals?.webSettings?.mode === 'user' ? 'user' : 'admin';
}

/** The logged-in username from the signed session cookie, or "". */
function sessionUsername(req: Request): string {
  const locals = req.app?.locals as { session?: SessionManager } | undefined;
  const manager = locals?.session;
  if (!manager || typeof manager.getSession !== 'function') return '';
  const data = manager.getSession(req);
  const username = data?.username;
  return typeof username === 'string' ? username : '';
}

// ---------------------------------------------------------------------------
// Row builders (ports of the `_core.py` user helpers)
// ---------------------------------------------------------------------------

const USER_DIRECTORY_ISSUES = new Set(['home', 'data', 'owner']);
const USAGE_DELTA_DAYS = 7;

/** `_user_row_issues`: UI issue keys for a *present* snapshot row. */
function userRowIssues(row: Obj): string[] {
  const username = String(row['username'] ?? '');
  const issues: string[] = [];
  if (!row['in_docker']) issues.push('docker');
  if (!row['home_exists']) issues.push('home');
  if (row['data_supported'] && !row['data_exists']) issues.push('data');
  const ownerMismatch =
    Boolean(row['home_exists'] && row['home_owner'] && row['home_owner'] !== username) ||
    Boolean(row['data_supported'] && row['data_exists'] && row['data_owner'] && row['data_owner'] !== username);
  if (ownerMismatch) issues.push('owner');
  return issues;
}

/** `_user_usage_readable`: did the collector manage to measure the directories? */
function userUsageReadable(row: Obj): boolean {
  const value = row['usage_readable'];
  if (value !== null && value !== undefined) {
    return Boolean(value);
  }
  return row['home_size_bytes'] !== null && row['home_size_bytes'] !== undefined
    ? true
    : row['data_size_bytes'] !== null && row['data_size_bytes'] !== undefined;
}

/** `_usage_hint`: explain why directory sizes are missing. */
function usageHint(row: Obj, server: HostConfig | undefined): string {
  if (userUsageReadable(row)) return '';
  const hasPassword = Boolean(server?.sudo_password);
  if (!hasPassword) {
    return '未配置 sudo 密码，已跳过目录占用统计；可在该主机设置里填写 sudo 密码（或配置免密 sudo）。';
  }
  return '上次统计失败或超时，将在下个统计周期重试。';
}

/** `_present_user_row`: build an API row for a user in the latest snapshot. */
function presentUserRow(hostName: string, row: UserRow, server: HostConfig | undefined): Obj {
  const item: Obj = { ...row };
  item['host_name'] = hostName;
  item['state'] = 'present';
  if (!('first_seen_at' in item)) item['first_seen_at'] = null;
  if (!('last_seen_at' in item)) item['last_seen_at'] = null;
  item['usage_readable'] = userUsageReadable(item);
  item['usage_hint'] = usageHint(item, server);
  item['issues'] = userRowIssues(item);
  return item;
}

/** `_missing_user_row`: build an API row for a baseline-only (disappeared) account. */
function missingUserRow(hostName: string, row: UserRow): Obj {
  return {
    host_name: hostName,
    username: row['username'],
    state: 'missing',
    uid: row['uid'],
    gid: row['gid'],
    primary_group: row['primary_group'],
    gecos: '',
    home: row['home'],
    shell: row['shell'],
    groups: Array.isArray(row['groups']) ? [...row['groups']] : [],
    in_docker: row['in_docker'],
    in_sudo: row['in_sudo'],
    home_exists: null,
    home_owner: null,
    home_group: null,
    home_mode: null,
    home_size_bytes: null,
    data_exists: null,
    data_owner: null,
    data_group: null,
    data_mode: null,
    data_size_bytes: null,
    data_supported: null,
    usage_stale: null,
    usage_readable: null,
    usage_collected_at: null,
    collected_at: null,
    first_seen_at: row['first_seen_at'],
    last_seen_at: row['last_seen_at'],
    issues: ['missing'],
  };
}

/** `_merge_user_rows`: merge one host's snapshot (present) and baseline (missing) rows. */
function mergeUserRows(
  hostName: string,
  snapshotRows: UserRow[],
  baselineRows: UserRow[],
  server: HostConfig | undefined,
): Obj[] {
  const rows: Obj[] = [];
  const present = new Set<string>();
  for (const row of snapshotRows) {
    const username = row['username'];
    if (!username) continue;
    present.add(String(username));
    rows.push(presentUserRow(hostName, row, server));
  }
  for (const row of baselineRows) {
    const username = row['username'];
    if (!username || present.has(String(username))) continue;
    rows.push(missingUserRow(hostName, row));
  }
  rows.sort((a, b) => String(a['username'] ?? '').localeCompare(String(b['username'] ?? '')));
  return rows;
}

/** `_user_host_status`: 'ok' / 'unknown' (never scanned) / 'error'. */
function userHostStatus(state: UserScanState | undefined): string {
  if (String(state?.last_error ?? '').trim()) return 'error';
  if (state?.last_scan_at) return 'ok';
  return 'unknown';
}

interface GpuBucket {
  mb: number;
  procs: number;
}

/** `_gpu_usage_from_metrics`: sum GPU memory per account from one metrics snapshot. */
function gpuUsageFromMetrics(metrics: Obj): Record<string, GpuBucket> {
  const usage: Record<string, GpuBucket> = {};
  for (const raw of asArray(metrics['gpu_processes'])) {
    const proc = asObj(raw);
    const who = String(proc['username'] ?? '').trim();
    if (!who) continue;
    const bucket = usage[who] ?? { mb: 0, procs: 0 };
    bucket.mb += floatOr0(proc['memory_used_mb']);
    bucket.procs += 1;
    usage[who] = bucket;
  }
  return usage;
}

/** `_gpu_usage_by_user`: GPU memory per account from the latest host snapshot. */
function gpuUsageByUser(db: SqliteDatabase, hostName: string): Record<string, GpuBucket> {
  const snapshot = getHostSnapshot(db, hostName);
  return gpuUsageFromMetrics(asObj(snapshot?.metrics));
}

interface PrecomputedUserRows {
  snapshots?: UserRow[];
  baselines?: UserRow[];
  deltas?: Record<string, UserUsageDelta>;
  gpuUsage?: Record<string, GpuBucket>;
}

/** `_build_user_rows`: merged present/missing rows for one host. */
function buildUserRows(
  hostName: string,
  db: SqliteDatabase,
  tz: string | null,
  server: HostConfig | undefined,
  precomputed: PrecomputedUserRows = {},
): Obj[] {
  const snapshotRows = precomputed.snapshots ?? getHostUserSnapshot(db, hostName);
  const baselineRows = precomputed.baselines ?? getUserBaseline(db, hostName);
  const rows = mergeUserRows(hostName, snapshotRows, baselineRows, server);
  const deltas = precomputed.deltas ?? getUserUsageDeltas(db, hostName, { days: USAGE_DELTA_DAYS });
  const gpuUsage = precomputed.gpuUsage ?? gpuUsageByUser(db, hostName);
  for (const row of rows) {
    const username = String(row['username'] ?? '');
    const info = deltas[username];
    row['usage_delta_bytes'] = info ? (info.delta ?? null) : null;
    row['usage_delta_days'] = info ? USAGE_DELTA_DAYS : null;
    row['usage_delta_since'] = info ? (info.since ?? null) : null;
    const gpu = gpuUsage[username];
    row['gpu_memory_mb'] = gpu ? pyRound1(gpu.mb) : null;
    row['gpu_process_count'] = gpu ? gpu.procs : 0;
  }
  if (tz !== null) {
    for (const row of rows) {
      for (const key of ['collected_at', 'usage_collected_at', 'last_seen_at']) {
        row[key] = toLocalText(row[key], tz);
      }
    }
  }
  return rows;
}

/** `_host_user_counts`: per-host roll-up used by the host cards on `/users`. */
function hostUserCounts(rows: Obj[]): Obj {
  const present = rows.filter((row) => row['state'] === 'present');
  const missing = rows.filter((row) => row['state'] === 'missing');
  const sumWhere = (key: string): number =>
    rows.reduce((total, row) => total + (row[key] !== null && row[key] !== undefined ? Number(row[key]) || 0 : 0), 0);
  return {
    present: present.length,
    missing: missing.length,
    docker_issues: rows.filter((row) => asArray(row['issues']).includes('docker')).length,
    directory_issues: rows.filter((row) =>
      asArray(row['issues']).some((issue) => USER_DIRECTORY_ISSUES.has(String(issue))),
    ).length,
    gpu_memory_mb: pyRound1(rows.reduce((total, row) => total + (Number(row['gpu_memory_mb']) || 0), 0)),
    gpu_processes: rows.reduce((total, row) => total + (Number(row['gpu_process_count']) || 0), 0),
    home_bytes: sumWhere('home_size_bytes'),
    data_bytes: sumWhere('data_size_bytes'),
    bytes: rows.reduce(
      (total, row) => total + (Number(row['home_size_bytes']) || 0) + (Number(row['data_size_bytes']) || 0),
      0,
    ),
    delta_bytes: sumWhere('usage_delta_bytes'),
    delta_days: USAGE_DELTA_DAYS,
    usage_readable: !present.some((row) => row['usage_readable'] === false),
  };
}

/** `_aggregate_series`: sum every account's points into one per-timestamp series. */
function aggregateSeries(series: Record<string, UserUsagePoint[]>): Obj[] {
  const buckets = new Map<string, number>();
  for (const points of Object.values(series ?? {})) {
    for (const point of points ?? []) {
      const stamp = point?.at;
      if (!stamp) continue;
      buckets.set(stamp, (buckets.get(stamp) ?? 0) + (Number(point.total) || 0));
    }
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([at, total]) => ({ at, total }));
}

/** `_usage_scan_state`: describe the running usage scan for the page. */
function usageScanState(service: UsersMonitorService | null | undefined): Obj {
  const status = service?.user_scan_status;
  if (typeof status !== 'function') {
    return { running: false };
  }
  let payload: unknown;
  try {
    payload = status.call(service);
  } catch {
    return { running: false };
  }
  if (!isMapping(payload)) {
    return { running: false };
  }
  return {
    running: Boolean(payload['running']),
    hosts_done: Math.trunc(Number(payload['hosts_done']) || 0),
    hosts_total: Math.trunc(Number(payload['hosts_total']) || 0),
    started_at: payload['started_at'] ?? null,
    current_host: payload['current_host'] ?? null,
    current_account: payload['current_account'] ?? null,
    next_account: payload['next_account'] ?? null,
    accounts_done: Math.trunc(Number(payload['accounts_done']) || 0),
    accounts_total: Math.trunc(Number(payload['accounts_total']) || 0),
  };
}

/** `_build_users_payload`: the `GET /api/users` payload for every configured host. */
function buildUsersPayload(args: {
  servers: HostConfig[];
  db: SqliteDatabase;
  settings: UserSettings;
  tz: string;
  host?: string;
  query?: string;
  status?: string;
  monitorService?: UsersMonitorService | null;
}): Obj {
  const { servers, db, settings, tz } = args;
  const hostFilter = (args.host ?? '').trim();
  const needle = (args.query ?? '').trim().toLowerCase();
  const rawStatus = args.status ?? 'all';
  const statusFilter = ['all', 'warning', 'error', 'ok'].includes(rawStatus) ? rawStatus : 'all';

  const allNames: string[] = [];
  const enabled: Record<string, boolean> = {};
  for (const server of servers) {
    if (server.name in enabled) continue;
    allNames.push(server.name);
    enabled[server.name] = isUserMonitoringEnabled(server, settings);
  }

  const hostBlocks: Obj[] = [];
  const allRows: Obj[] = [];
  const statuses: Record<string, string> = {};
  const addresses: Record<string, string> = {};
  const serversByName: Record<string, HostConfig> = {};
  for (const server of servers) {
    addresses[server.name] = server.host;
    serversByName[server.name] = server;
  }

  const fleetSnapshots = getAllHostUserSnapshots(db);
  const fleetBaselines = getAllUserBaselines(db);
  const fleetDeltas = getAllUserUsageDeltas(db, { days: USAGE_DELTA_DAYS });
  const fleetStates = getAllUserScanStates(db);
  const latestByHost: Record<string, HostSnapshot> = {};
  for (const item of getAllHostSnapshots(db)) {
    latestByHost[item.host_name] = item;
  }

  for (const name of allNames) {
    if (!enabled[name]) {
      statuses[name] = 'disabled';
      hostBlocks.push({
        name,
        address: addresses[name] ?? null,
        status: 'disabled',
        monitored: false,
        last_scan_at: null,
        last_usage_at: null,
        last_error: null,
        accounts: 0,
        allow_user_write: false,
        sudo_ok: false,
        ...hostUserCounts([]),
      });
      continue;
    }
    const hostSnapshot = latestByHost[name];
    const precomputed: PrecomputedUserRows = {
      snapshots: fleetSnapshots[name],
      baselines: fleetBaselines[name],
      deltas: fleetDeltas[name],
      gpuUsage: hostSnapshot ? gpuUsageFromMetrics(asObj(hostSnapshot.metrics)) : undefined,
    };
    const server = serversByName[name];
    const rows = buildUserRows(name, db, tz, server, precomputed);
    const state = fleetStates[name];
    const hostStatus = userHostStatus(state);
    statuses[name] = hostStatus;
    allRows.push(...rows);
    hostBlocks.push({
      name,
      address: addresses[name] ?? null,
      status: hostStatus,
      monitored: true,
      last_scan_at: toLocalIso(state?.last_scan_at ?? null, tz),
      last_usage_at: toLocalIso(state?.last_usage_at ?? null, tz),
      last_error: state?.last_error || null,
      accounts: rows.length,
      allow_user_write: Boolean(server?.allow_user_write),
      sudo_ok: Boolean(server?.sudo_password),
      ...hostUserCounts(rows),
    });
  }

  const filtered: Obj[] = [];
  for (const row of allRows) {
    if (hostFilter && row['host_name'] !== hostFilter) continue;
    if (statusFilter === 'warning' && !(asArray(row['issues']).length || row['state'] === 'missing')) continue;
    if (statusFilter === 'error' && statuses[String(row['host_name'])] !== 'error') continue;
    if (statusFilter === 'ok' && (asArray(row['issues']).length || row['state'] === 'missing')) continue;
    if (needle) {
      const haystack = [
        String(row['username'] ?? ''),
        String(row['host_name'] ?? ''),
        String(row['primary_group'] ?? ''),
        asArray(row['groups']).map((group) => String(group)).join(' '),
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    filtered.push(row);
  }

  const sumBytes = (key: string): number =>
    allRows.reduce((total, row) => total + (row[key] !== null && row[key] !== undefined ? Number(row[key]) || 0 : 0), 0);
  const summary = {
    total: allRows.length,
    present: allRows.filter((row) => row['state'] === 'present').length,
    missing: allRows.filter((row) => row['state'] === 'missing').length,
    docker_issues: allRows.filter((row) => asArray(row['issues']).includes('docker')).length,
    directory_issues: allRows.filter((row) =>
      asArray(row['issues']).some((issue) => USER_DIRECTORY_ISSUES.has(String(issue))),
    ).length,
    home_bytes: sumBytes('home_size_bytes'),
    data_bytes: sumBytes('data_size_bytes'),
  };

  const blocked = hostBlocks
    .filter((block) => block['monitored'] && !block['sudo_ok'] && block['accounts'])
    .map((block) => String(block['name']));
  let usageHintText = '';
  if (blocked.length > 0) {
    const preview = blocked.slice(0, 3).join('、');
    usageHintText =
      `${blocked.length} 台主机没有 sudo 密码，目录占用无法统计（${preview}）。` +
      '在设置 → 主机里填写 sudo 密码后会立刻开始统计。';
  }

  const totals: Record<string, Obj[]> = {};
  for (const block of hostBlocks) {
    let series: Record<string, UserUsagePoint[]> = {};
    try {
      series = getUserUsageSeries(db, String(block['name'] ?? ''), { days: 30 });
    } catch {
      series = {};
    }
    totals[String(block['name'] ?? '')] = aggregateSeries(series);
  }

  return {
    accounts: filtered,
    usage_totals: totals,
    hosts: hostBlocks,
    summary,
    usage_hint: usageHintText,
    usage_scan: usageScanState(args.monitorService),
    write_enabled: settings.user_monitoring.write_enabled,
    filters: {
      host: hostFilter,
      q: (args.query ?? '').trim(),
      status: statusFilter,
    },
  };
}

/** `fingerprint_for('user-present', host, username)`. */
function userPresentFingerprint(hostName: string, username: string): string {
  return ['user-present', hostName, username].join(':').toLowerCase();
}

/** `_resolve_user_present_alert`: mark open `user-present` alerts resolved. */
function resolveUserPresentAlert(db: SqliteDatabase, hostName: string, username: string): void {
  const fingerprint = userPresentFingerprint(hostName, username);
  for (const alert of listAlerts(db, { status: 'active', limit: 1000 })) {
    if (alert.fingerprint !== fingerprint) continue;
    updateAlert(db, Number(alert.id), { status: 'resolved' });
  }
}

// ---------------------------------------------------------------------------
// Plan cache + execute-job store (in-process, mirrors `user_admin.PlanCache`)
// ---------------------------------------------------------------------------

class PlanCache {
  private readonly items = new Map<string, { created: number; plan: Obj }>();

  constructor(private readonly ttlSeconds = 600, private readonly maxEntries = 32) {}

  put(plan: Obj): void {
    const now = Date.now() / 1000;
    this.prune(now);
    const hash = String(plan['plan_hash'] ?? '');
    this.items.set(hash, { created: now, plan });
    while (this.items.size > this.maxEntries) {
      let oldestKey = '';
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, value] of this.items) {
        if (value.created < oldest) {
          oldest = value.created;
          oldestKey = key;
        }
      }
      if (oldestKey) this.items.delete(oldestKey);
    }
  }

  get(planHash: string): Obj | null {
    const now = Date.now() / 1000;
    this.prune(now);
    return this.items.get(planHash)?.plan ?? null;
  }

  drop(planHash: string): void {
    this.items.delete(planHash);
  }

  private prune(now: number): void {
    for (const [key, value] of this.items) {
      if (now - value.created > this.ttlSeconds) this.items.delete(key);
    }
  }
}

const EXECUTE_JOB_TTL_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/** Registers the 11 users endpoints on `app` (mirrors `register_users`). */
export function registerUsersRoutes(app: Express, deps: UsersRouteDeps): void {
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });
  const db = deps.db;
  const planCache = new PlanCache();
  const executeJobs = new Map<string, Obj>();

  const servers = (): HostConfig[] => (deps.currentServers ? deps.currentServers() : deps.config.servers);

  /** Returns `{server}` or `{error}` for an account-provisioning request (`_user_write_host`). */
  const userWriteHost = (
    settings: UserSettings,
    hostName: string | null | undefined,
    req: Request,
  ): { server?: HostConfig; error?: { status: number; body: Obj } } => {
    if (!settings.user_monitoring.write_enabled) {
      return {
        error: {
          status: 403,
          body: {
            error: 'write_disabled',
            message: '账号写操作总开关未开启。请到设置 → 服务器用户监控里开启。',
          },
        },
      };
    }
    let name = hostName;
    if (name === null || name === undefined) {
      const payload = jsonBody(req);
      if (!isMapping(payload)) {
        return { error: { status: 400, body: { error: 'invalid_payload' } } };
      }
      name = String(payload['host'] ?? '').trim();
    }
    const server = servers().find((item) => item.name === name);
    if (!server) {
      return { error: { status: 404, body: { error: 'unknown_host' } } };
    }
    if (!server.allow_user_write) {
      return {
        error: {
          status: 403,
          body: {
            error: 'host_write_disabled',
            message: `${name} 未开启“允许账号写操作”，请先在该主机设置里打开。`,
          },
        },
      };
    }
    if (!server.sudo_password) {
      return {
        error: {
          status: 403,
          body: {
            error: 'sudo_password_missing',
            message: '这台主机还没有配置 sudo 密码，无法执行需要 root 的操作。',
          },
        },
      };
    }
    return { server };
  };

  const sendError = (res: Response, error: { status: number; body: Obj }): void => {
    res.status(error.status).json(error.body);
  };

  // -------------------------------------------------------------------------
  // Fleet payload + scan control
  // -------------------------------------------------------------------------

  app.get(
    ENDPOINTS.api_users,
    wrap((req: Request, res: Response) => {
      const settings = readUserSettings(db);
      res.json(
        buildUsersPayload({
          servers: servers(),
          db,
          settings,
          tz: settings.timezone,
          host: asString(req.query['host']),
          query: asString(req.query['q']),
          status: (asString(req.query['status']) || 'all').trim().toLowerCase(),
          monitorService: deps.monitorService,
        }),
      );
    }),
  );

  app.post(
    ENDPOINTS.api_users_refresh,
    wrap(async (req: Request, res: Response) => {
      const service = deps.monitorService;
      const refresh = service?.refresh_users;
      if (typeof refresh !== 'function') {
        res.status(503).json({ error: 'unavailable' });
        return;
      }
      const payload = jsonBody(req);
      const forceUsage = isMapping(payload) ? Boolean(payload['usage']) : false;
      let result: unknown;
      try {
        result = await refresh.call(service, { force_usage: forceUsage });
      } catch {
        try {
          result = await refresh.call(service);
        } catch {
          res.status(500).json({ error: 'refresh_failed' });
          return;
        }
      }
      if (!isMapping(result)) {
        result = { ok: true };
      }
      res.status(200).json(result);
    }),
  );

  app.get(
    ENDPOINTS.api_users_history,
    wrap((req: Request, res: Response) => {
      const hostName = asString(req.query['host']).trim();
      if (!hostName) {
        res.status(400).json({ error: 'host_required' });
        return;
      }
      const days = parseIntArg(req.query['days'], 30);
      if (days === 'invalid') {
        res.status(400).json({ error: 'invalid_days' });
        return;
      }
      const clamped = Math.max(1, Math.min(90, days));
      const series = getUserUsageSeries(db, hostName, { days: clamped });
      res.json({ host: hostName, days: clamped, accounts: series });
    }),
  );

  app.get(
    ENDPOINTS.api_users_top,
    wrap((req: Request, res: Response) => {
      const days = parseIntArg(req.query['days'], 7);
      if (days === 'invalid') {
        res.status(400).json({ error: 'invalid_days' });
        return;
      }
      const limit = parseIntArg(req.query['limit'], 8);
      if (limit === 'invalid') {
        res.status(400).json({ error: 'invalid_limit' });
        return;
      }
      const clampedDays = Math.max(1, Math.min(90, days));
      const clampedLimit = Math.max(1, Math.min(20, limit));
      const items = topUserGrowth(db, { days: clampedDays, limit: clampedLimit });
      res.json({ days: clampedDays, items });
    }),
  );

  app.get(
    ENDPOINTS.api_users_refresh_status,
    wrap((_req: Request, res: Response) => {
      const service = deps.monitorService;
      const status = service?.user_scan_status;
      if (typeof status !== 'function') {
        res.json({ running: false, error: 'unavailable' });
        return;
      }
      let payload: unknown;
      try {
        payload = status.call(service);
      } catch {
        res.json({ running: false, error: 'unavailable' });
        return;
      }
      if (!isMapping(payload)) {
        res.json({ running: false, error: 'unavailable' });
        return;
      }
      res.json(payload);
    }),
  );

  // -------------------------------------------------------------------------
  // Baselines
  // -------------------------------------------------------------------------

  app.post(
    ENDPOINTS.api_users_baseline_remove,
    wrap((req: Request, res: Response) => {
      const payload = jsonBody(req);
      if (!isMapping(payload)) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const rawHost = payload['host'];
      const rawUser = payload['username'];
      if (typeof rawHost !== 'string' || typeof rawUser !== 'string') {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      const hostName = rawHost.trim();
      const username = rawUser.trim();
      if (!hostName || !username) {
        res.status(400).json({ error: 'invalid_payload' });
        return;
      }
      if (!servers().some((server) => server.name === hostName)) {
        res.status(400).json({ error: 'unknown_host' });
        return;
      }
      const snapshotNames = new Set(
        getHostUserSnapshot(db, hostName).map((row) => String(row['username'])),
      );
      if (snapshotNames.has(username)) {
        res.status(409).json({
          error: 'account_present',
          message: '该账号仍存在于主机上，无法清除基线',
        });
        return;
      }
      if (!deleteUserBaseline(db, hostName, username)) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      resolveUserPresentAlert(db, hostName, username);
      res.json({ ok: true, removed: 1 });
    }),
  );

  // -------------------------------------------------------------------------
  // Provisioning: plan / execute / status (delegated collaborators)
  // -------------------------------------------------------------------------

  app.post(
    ENDPOINTS.api_users_plan,
    wrap((req: Request, res: Response) => {
      const settings = readUserSettings(db);
      const gate = userWriteHost(settings, null, req);
      if (gate.error) {
        sendError(res, gate.error);
        return;
      }
      const server = gate.server as HostConfig;
      const admin = deps.admin;
      // TODO(P2 Task14): port user_admin.build_plan instead of delegating.
      if (!admin) {
        res.status(503).json({ error: 'unavailable', message: '账号写操作服务暂未接入' });
        return;
      }
      const raw = jsonBody(req);
      const payload = isMapping(raw) ? raw : {};
      try {
        const account = admin.validateAccountName(payload['account']);
        const operation = String(payload['operation'] ?? '').trim();
        const rows = buildUserRows(server.name, db, null, server);
        const accountExists = rows.some(
          (row) => row['username'] === account && row['state'] === 'present',
        );
        const plan = admin.buildPlan(operation, {
          hostName: server.name,
          account,
          password: payload['password'] || null,
          accountExists,
          dataSupported: true,
          sudoOk: Boolean(server.sudo_password),
          withDocker: Boolean(payload['with_docker'] ?? true),
          withData: Boolean(payload['with_data'] ?? true),
        });
        planCache.put(plan);
        res.json({ ok: true, plan: admin.publicPlan(plan) });
      } catch (err) {
        if (err instanceof admin.AdminPlanError) {
          res.status(400).json({ error: 'invalid_request', message: String((err as Error).message) });
          return;
        }
        throw err;
      }
    }),
  );

  app.post(
    ENDPOINTS.api_users_execute,
    wrap((req: Request, res: Response) => {
      const settings = readUserSettings(db);
      const raw = jsonBody(req);
      const payload = isMapping(raw) ? raw : {};
      const planHash = String(payload['plan_hash'] ?? '').trim();
      const plan = planCache.get(planHash);
      if (!plan) {
        res.status(410).json({
          error: 'plan_expired',
          message: '执行计划已过期或不存在，请重新预览。',
        });
        return;
      }
      const gate = userWriteHost(settings, String(plan['host'] ?? ''), req);
      if (gate.error) {
        sendError(res, gate.error);
        return;
      }
      const server = gate.server as HostConfig;
      if (plan['host'] !== server.name) {
        res.status(400).json({ error: 'plan_mismatch', message: '执行计划与主机不匹配。' });
        return;
      }
      if (plan['blocked']) {
        res.status(400).json({
          error: 'plan_blocked',
          message: '这个执行计划已被判定为不可执行，请按提示处理后重新预览。',
          blocked_reasons: asArray(plan['blocked_reasons']),
        });
        return;
      }
      const confirmHost = String(payload['confirm_host'] ?? '').trim();
      const confirmAccount = String(payload['confirm_account'] ?? '').trim();
      if (confirmHost !== plan['host'] || confirmAccount !== plan['account']) {
        res.status(400).json({
          error: 'confirm_mismatch',
          message: '确认文本与主机名 / 账号名不一致，操作未执行。',
        });
        return;
      }
      const actor = sessionUsername(req) || 'admin';
      const started = new Date();
      if (!servers().some((item) => item.name === server.name)) {
        res.status(404).json({ error: 'unknown_host' });
        return;
      }
      const masked = asArray(plan['steps']).map((step) => {
        const source = asObj(step);
        const copy: Obj = {};
        for (const [key, value] of Object.entries(source)) {
          if (key !== 'stdin') copy[key] = value;
        }
        return copy;
      });
      const jobId = randomBytes(16).toString('hex');
      const job: Obj = {
        id: jobId,
        host: plan['host'],
        account: plan['account'],
        operation: plan['operation'],
        actor,
        state: 'running',
        ok: null,
        error: '',
        steps: masked,
        started_at: nowIsoUtc(started),
        finished_at: null,
        _ts: Date.now() / 1000,
      };
      const now = Date.now() / 1000;
      for (const [key, item] of executeJobs) {
        if (now - (Number(item['_ts']) || 0) > EXECUTE_JOB_TTL_SECONDS) executeJobs.delete(key);
      }
      executeJobs.set(jobId, job);
      // The plan is consumed on enqueue: a duplicate submit is rejected even
      // before the worker starts.
      planCache.drop(planHash);
      const runner = deps.runExecuteJob;
      if (runner) {
        void Promise.resolve(runner(job, plan)).catch(() => undefined);
      }
      res.json({ ok: true, job_id: jobId });
    }),
  );

  app.get(
    ENDPOINTS.api_users_execute_status,
    wrap((req: Request, res: Response) => {
      const jobId = asString(req.query['job_id']).trim();
      if (!jobId) {
        res.status(400).json({ error: 'missing_job_id' });
        return;
      }
      const job = executeJobs.get(jobId);
      let snapshot: Obj | null = null;
      if (job) {
        snapshot = {
          id: job['id'],
          host: job['host'],
          account: job['account'],
          operation: job['operation'],
          actor: job['actor'],
          state: job['state'],
          ok: job['ok'],
          error: job['error'],
          steps: asArray(job['steps']).map((step) => ({ ...asObj(step) })),
          started_at: job['started_at'],
          finished_at: job['finished_at'],
        };
      }
      if (snapshot === null) {
        res.status(404).json({ error: 'unknown_job', message: '任务不存在或已过期。' });
        return;
      }
      if (viewMode(req) === 'user' && snapshot['actor'] !== sessionUsername(req)) {
        res.status(403).json({ error: 'forbidden', message: '只能查看自己的操作任务。' });
        return;
      }
      res.json(snapshot);
    }),
  );

  app.get(
    ENDPOINTS.api_users_operations,
    wrap((req: Request, res: Response) => {
      const hostName = asString(req.query['host']).trim();
      if (hostName && !servers().some((server) => server.name === hostName)) {
        res.status(404).json({ error: 'unknown_host' });
        return;
      }
      const limit = Math.max(1, Math.min(asIntDefault(req.query['limit'], 20), 200));
      const items = listUserOperations(db, { hostName: hostName || null, limit });
      res.json({ items });
    }),
  );

  // -------------------------------------------------------------------------
  // Page
  // -------------------------------------------------------------------------

  app.get(ENDPOINTS.users_page, (_req: Request, res: Response) => {
    templating.renderPage(res, 'users.html', { active_page: 'users' });
  });
}
