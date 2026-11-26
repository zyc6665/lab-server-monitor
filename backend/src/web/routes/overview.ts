/**
 * Overview dashboard routes — the Express equivalent of
 * `servermanage/web/routes/overview.py` (P2 Task 10).
 *
 * Registers the six overview endpoints with the same URL rules, JSON field
 * names, status codes and template context keys as the Python oracle:
 *
 *   GET /                        dashboard page (`overview.html`)
 *   GET /api/overview            summary + per-host rows + capacity
 *   GET /api/overview/capacity   memory/disk/GPU-memory trend forecasts
 *   GET /api/overview/history    overview trend points (+ optional `previous`)
 *   GET /api/overview/alert-history  per-bucket alert counts
 *   GET /api/overview/report     plain-text fleet inspection report (attachment)
 *
 * The middleware chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers and therefore reads the
 * shared `app.locals.session` / `app.locals.webSettings` at request time.
 *
 * Timezone- and rounding-sensitive payloads are ported field-for-field from
 * `_core.py` / `capacity.py` so the JSON stays byte-compatible with Python.
 */
import type { Express, Request, Response } from 'express';

import type { AppConfig, HostAlertRules, HostConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';
import {
  fetchAllHostNetworkRates,
  fetchHostNetworkRates,
  getAllHostCheckResults,
  getAllHostSnapshots,
  type HostCheckResultRow,
  type HostSnapshot,
  type NetworkRate,
} from '../../storage/hosts';
import { getAllHostCheckHistory, getHostCheckHistory } from '../../storage/metrics-write';
import { getAllDiskHealth, type DiskHealthSnapshot } from '../../storage/disk';
import {
  countActiveAlertsByHost,
  fetchAlertHistory,
  listRecentAlertsGrouped,
  listSilences,
  type AlertRow,
  type SilenceRow,
} from '../../storage/alerts';
import {
  countRecentSamples,
  countRecentSamplesByHost,
  fetchAllHostUptimeStrips,
  fetchHostHistory,
  fetchHostSparklines,
  fetchHostUptimeStrip,
  fetchOverviewHistory,
  type OverviewPoint,
  type SparklineSeries,
  type UptimeStrip,
} from '../../storage/metrics-read';
import {
  getAllHostUserSnapshots,
  getAllUserBaselines,
  getAllUserUsageDeltas,
} from '../../storage/users';
import {
  buildHostDiagnostics,
  hostAlertDays,
  summarizeDiagnostics,
  type AlertDay,
  type DiagnosticRow,
  type DiagnosticsSummary,
} from '../host-diagnostics';
import { buildUserRows, gpuUsageFromMetrics, USAGE_DELTA_DAYS } from './users';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** Options accepted by {@link registerOverviewRoutes}. */
export interface OverviewRouteDeps {
  /** Open SQLite handle (storage + settings). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, app version, paths). */
  config: AppConfig;
  /** Optional pre-built templating bundle (defaults to one bound to `appVersion`). */
  templating?: Templating;
  /** `APP_VERSION` for the default templating bundle. */
  appVersion?: string;
}

// ---------------------------------------------------------------------------
// Small Python-compatibility helpers
// ---------------------------------------------------------------------------

/** `isinstance(value, dict)` for JSON-decoded values. */
function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `_as_float`: bool/non-number → `null`, else `Number(value)`. */
function asFloat(value: unknown): number | null {
  if (typeof value === 'boolean' || typeof value !== 'number') {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

/** `_percent_int`: bool → `null`; number → trunc; string → leading digits only. */
function percentInt(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits === '' ? null : Number(digits);
}

/** Python 3 `round()` — round half to even (banker's rounding). */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) {
    return floor + 1;
  }
  if (diff < 0.5) {
    return floor;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python `round(value, ndigits)` for a float. */
function pyRound(value: number, ndigits: number): number {
  const factor = 10 ** ndigits;
  return roundHalfEven(value * factor) / factor;
}

/** Python `int(value or 0)` for a snapshot field (truncates numeric strings). */
function intOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Timezone helpers (ports of `base.py` / `metrics-read.ts`)
// ---------------------------------------------------------------------------

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

interface ParsedInstant {
  epochMs: number;
  micro: number;
}

/** Parses a stored ISO-8601 timestamp (naive → UTC). Returns `null` when invalid. */
function parseTimestamp(raw: string): ParsedInstant | null {
  const text = raw.trim();
  const match = ISO_RE.exec(text);
  if (!match) {
    const fallback = Date.parse(text);
    if (Number.isNaN(fallback)) {
      return null;
    }
    return { epochMs: fallback, micro: (fallback % 1000) * 1000 };
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const micro = frac ? Number((frac + '000000').slice(0, 6)) : 0;
  let epochMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(micro / 1000),
  );
  if (offset && offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    const sign = offset[0] === '-' ? -1 : 1;
    epochMs -= sign * (hours * 60 + minutes) * 60000;
  }
  return { epochMs, micro };
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** UTC offset (ms) of `timeZone` at `epochMs` (whole minutes). */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  if (timeZone === 'UTC') {
    return 0;
  }
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      fields[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Formats an instant like Python `datetime.isoformat()` in `timeZone`. */
function formatIso(epochMs: number, micro: number, timeZone: string): string {
  const offsetMs = zoneOffsetMs(epochMs, timeZone);
  const wall = new Date(epochMs + offsetMs);
  const fraction = micro !== 0 ? `.${String(micro).padStart(6, '0')}` : '';
  const sign = offsetMs < 0 ? '-' : '+';
  const absMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const offHours = Math.floor(absMinutes / 60);
  const offMinutes = absMinutes % 60;
  return (
    `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
    `T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}` +
    `${fraction}${sign}${pad2(offHours)}:${pad2(offMinutes)}`
  );
}

/** `_to_local_iso`: convert a stored ISO string to `timeZone`, or pass it through. */
function toLocalIso(value: unknown, timeZone: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  const parsed = parseTimestamp(text);
  if (parsed === null) {
    return text;
  }
  return formatIso(parsed.epochMs, parsed.micro, timeZone);
}

/** Short timezone abbreviation, matching Python's `%Z` where practical. */
function tzAbbreviation(date: Date, timeZone: string): string {
  if (timeZone === 'UTC') {
    return 'UTC';
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'short',
    }).formatToParts(date);
    const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
    // Python's zoneinfo reports China Standard Time as "CST"; Node's ICU uses
    // "GMT+8" for the same zone. Map the common cases so reports read alike.
    const aliases: Record<string, string> = {
      'Asia/Shanghai': 'CST',
      'Asia/Chongqing': 'CST',
      'Asia/Hong_Kong': 'HKT',
      'Asia/Taipei': 'CST',
      'Asia/Tokyo': 'JST',
      'Asia/Seoul': 'KST',
    };
    if (aliases[timeZone] !== undefined) {
      return aliases[timeZone];
    }
    if (/^GMT[+-]/.test(name)) {
      return name;
    }
    return name || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `strftime('%Y-%m-%d %H:%M:%S %Z')` for an instant in `timeZone`. */
function formatDateTimeWithZone(date: Date, timeZone: string): string {
  const offsetMs = zoneOffsetMs(date.getTime(), timeZone);
  const wall = new Date(date.getTime() + offsetMs);
  return (
    `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())} ` +
    `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())} ` +
    tzAbbreviation(date, timeZone)
  );
}

/** `strftime('%Y%m%d-%H%M%S')` for an instant in `timeZone`. */
function formatCompactStamp(date: Date, timeZone: string): string {
  const offsetMs = zoneOffsetMs(date.getTime(), timeZone);
  const wall = new Date(date.getTime() + offsetMs);
  return (
    `${wall.getUTCFullYear()}${pad2(wall.getUTCMonth() + 1)}${pad2(wall.getUTCDate())}-` +
    `${pad2(wall.getUTCHours())}${pad2(wall.getUTCMinutes())}${pad2(wall.getUTCSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Effective settings (monitoring / alerts thresholds)
// ---------------------------------------------------------------------------

interface OverviewSettings {
  timezone: string;
  pollIntervalSeconds: number;
  thresholds: Obj;
}

function readOverviewSettings(db: SqliteDatabase): OverviewSettings {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const alerts = asObj(settings.alerts);
  const rawTz = monitoring.timezone;
  const timezone = typeof rawTz === 'string' && rawTz ? rawTz : 'Asia/Shanghai';
  const rawPoll = monitoring.poll_interval_seconds;
  const pollIntervalSeconds =
    typeof rawPoll === 'number' && Number.isFinite(rawPoll) ? Math.trunc(rawPoll) : 600;
  return {
    timezone,
    pollIntervalSeconds,
    thresholds: asObj(alerts.thresholds),
  };
}

// ---------------------------------------------------------------------------
// Metric helpers (ports of `_core.py` helpers)
// ---------------------------------------------------------------------------

const VIRTUAL_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'overlay',
  'squashfs',
  'nsfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'mqueue',
  'shm',
]);

function memoryPercent(metrics: Obj): number | null {
  const memory = asObj(metrics.memory);
  const total = asFloat(memory.total_mb);
  const used = asFloat(memory.used_mb);
  if (total === null || used === null || total <= 0) {
    return null;
  }
  return pyRound((used / total) * 100, 2);
}

function parsePercent(value: unknown): number | null {
  if (typeof value === 'boolean' || value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const match = String(value).match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function normalizeMounts(mounts: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of asArray(mounts)) {
    const text = String(entry).trim();
    if (text && !seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result.length ? result : ['/', '/data'];
}

function maxMountPercent(rows: Obj[], mounts: unknown): number | null {
  const wanted = normalizeMounts(mounts);
  const firstByMount = new Map<string, Obj>();
  for (const row of rows) {
    const mountpoint = String(row.mountpoint ?? '');
    const filesystem = String(row.filesystem ?? '');
    if (VIRTUAL_FILESYSTEMS.has(filesystem)) {
      continue;
    }
    if (!firstByMount.has(mountpoint)) {
      firstByMount.set(mountpoint, row);
    }
  }
  const values: number[] = [];
  for (const mount of wanted) {
    const row = firstByMount.get(mount);
    if (row === undefined) {
      continue;
    }
    const parsed = parsePercent(row.percent);
    if (parsed !== null) {
      values.push(parsed);
    }
  }
  return values.length ? Math.max(...values) : null;
}

function diskPercent(metrics: Obj, mounts: string[] | undefined): number | null {
  const rows = asArray(metrics.disk_usage).map((row) => asObj(row));
  if (mounts !== undefined) {
    return maxMountPercent(rows, mounts);
  }
  const values: number[] = [];
  for (const row of rows) {
    const filesystem = String(row.filesystem ?? '');
    if (VIRTUAL_FILESYSTEMS.has(filesystem)) {
      continue;
    }
    const parsed = percentInt(row.percent);
    if (parsed !== null) {
      values.push(parsed);
    }
  }
  return values.length ? Math.max(...values) : null;
}

function gpuMemoryPercent(metrics: Obj): number | null {
  let used = 0;
  let total = 0;
  let sawAny = false;
  for (const raw of asArray(metrics.gpu_summary)) {
    const row = asObj(raw);
    const totalMb = asFloat(row.memory_total_mb);
    const usedMb = asFloat(row.memory_used_mb);
    if (totalMb === null || usedMb === null) {
      continue;
    }
    sawAny = true;
    total += totalMb;
    used += usedMb;
  }
  if (!sawAny || total <= 0) {
    return null;
  }
  return pyRound((used / total) * 100, 2);
}

function hottestTemperature(metrics: Obj): number | null {
  const values: number[] = [];
  for (const raw of asArray(metrics.thermal_zones)) {
    const celsius = asFloat(asObj(raw).celsius);
    if (celsius !== null) {
      values.push(celsius);
    }
  }
  for (const raw of asArray(metrics.gpu_summary)) {
    const row = asObj(raw);
    if (row.temperature_c !== null && row.temperature_c !== undefined) {
      const temp = asFloat(row.temperature_c);
      if (temp !== null) {
        values.push(temp);
      }
    }
  }
  if (!values.length) {
    return null;
  }
  return pyRound(Math.max(...values), 1);
}

function gpuMemoryTotals(
  metrics: Obj,
): { used_mb: number; total_mb: number } | null {
  let used = 0;
  let total = 0;
  for (const raw of asArray(metrics.gpu_summary)) {
    const row = asObj(raw);
    const totalMb = asFloat(row.memory_total_mb);
    const usedMb = asFloat(row.memory_used_mb);
    total += totalMb ?? 0;
    used += usedMb ?? 0;
  }
  if (total <= 0) {
    return null;
  }
  return { used_mb: pyRound(used, 1), total_mb: pyRound(total, 1) };
}

function metricsPayload(metrics: Obj, diskMounts: string[] | undefined): Obj {
  const load = asObj(metrics.load_average);
  return {
    cpu_percent: asFloat(metrics.cpu_usage_percent),
    memory_percent: memoryPercent(metrics),
    disk_percent: diskPercent(metrics, diskMounts),
    gpu_memory_percent: gpuMemoryPercent(metrics),
    load_1: asFloat(load.load_1),
    cpu_cores: intOrZero(metrics.cpu_core_count),
    uptime: metrics.uptime ? String(metrics.uptime) : '',
  };
}

function loggedInCounts(metrics: Obj): { users: number; sessions: number } {
  const users = asArray(metrics.logged_in_users);
  let sessions = 0;
  const usernames = new Set<string>();
  for (const raw of users) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    sessions += 1;
    const username = (raw as Obj).username;
    if (username) {
      usernames.add(String(username));
    }
  }
  return { users: usernames.size, sessions };
}

function diskHealthSummary(health: DiskHealthSnapshot | undefined): Obj {
  const counts = { healthy: 0, warning: 0, critical: 0 };
  if (!health) {
    return { status: 'unknown', ...counts };
  }
  for (const raw of asArray(health.physical_drives)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const value = String((raw as Obj).health ?? '').toLowerCase();
    if (value in counts) {
      counts[value as keyof typeof counts] += 1;
    }
  }
  return { status: String(health.status ?? 'unknown') || 'unknown', ...counts };
}

function summarizeChecks(results: HostCheckResultRow[]): Obj {
  const total = results.length;
  let ok = 0;
  let failed = 0;
  for (const row of results) {
    const status = String(row.status);
    if (status === 'ok') {
      ok += 1;
    } else if (status === 'failed' || status === 'error') {
      failed += 1;
    }
  }
  return { total, ok, failed, unknown: total - ok - failed };
}

function isOnline(snapshot: HostSnapshot, pollIntervalSeconds: number, now: Date): boolean {
  if (!snapshot.success) {
    return false;
  }
  const parsed = parseTimestamp(snapshot.collected_at);
  if (parsed === null) {
    return false;
  }
  const maxAge = Math.max(Math.trunc(pollIntervalSeconds), 1) * 3;
  return (now.getTime() - parsed.epochMs) / 1000 <= maxAge;
}

function silenceApplies(silence: SilenceRow, hostName: string, group: string): boolean {
  if (silence.scope_type === 'all') {
    return true;
  }
  if (silence.scope_type === 'host') {
    return silence.scope === hostName;
  }
  if (silence.scope_type === 'group') {
    return silence.scope === (group || '未分组');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Host row builder (port of `_host_row`)
// ---------------------------------------------------------------------------

interface HostRowInput {
  name: string;
  host: string | undefined;
  snapshot: HostSnapshot | undefined;
  diskHealth: DiskHealthSnapshot | undefined;
  pollIntervalSeconds: number;
  now: Date;
  timezone: string;
  diskMounts: string[] | undefined;
  group: string;
  owner: string;
  location: string;
  tags: string[];
  silenced: boolean;
  silencedUntil: string | null;
  activeAlertCount: number;
  checks: Obj;
  spark: SparklineSeries | undefined;
  collectionUptime: Obj;
}

function hostRow(input: HostRowInput): Obj {
  const sparkData = {
    cpu: [...(input.spark?.cpu ?? [])],
    memory: [...(input.spark?.memory ?? [])],
  };
  const metrics = asObj(input.snapshot?.metrics);
  const containerCount = asArray(metrics.containers).length;
  const temperatureC = hottestTemperature(metrics);
  const gpuTotals = gpuMemoryTotals(metrics);
  const meta: Obj = {
    group: input.group || '未分组',
    owner: input.owner || '',
    location: input.location || '',
    tags: [...input.tags],
    silenced: Boolean(input.silenced),
    silenced_until: input.silencedUntil,
    active_alert_count: Math.trunc(input.activeAlertCount),
  };

  if (!input.snapshot) {
    return {
      name: input.name,
      host: input.host ?? null,
      online: false,
      collected_at: null,
      cpu_percent: null,
      memory_percent: null,
      disk_percent: null,
      gpu_memory_percent: null,
      logged_in_user_count: 0,
      logged_in_sessions: 0,
      disk_health: diskHealthSummary(input.diskHealth),
      checks: input.checks,
      spark: sparkData,
      container_count: containerCount,
      temperature_c: temperatureC,
      gpu_memory: gpuTotals,
      collection_uptime: input.collectionUptime,
      ...meta,
    };
  }

  const counts = loggedInCounts(metrics);
  return {
    name: input.name,
    host: input.host ?? null,
    online: isOnline(input.snapshot, input.pollIntervalSeconds, input.now),
    collected_at: toLocalIso(input.snapshot.collected_at, input.timezone),
    ...metricsPayload(metrics, input.diskMounts),
    logged_in_user_count: counts.users,
    logged_in_sessions: counts.sessions,
    disk_health: diskHealthSummary(input.diskHealth),
    checks: input.checks,
    spark: sparkData,
    container_count: containerCount,
    temperature_c: temperatureC,
    gpu_memory: gpuTotals,
    collection_uptime: input.collectionUptime,
    ...meta,
  };
}

// ---------------------------------------------------------------------------
// Capacity forecasts (port of `capacity.py`)
// ---------------------------------------------------------------------------

interface ForecastPoint {
  t: string;
  [key: string]: unknown;
}

function parseDay(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }
  const [y, m, d] = text.split('-').map(Number);
  const epoch = Date.UTC(y, m - 1, d);
  return Number.isNaN(epoch) ? null : epoch;
}

function linearSlope(points: Array<[number, number]>): number | null {
  const count = points.length;
  if (count < 2) {
    return null;
  }
  const xMean = points.reduce((sum, [x]) => sum + x, 0) / count;
  const yMean = points.reduce((sum, [, y]) => sum + y, 0) / count;
  const denominator = points.reduce((sum, [x]) => sum + (x - xMean) ** 2, 0);
  if (denominator === 0) {
    return null;
  }
  const numerator = points.reduce((sum, [x, y]) => sum + (x - xMean) * (y - yMean), 0);
  return numerator / denominator;
}

function forecastSeries(
  series: ForecastPoint[],
  key: string,
  threshold: number,
  horizonDays: number,
  minPoints = 5,
): Obj {
  const valid: Array<{ day: number; value: number }> = [];
  for (const item of series) {
    const raw = item[key];
    if (raw === null || raw === undefined) {
      continue;
    }
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    const day = parseDay(item.t);
    if (day === null) {
      continue;
    }
    valid.push({ day, value });
  }

  const result: Obj = {
    key,
    current: valid.length ? pyRound(valid[valid.length - 1].value, 2) : null,
    slope_per_day: null,
    days_to_threshold: null,
    status: 'insufficient_data',
    threshold: Number(threshold),
  };
  if (valid.length < minPoints) {
    return result;
  }

  const firstDay = valid[0].day;
  const points: Array<[number, number]> = valid.map((entry) => [
    Math.round((entry.day - firstDay) / 86400000),
    entry.value,
  ]);
  const slope = linearSlope(points);
  const current = valid[valid.length - 1].value;
  result.current = pyRound(current, 2);
  result.slope_per_day = slope === null ? null : pyRound(slope, 2);

  if (current >= threshold) {
    result.days_to_threshold = 0;
    result.status = 'critical';
    return result;
  }
  if (slope === null || slope <= 0.01) {
    result.status = 'stable';
    return result;
  }
  const daysToThreshold = (threshold - current) / slope;
  result.days_to_threshold = pyRound(Math.max(0, daysToThreshold), 2);
  if (daysToThreshold <= 7) {
    result.status = 'critical';
  } else if (daysToThreshold <= horizonDays) {
    result.status = 'warning';
  } else {
    result.status = 'stable';
  }
  return result;
}

const CAPACITY_METRICS: Array<[string, string, keyof HostAlertRules]> = [
  ['memory', '内存', 'memory_percent'],
  ['disk', '磁盘', 'disk_percent'],
  ['gpu_memory', 'GPU 显存', 'gpu_memory_percent'],
];

function thresholdFor(
  attr: keyof HostAlertRules,
  base: Obj,
  rules: HostAlertRules | undefined,
): number {
  const override = rules ? rules[attr] : undefined;
  if (override !== undefined && override !== null) {
    return Number(override);
  }
  const baseValue = base[attr];
  return typeof baseValue === 'number' ? baseValue : Number(baseValue ?? 0);
}

function buildCapacityForecasts(
  db: SqliteDatabase,
  servers: HostConfig[],
  timezone: string,
  now: Date,
  thresholds: Obj,
  days: number,
): Obj[] {
  if (days !== 7 && days !== 30 && days !== 90) {
    throw new Error('days must be 7, 30 or 90');
  }
  const rangeKey = `${days}d`;
  const hosts: Obj[] = [];
  for (const server of servers) {
    let series: ForecastPoint[] = [];
    try {
      series = fetchHostHistory(db, server.name, { rangeKey, tz: timezone, now }) as unknown as ForecastPoint[];
    } catch {
      series = [];
    }
    const metrics: Obj[] = [];
    for (const [key, label, attr] of CAPACITY_METRICS) {
      const forecast = forecastSeries(series, key, thresholdFor(attr, thresholds, server.alert_rules), days);
      forecast.label = label;
      metrics.push(forecast);
    }
    hosts.push({ host_name: server.name, host: server.host, metrics });
  }
  return hosts;
}

// ---------------------------------------------------------------------------
// Overview payload (port of `_build_overview`)
// ---------------------------------------------------------------------------

interface OverviewData {
  summary: Obj;
  meta: Obj;
  hosts: Obj[];
  capacity: Obj[];
}

export function buildOverview(db: SqliteDatabase, config: AppConfig): OverviewData {
  const now = new Date();
  const settings = readOverviewSettings(db);
  const timezone = settings.timezone;

  const snapshots = new Map<string, HostSnapshot>();
  for (const item of getAllHostSnapshots(db)) {
    snapshots.set(item.host_name, item);
  }
  const diskReports = new Map<string, DiskHealthSnapshot>();
  for (const item of getAllDiskHealth(db)) {
    diskReports.set(item.host_name, item);
  }

  const addresses = new Map<string, string>();
  const serversByName = new Map<string, HostConfig>();
  const mountsByHost = new Map<string, string[]>();
  for (const server of config.servers) {
    addresses.set(server.name, server.host);
    serversByName.set(server.name, server);
    mountsByHost.set(server.name, server.disk_mounts);
  }

  const activeSilences = listSilences(db, { activeOnly: true, now });
  const alertCounts = countActiveAlertsByHost(db);
  const activeAlertTotal = Object.values(alertCounts).reduce((sum, value) => sum + value, 0);

  let sparklines: Record<string, SparklineSeries> = {};
  try {
    sparklines = fetchHostSparklines(db, { now });
  } catch {
    sparklines = {};
  }

  const groups: string[] = [];
  for (const server of config.servers) {
    const groupName = server.group || '未分组';
    if (!groups.includes(groupName)) {
      groups.push(groupName);
    }
  }

  let sampleCounts: Record<string, number> = {};
  try {
    sampleCounts = countRecentSamplesByHost(db, { hours: 24, now });
  } catch {
    sampleCounts = {};
  }
  const expectedPolls = Math.max(
    1,
    Math.trunc((24 * 3600) / Math.max(60, Math.trunc(settings.pollIntervalSeconds || 600))),
  );

  let checkResults: Record<string, HostCheckResultRow[]> = {};
  try {
    checkResults = getAllHostCheckResults(db);
  } catch {
    checkResults = {};
  }

  const names: string[] = [];
  for (const server of config.servers) {
    if (!names.includes(server.name)) {
      names.push(server.name);
    }
  }
  for (const hostName of snapshots.keys()) {
    if (!names.includes(hostName)) {
      names.push(hostName);
    }
  }

  const hosts: Obj[] = [];
  let silencedCount = 0;
  for (const hostName of [...names].sort()) {
    const server = serversByName.get(hostName);
    const group = (server ? server.group : undefined) || '未分组';
    const matched = activeSilences.filter((silence) => silenceApplies(silence, hostName, group));
    let silencedUntil: string | null = null;
    if (matched.length) {
      silencedCount += 1;
      const ends = matched
        .map((silence) => silence.ends_at)
        .filter((value): value is string => Boolean(value));
      if (ends.length) {
        silencedUntil = toLocalIso(ends.reduce((a, b) => (a > b ? a : b)), timezone);
      }
    }
    hosts.push(
      hostRow({
        name: hostName,
        host: addresses.get(hostName),
        snapshot: snapshots.get(hostName),
        diskHealth: diskReports.get(hostName),
        pollIntervalSeconds: settings.pollIntervalSeconds,
        now,
        timezone,
        diskMounts: mountsByHost.get(hostName),
        group,
        owner: server ? server.owner : '',
        location: server ? server.location : '',
        tags: server ? server.tags : [],
        silenced: matched.length > 0,
        silencedUntil,
        activeAlertCount: alertCounts[hostName] ?? 0,
        checks: summarizeChecks(checkResults[hostName] ?? []),
        spark: sparklines[hostName],
        collectionUptime: {
          samples: sampleCounts[hostName] ?? 0,
          expected: expectedPolls,
        },
      }),
    );
  }

  const online = hosts.reduce((sum, host) => sum + (host.online === true ? 1 : 0), 0);
  const tagSet = new Set<string>();
  for (const server of config.servers) {
    for (const tag of server.tags ?? []) {
      const trimmed = String(tag).trim();
      if (trimmed) {
        tagSet.add(trimmed);
      }
    }
  }
  const tags = [...tagSet].sort();

  return {
    summary: {
      online,
      offline: hosts.length - online,
      active_alerts: activeAlertTotal,
    },
    meta: {
      groups,
      silenced_count: silencedCount,
      has_groups: config.servers.some((server) => server.group && server.group !== '未分组'),
      tags,
      has_tags: config.servers.some((server) => (server.tags ?? []).length > 0),
    },
    hosts,
    capacity: buildCapacityForecasts(
      db,
      config.servers,
      timezone,
      now,
      settings.thresholds,
      30,
    ),
  };
}

// ---------------------------------------------------------------------------
// Fleet inspection report (port of `_build_fleet_report` / `_build_host_report`)
// ---------------------------------------------------------------------------

interface CollectionUptime {
  samples: number;
  expected: number;
}

interface HostDetail {
  name: string;
  host: string | undefined;
  collected_at: string | null;
  success: boolean | null;
  group: string;
  owner: string;
  location: string;
  tags: string[];
  metrics: Obj;
  errors: Obj[];
  disk: Obj | null;
  alerts: Obj[];
  checks: HostCheckResultRow[];
  check_history: Record<string, string[]>;
  network: NetworkRate;
  users: Obj[];
  collection_uptime: CollectionUptime;
  uptime_strip: UptimeStrip;
  diagnostics: DiagnosticRow[];
  diagnostics_summary: DiagnosticsSummary;
  alert_days: AlertDay[];
}

/** `_report_number`: `None`/`""` → null; otherwise float of the trimmed value. */
function reportNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const text = String(value).trim().replace(/%$/, '');
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Python `str.format` `{}` for an arbitrary JSON value (close approximation). */
function fmt(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

function fmtOr(value: unknown, fallback = '—'): string {
  if (value === null || value === undefined || value === '' || value === false) {
    return fallback;
  }
  return String(value);
}

function fmtFixed(value: number, digits: number): string {
  return formatFixedNumber(value, digits);
}

/** Python `f"{value:.{digits}f}"` (banker's rounding). */
function formatFixedNumber(value: number, digits: number): string {
  const negative = value < 0;
  const factor = 10 ** digits;
  const rounded = roundHalfEven(Math.abs(value) * factor);
  let text = String(rounded);
  if (digits > 0) {
    if (text.length <= digits) {
      text = '0'.repeat(digits - text.length + 1) + text;
    }
    text = `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
  }
  return negative ? `-${text}` : text;
}

export function buildHostReport(detail: HostDetail, generatedAt: Date, timezone: string, includeHeading: boolean): string {
  const metrics = detail.metrics;
  const lines: string[] = [];
  if (includeHeading) {
    lines.push('服务器轮询监测 · 主机诊断报告');
    lines.push('='.repeat(46));
    lines.push(`生成时间：${formatDateTimeWithZone(generatedAt, timezone)}`);
  }
  lines.push(`主机名称：${detail.name || '—'}`);
  lines.push(`主机地址：${detail.host || '—'}`);
  lines.push(`分组：${detail.group || '未分组'}`);
  lines.push(`负责人：${detail.owner || '—'}`);
  lines.push(`位置：${detail.location || '—'}`);
  lines.push(`标签：${detail.tags.length ? detail.tags.map((tag) => String(tag)).join(', ') : '—'}`);
  const success = detail.success;
  const statusText = success === true ? '成功' : success === false ? '失败' : '等待首次采集';
  lines.push(`采集状态：${statusText}`);
  lines.push(`采集时间：${detail.collected_at || '—'}`);
  lines.push('');
  lines.push('[系统概览]');
  lines.push(`  操作系统：${fmtOr(metrics.os_pretty_name)}`);
  lines.push(`  内核版本：${fmtOr(metrics.kernel_version)}`);
  lines.push(`  主机名：${fmtOr(metrics.hostname)}`);
  lines.push(`  运行时长：${fmtOr(metrics.uptime)}`);
  lines.push(`  CPU 核心：${metrics.cpu_core_count !== null && metrics.cpu_core_count !== undefined ? fmt(metrics.cpu_core_count) : '—'}`);
  const cpu = reportNumber(metrics.cpu_usage_percent);
  lines.push(`  CPU 使用率：${cpu !== null ? `${fmtFixed(cpu, 1)}%` : '—'}`);
  const memory = asObj(metrics.memory);
  const totalMb = reportNumber(memory.total_mb);
  const usedMb = reportNumber(memory.used_mb);
  let memPercent: number | null = null;
  if (totalMb !== null && totalMb !== 0 && usedMb !== null) {
    memPercent = (usedMb / totalMb) * 100;
    lines.push(`  内存：${fmtFixed(usedMb, 0)} / ${fmtFixed(totalMb, 0)} MB（${fmtFixed(memPercent, 1)}%）`);
  } else {
    lines.push('  内存：—');
  }
  const load = asObj(metrics.load_average);
  if (Object.keys(load).length) {
    lines.push(`  负载（1/5/15）：${fmtWithDefault(load, 'load_1')} / ${fmtWithDefault(load, 'load_5')} / ${fmtWithDefault(load, 'load_15')}`);
  } else {
    lines.push('  负载（1/5/15）：—');
  }
  lines.push('');
  lines.push('[磁盘挂载]');
  const mounts: Obj[] = [];
  for (const raw of asArray(metrics.disk_usage)) {
    const row = asObj(raw);
    const filesystem = String(row.filesystem ?? '');
    const mountpoint = String(row.mountpoint ?? '');
    if (VIRTUAL_FILESYSTEMS.has(filesystem)) {
      continue;
    }
    if (filesystem.startsWith('/dev/loop') || mountpoint.startsWith('/snap')) {
      continue;
    }
    mounts.push(row);
  }
  if (mounts.length) {
    for (const row of mounts) {
      lines.push(
        `  ${fmtOr(row.mountpoint)}  ${fmtOr(row.filesystem)}  ${fmtOr(row.used)}/${fmtOr(row.size)}（${fmtOr(row.percent)}）`,
      );
    }
  } else {
    lines.push('  （无）');
  }
  lines.push('');
  lines.push('[GPU]');
  const gpus = asArray(metrics.gpu_summary).map((raw) => asObj(raw));
  if (gpus.length) {
    for (const gpu of gpus) {
      lines.push(
        `  GPU${fmtWithDefault(gpu, 'index')} ${fmtOr(gpu.name)}：利用率 ${fmtWithDefault(gpu, 'utilization_percent')}%，显存 ${fmtWithDefault(gpu, 'memory_used_mb')}/${fmtWithDefault(gpu, 'memory_total_mb')} MB，温度 ${fmtWithDefault(gpu, 'temperature_c')}°C`,
      );
    }
  } else {
    lines.push('  （无 GPU 数据）');
  }
  lines.push('');
  lines.push('[当前登录用户]');
  const users = asArray(metrics.logged_in_users).map((raw) => asObj(raw));
  if (users.length) {
    for (const user of users) {
      lines.push(
        `  ${fmtOr(user.username)}  终端 ${fmtOr(user.terminal)}  来源 ${fmtOr(user.remote_host)}  登录 ${fmtOr(user.login_at)}`,
      );
    }
  } else {
    lines.push('  （无登录会话）');
  }
  lines.push('');
  lines.push('[CPU 占用前 3 进程]');
  const processes = asArray(metrics.top_cpu_processes).map((raw) => asObj(raw));
  if (processes.length) {
    for (const proc of processes.slice(0, 3)) {
      let command = String(proc.command ?? '').split(/\s+/).filter(Boolean).join(' ');
      if (command.length > 120) {
        command = `${command.slice(0, 117)}...`;
      }
      lines.push(
        `  PID ${fmtWithDefault(proc, 'pid')}  ${fmtOr(proc.username)}  CPU ${fmtWithDefault(proc, 'cpu_percent')}%  内存 ${fmtWithDefault(proc, 'mem_percent')}%  ${command || '—'}`,
      );
    }
  } else {
    lines.push('  （无进程数据）');
  }
  lines.push('');
  lines.push('[磁盘阵列健康]');
  const disk = detail.disk;
  if (disk) {
    lines.push(`  状态：${fmtOr(disk.status)}`);
    lines.push(`  消息：${fmtOr(disk.message)}`);
    lines.push(`  采集时间：${fmtOr(disk.collected_at)}`);
  } else {
    lines.push('  （暂无磁盘阵列数据）');
  }
  lines.push('');
  lines.push('[服务可用性]');
  const checks = detail.checks;
  if (checks.length) {
    for (const check of checks) {
      const checkName = fmtOr(check.check_name);
      const checkType = fmtOr(check.check_type);
      const checkTarget = fmtOr(check.target);
      const checkStatus = fmtOr(check.status);
      const checkMessage = fmtOr(check.message);
      const latency = reportNumber(check.latency_ms);
      const latencyText = latency !== null ? ` ${fmtFixed(latency, 0)}ms` : '';
      lines.push(`  ${checkName}（${checkType} ${checkTarget}）：${checkStatus} ${checkMessage}${latencyText}`);
    }
  } else {
    lines.push('  未配置服务检查');
  }
  lines.push('');
  lines.push('[最近采集异常]');
  if (detail.errors.length) {
    for (const err of detail.errors) {
      lines.push(`  - ${fmtOr(err.stage, 'unknown')}：${fmtOr(err.message)}`);
    }
  } else {
    lines.push('  （无）');
  }
  lines.push('');
  lines.push('[最近告警]');
  if (detail.alerts.length) {
    for (const alert of detail.alerts.slice(0, 5)) {
      lines.push(`  ${fmtOr(alert.created_at)} [${fmtOr(alert.severity)}] ${fmtOr(alert.title)}（${fmtOr(alert.status)}）`);
    }
  } else {
    lines.push('  （无）');
  }
  lines.push('');
  lines.push('[重点关注]');
  const attention: string[] = [];
  if (success === false) {
    attention.push('最近一次采集失败，请检查 SSH 连接和凭据。');
  } else if (success === null) {
    attention.push('尚未完成首次采集，请先测试连接并立即采集。');
  }
  for (const err of detail.errors) {
    attention.push(`采集异常：${fmtOr(err.stage, 'unknown')} - ${fmtOr(err.message, '未知错误')}`);
  }
  if (cpu !== null && cpu >= 90) {
    attention.push(`CPU 使用率达到 ${fmtFixed(cpu, 1)}%，请检查高负载进程。`);
  }
  if (memPercent !== null && memPercent >= 90) {
    attention.push(`内存使用率达到 ${fmtFixed(memPercent, 1)}%，请检查内存占用。`);
  }
  for (const row of mounts) {
    const percent = reportNumber(row.percent);
    if (percent !== null && percent >= 90) {
      attention.push(`挂载点 ${fmtOr(row.mountpoint)} 使用率达到 ${fmtFixed(percent, 0)}%。`);
    }
  }
  const diskStatus = String(disk?.status ?? '').toLowerCase();
  if (diskStatus && diskStatus !== 'ok' && diskStatus !== 'healthy') {
    attention.push(`磁盘阵列状态为 ${fmtOr(disk?.status)}：${fmtOr(disk?.message, '请检查存储控制器')}。`);
  }
  if (!attention.length) {
    attention.push('未发现明显异常。');
  }
  for (const item of attention) {
    lines.push(`  - ${item}`);
  }
  lines.push('');
  lines.push('（报告由服务器轮询监测工具自动生成）');
  return `${lines.join('\n')}\n`;
}

/** Python dict `.get(key, "—")`: value when present, else the default. */
function fmtWithDefault(row: Obj, key: string): string {
  if (Object.prototype.hasOwnProperty.call(row, key)) {
    return fmt(row[key]);
  }
  return '—';
}

/** Fleet-wide reads that let {@link buildHostDetail} skip per-host queries. */
export interface HostDetailPrecomputed {
  checkHistory?: Record<string, string[]>;
  network?: NetworkRate;
  users?: Obj[];
  sampleCount?: number;
  uptimeStrip?: UptimeStrip;
}

/**
 * `_build_host_detail` — build the `/api/host/<name>` payload. A host that is
 * configured but not yet collected still returns a payload with empty metrics;
 * callers are responsible for rejecting names that are neither configured nor
 * polled.
 */
export function buildHostDetail(
  name: string,
  config: AppConfig,
  db: SqliteDatabase,
  snapshot: HostSnapshot | undefined,
  disk: DiskHealthSnapshot | undefined,
  alerts: Obj[],
  checks: HostCheckResultRow[],
  timezone: string,
  pollIntervalSeconds: number,
  precomputed: HostDetailPrecomputed = {},
  now: Date = new Date(),
): HostDetail {
  const server = config.servers.find((entry) => entry.name === name);
  const localizedDisk: Obj | null = disk
    ? ({
        ...disk,
        collected_at: toLocalIso(disk.collected_at, timezone),
      } as unknown as Obj)
    : null;
  const checkHistory = precomputed.checkHistory ?? getHostCheckHistory(db, name);
  const network = precomputed.network ?? fetchHostNetworkRates(db, name);
  const users = precomputed.users ?? buildUserRows(name, db, timezone, server);
  const pollSeconds = Math.max(60, Math.trunc(pollIntervalSeconds));
  const samples = precomputed.sampleCount ?? countRecentSamples(db, name, { hours: 24 });
  const uptimeStrip =
    precomputed.uptimeStrip ?? fetchHostUptimeStrip(db, name, { hours: 24, bucketMinutes: 15 });

  const detail: HostDetail = {
    name,
    host: server ? server.host : undefined,
    collected_at: snapshot ? toLocalIso(snapshot.collected_at, timezone) : null,
    success: snapshot ? snapshot.success : null,
    group: (server ? server.group : undefined) || '未分组',
    owner: server ? server.owner : '',
    location: server ? server.location : '',
    tags: server ? server.tags : [],
    metrics: snapshot ? asObj(snapshot.metrics) : {},
    errors: snapshot ? asArray(snapshot.errors).map((raw) => asObj(raw)) : [],
    disk: localizedDisk,
    alerts,
    checks,
    check_history: checkHistory,
    network,
    users,
    collection_uptime: {
      samples,
      expected: Math.max(1, Math.trunc((24 * 3600) / pollSeconds)),
    },
    uptime_strip: uptimeStrip,
    diagnostics: [],
    diagnostics_summary: { crit: 0, warn: 0, ok: 0, attention: 0 },
    alert_days: [],
  };
  detail.diagnostics = buildHostDiagnostics(detail as unknown as Obj, {
    now,
    pollIntervalSeconds,
  });
  detail.diagnostics_summary = summarizeDiagnostics(detail.diagnostics);
  detail.alert_days = hostAlertDays(alerts, timezone, { now });
  return detail;
}

function buildFleetReport(
  db: SqliteDatabase,
  config: AppConfig,
  settings: OverviewSettings,
  generatedAt: Date,
): string {
  const timezone = settings.timezone;
  const snapshots = new Map<string, HostSnapshot>();
  for (const item of getAllHostSnapshots(db)) {
    snapshots.set(item.host_name, item);
  }
  const disks = new Map<string, DiskHealthSnapshot>();
  for (const item of getAllDiskHealth(db)) {
    disks.set(item.host_name, item);
  }
  const alertsGrouped = listRecentAlertsGrouped(db, { perHost: 20 });
  const checksGrouped = getAllHostCheckResults(db);
  // v0.1.233 parity: fetch every per-host input in one batch instead of
  // ~10 queries per host inside `buildHostDetail`.
  const checkHistoryGrouped = getAllHostCheckHistory(db);
  const networkGrouped = fetchAllHostNetworkRates(db);
  const sampleCounts = countRecentSamplesByHost(db, { hours: 24 });
  const uptimeStrips = fetchAllHostUptimeStrips(db, { hours: 24, bucketMinutes: 15 });
  const userSnapshots = getAllHostUserSnapshots(db);
  const userBaselines = getAllUserBaselines(db);
  const userDeltas = getAllUserUsageDeltas(db, { days: USAGE_DELTA_DAYS });

  const details: HostDetail[] = [];
  for (const server of config.servers) {
    const localizedAlerts = (alertsGrouped[server.name] ?? []).map((alert: AlertRow) => ({
      ...alert,
      created_at: toLocalIso(alert.created_at, timezone),
    }));
    const snapshot = snapshots.get(server.name);
    const users = buildUserRows(server.name, db, timezone, server, {
      snapshots: userSnapshots[server.name] ?? [],
      baselines: userBaselines[server.name] ?? [],
      deltas: userDeltas[server.name] ?? {},
      gpuUsage: gpuUsageFromMetrics(asObj(snapshot?.metrics)),
    });
    details.push(
      buildHostDetail(
        server.name,
        config,
        db,
        snapshot,
        disks.get(server.name),
        localizedAlerts,
        checksGrouped[server.name] ?? [],
        timezone,
        settings.pollIntervalSeconds,
        {
          checkHistory: checkHistoryGrouped[server.name] ?? {},
          network: networkGrouped[server.name],
          users,
          sampleCount: sampleCounts[server.name] ?? 0,
          uptimeStrip: uptimeStrips[server.name],
        },
      ),
    );
  }

  const total = details.length;
  const succeeded = details.filter((detail) => detail.success === true).length;
  const failed = details.filter((detail) => detail.success === false).length;
  const waiting = total - succeeded - failed;
  const activeAlerts = details.reduce(
    (sum, detail) => sum + detail.alerts.filter((alert) => alert.status === 'active').length,
    0,
  );
  const diskAttention = details.filter((detail) => {
    const status = String(detail.disk?.status ?? '').toLowerCase();
    return status !== '' && status !== 'ok' && status !== 'healthy';
  }).length;

  const lines: string[] = [
    '服务器轮询监测 · 全网巡检报告',
    '='.repeat(50),
    `生成时间：${formatDateTimeWithZone(generatedAt, timezone)}`,
    `主机总数：${total}`,
    `采集成功：${succeeded}`,
    `采集失败：${failed}`,
    `等待首次采集：${waiting}`,
    `活动告警：${activeAlerts}`,
    `磁盘阵列异常：${diskAttention}`,
    '',
    '[主机摘要]',
  ];
  if (!details.length) {
    lines.push('  （未配置主机）');
  }
  for (const detail of details) {
    const metrics = detail.metrics;
    const cpu = reportNumber(metrics.cpu_usage_percent);
    const memory = asObj(metrics.memory);
    const totalMb = reportNumber(memory.total_mb);
    const usedMb = reportNumber(memory.used_mb);
    const memPercent = totalMb !== null && totalMb !== 0 && usedMb !== null
      ? (usedMb / totalMb) * 100
      : null;
    let rootPercent: number | null = null;
    for (const raw of asArray(metrics.disk_usage)) {
      const row = asObj(raw);
      if (String(row.mountpoint ?? '') === '/') {
        rootPercent = reportNumber(row.percent);
        break;
      }
    }
    const statusText = detail.success === true ? '成功' : detail.success === false ? '失败' : '等待采集';
    const hostAlerts = detail.alerts.filter((alert) => alert.status === 'active').length;
    lines.push(
      `  ${detail.name || '—'} | ${detail.host || '—'} | ${detail.group || '未分组'} | 状态 ${statusText} | CPU ${cpu !== null ? `${fmtFixed(cpu, 1)}%` : '—'} | 内存 ${memPercent !== null ? `${fmtFixed(memPercent, 1)}%` : '—'} | 根目录 ${rootPercent !== null ? `${fmtFixed(rootPercent, 1)}%` : '—'} | 活动告警 ${hostAlerts}`,
    );
  }
  lines.push('');
  details.forEach((detail, index) => {
    lines.push('-'.repeat(60));
    lines.push(`【主机 ${index + 1}/${total}】${detail.name || '—'}`);
    lines.push('-'.repeat(60));
    lines.push(buildHostReport(detail, generatedAt, timezone, false).replace(/\s+$/, ''));
    lines.push('');
  });
  lines.push('（报告由服务器轮询监测工具自动生成）');
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Query-string helpers
// ---------------------------------------------------------------------------

function firstQuery(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.length ? String(value[0]) : undefined;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value);
}

/** Python `int(...)` for the `days` query parameter; `null` when it would raise. */
function parseDays(raw: string): number | null {
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

/**
 * Registers the overview page and JSON endpoints on `app`.
 *
 * @param app  Express app (middleware gate chain already installed).
 * @param deps db + resolved config + optional pre-built templating bundle.
 */
export function registerOverviewRoutes(app: Express, deps: OverviewRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });

  app.get(ENDPOINTS.overview_page, (req: Request, res: Response) => {
    const mode = (req.app.locals.webSettings as { mode?: string } | undefined)?.mode;
    if (mode === 'user') {
      res.redirect('/my');
      return;
    }
    const data = buildOverview(db, config);
    templating.renderPage(res, 'overview.html', {
      active_page: 'overview',
      summary: data.summary,
      meta: data.meta,
      hosts: data.hosts,
    });
  });

  app.get(ENDPOINTS.api_overview, (_req: Request, res: Response) => {
    res.json(buildOverview(db, config));
  });

  app.get(ENDPOINTS.api_overview_capacity, (req: Request, res: Response) => {
    const raw = firstQuery(req.query.days) ?? '30';
    const days = parseDays(raw);
    if (days === null || (days !== 7 && days !== 30 && days !== 90)) {
      res.status(400).json({ error: 'invalid_days' });
      return;
    }
    const settings = readOverviewSettings(db);
    const thresholds = settings.thresholds;
    const hosts = buildCapacityForecasts(
      db,
      config.servers,
      settings.timezone,
      new Date(),
      thresholds,
      days,
    );
    res.json({
      days,
      thresholds: {
        memory: thresholds.memory_percent,
        disk: thresholds.disk_percent,
        gpu_memory: thresholds.gpu_memory_percent,
      },
      hosts,
    });
  });

  app.get(ENDPOINTS.api_overview_history, (req: Request, res: Response) => {
    const rangeKey = firstQuery(req.query.range) ?? '24h';
    if (!['24h', '7d', '30d', '90d'].includes(rangeKey)) {
      res.status(400).json({ error: 'invalid_range' });
      return;
    }
    const settings = readOverviewSettings(db);
    const host = (firstQuery(req.query.host) ?? '').trim() || null;
    const points: OverviewPoint[] = fetchOverviewHistory(db, {
      rangeKey,
      tz: settings.timezone,
      host,
    });
    const payload: Obj = { range: rangeKey, points };
    const compare = firstQuery(req.query.compare);
    if (compare !== undefined && ['1', 'true', 'yes'].includes(compare)) {
      if (rangeKey === '24h') {
        payload.previous = [];
      } else {
        const offsets: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90 };
        payload.previous = fetchOverviewHistory(db, {
          rangeKey,
          tz: settings.timezone,
          offsetDays: offsets[rangeKey],
        });
      }
    }
    res.json(payload);
  });

  app.get(ENDPOINTS.api_overview_alert_history, (req: Request, res: Response) => {
    const rangeKey = firstQuery(req.query.range) ?? '24h';
    if (!['24h', '7d', '30d'].includes(rangeKey)) {
      res.status(400).json({ error: 'invalid_range' });
      return;
    }
    const settings = readOverviewSettings(db);
    const buckets = fetchAlertHistory(db, {
      rangeKey: rangeKey as '24h' | '7d' | '30d',
      tz: settings.timezone,
    });
    res.json({ range: rangeKey, buckets });
  });

  app.get(ENDPOINTS.api_overview_report, (_req: Request, res: Response) => {
    const settings = readOverviewSettings(db);
    const generatedAt = new Date();
    const text = buildFleetReport(db, config, settings, generatedAt);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fleet-report-${formatCompactStamp(generatedAt, settings.timezone)}.txt"`,
    );
    res.status(200).send(`\ufeff${text}`);
  });
}

// ---------------------------------------------------------------------------
// Reusable builder factory (for the composition root / hosts route)
// ---------------------------------------------------------------------------

/** Builder callbacks shaped like the optional `HostsRouteDeps` overrides. */
export interface OverviewBuilders {
  buildOverview: () => Obj;
  buildHostDetail: (name: string) => Obj | null;
  buildHostReport: (detail: Obj, generatedAt: Date) => string;
}

/**
 * Binds the overview builders to a `db` + `config` pair so another route module
 * (notably `hosts.ts`) can inject them instead of using its fallback stubs.
 *
 * Logic is identical to the private builders used by the overview routes; only
 * the arguments are closed over.
 */
export function createOverviewBuilders(db: SqliteDatabase, config: AppConfig): OverviewBuilders {
  return {
    buildOverview: () => buildOverview(db, config) as unknown as Obj,
    buildHostDetail: (name: string): Obj | null => {
      const server = config.servers.find((entry) => entry.name === name);
      if (!server) {
        return null;
      }
      const settings = readOverviewSettings(db);
      const timezone = settings.timezone;
      const snapshot = getAllHostSnapshots(db).find((item) => item.host_name === name);
      const disk = getAllDiskHealth(db).find((item) => item.host_name === name);
      const grouped = listRecentAlertsGrouped(db, { perHost: 20 });
      const localizedAlerts = (grouped[name] ?? []).map((alert: AlertRow) => ({
        ...alert,
        created_at: toLocalIso(alert.created_at, timezone),
      }));
      const checks = getAllHostCheckResults(db)[name] ?? [];
      return buildHostDetail(
        name,
        config,
        db,
        snapshot,
        disk,
        localizedAlerts,
        checks,
        timezone,
        settings.pollIntervalSeconds,
      ) as unknown as Obj;
    },
    buildHostReport: (detail: Obj, generatedAt: Date): string => {
      const settings = readOverviewSettings(db);
      return buildHostReport(detail as unknown as HostDetail, generatedAt, settings.timezone, true);
    },
  };
}
