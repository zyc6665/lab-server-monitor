/**
 * Disk-health page — the Express equivalent of
 * `servermanage/web/routes/disk_health.py` (P2 Task 16).
 *
 *   GET /disk-health   aggregated per-host physical-drive health (`disk_health.html`)
 *
 * The page aggregates `storage.get_all_disk_health` with `config.servers` exactly
 * like the Python oracle: hosts are the de-duplicated union of configured server
 * names (in config order) followed by any extra hosts that only appear in the
 * health snapshots; drives are flattened per host and sorted hot-first; totals /
 * group statistics / temperature statistics are computed from the same rows.
 *
 * Helper semantics mirrored from `_core.py`:
 *   - `_disk_health_summary` — per-drive healthy/warning/critical counts + status
 *   - `_anchor`               — anchor slug (same as the `anchor` template filter)
 *   - `_drive_sort_key`       — hottest drive first, then slot
 *   - `_to_local_iso`         — ISO timestamp in the configured display timezone
 */
import type { Express } from 'express';

import type { AppConfig, HostConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import { getAllDiskHealth, type DiskHealthSnapshot } from '../../storage/disk';
import { anchor as anchorSlug, createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** Severity ordering used to sort host rows (mirrors `_SEVERITY_RANK`). */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  critical: 0,
  warning: 1,
  ok: 2,
  unknown: 3,
  error: 4,
  no_storcli: 5,
};

/** Counts returned by {@link diskHealthSummary}. */
export interface DiskHealthCounts {
  status: string;
  healthy: number;
  warning: number;
  critical: number;
}

/** Aggregate shape returned by {@link buildDiskHealthContext}. */
export interface DiskHealthContext {
  hosts: Obj[];
  drives: Obj[];
  totals: { healthy: number; warning: number; critical: number; drives: number };
  temperature_stats: {
    max: number | null;
    average: number | null;
    hot: number;
    samples: number;
  };
  group_stats: Record<
    string,
    { hosts: number; healthy: number; warning: number; critical: number; max_temp: number | null }
  >;
  has_groups: boolean;
}

/** Narrow an unknown value to a plain object. */
function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

/** True for a finite JS number. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Python `round(value, digits)` for the single-decimal temperature average. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** `_disk_health_summary`: per-drive healthy/warning/critical counts + status. */
export function diskHealthSummary(health: DiskHealthSnapshot | undefined): DiskHealthCounts {
  const counts = { healthy: 0, warning: 0, critical: 0 };
  if (!health) {
    return { status: 'unknown', ...counts };
  }
  for (const raw of health.physical_drives ?? []) {
    const drive = asObj(raw);
    const value = String(drive.health ?? '').toLowerCase();
    if (value === 'healthy') {
      counts.healthy += 1;
    } else if (value === 'warning') {
      counts.warning += 1;
    } else if (value === 'critical') {
      counts.critical += 1;
    }
  }
  return { status: String(health.status || 'unknown'), ...counts };
}

/**
 * `_drive_sort_key`: hottest drive first, then ascending slot.
 *
 * Missing/non-numeric temperatures sort last (`-inf` → largest key); a
 * non-integer slot sorts after integer slots.
 */
export function driveSortKey(drive: Obj): [number, number] {
  const temp = drive.temperature_c;
  const hot = isNumber(temp) ? temp : Number.NEGATIVE_INFINITY;
  const slot = drive.slot;
  const slotKey = isNumber(slot) ? slot : 1_000_000;
  return [-hot, slotKey];
}

/** Left-pads a non-negative integer to two digits. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `_to_local_iso`: render an instant as an offset-qualified ISO string in
 * `timeZone`. Unparseable values pass through unchanged. (Same algorithm as
 * `backend/src/web/routes/alerts.ts:toLocalIso`.)
 */
export function toLocalIso(value: unknown, timeZone: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
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

/** Resolves the configured display timezone (defaults to `Asia/Shanghai`). */
function readTimezone(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const rawTz = monitoring.timezone;
  return typeof rawTz === 'string' && rawTz ? rawTz : 'Asia/Shanghai';
}

/** Builds the `disk_health.html` render context from storage + config. */
export function buildDiskHealthContext(
  db: SqliteDatabase,
  config: AppConfig,
): DiskHealthContext {
  const healthList = getAllDiskHealth(db);
  const healths = new Map<string, DiskHealthSnapshot>();
  for (const item of healthList) {
    healths.set(item.host_name, item);
  }

  // Ordered de-dupe: configured servers first (config order), then extra hosts.
  const names: string[] = [];
  const seen = new Set<string>();
  for (const server of config.servers) {
    if (!seen.has(server.name)) {
      seen.add(server.name);
      names.push(server.name);
    }
  }
  for (const item of healthList) {
    if (!seen.has(item.host_name)) {
      seen.add(item.host_name);
      names.push(item.host_name);
    }
  }

  const addresses = new Map<string, string>(config.servers.map((s) => [s.name, s.host]));
  const groups = new Map<string, string>(
    config.servers.map((s) => [s.name, s.group || '未分组']),
  );
  const tz = readTimezone(db);

  const totals = { healthy: 0, warning: 0, critical: 0, drives: 0 };
  const drives: Obj[] = [];
  const rows: Obj[] = [];

  for (const name of names) {
    const health = healths.get(name);
    const counts = diskHealthSummary(health);

    totals.healthy += counts.healthy;
    totals.warning += counts.warning;
    totals.critical += counts.critical;
    totals.drives += counts.healthy + counts.warning + counts.critical;

    const group = groups.get(name) ?? '未分组';
    const address = addresses.get(name) ?? null;

    const hostDrives: Obj[] = (health?.physical_drives ?? []).map((raw) => ({
      ...asObj(raw),
      host_name: name,
    }));
    for (const drive of hostDrives) {
      drives.push(drive);
    }
    hostDrives.sort((a, b) => {
      const [aHot, aSlot] = driveSortKey(a);
      const [bHot, bSlot] = driveSortKey(b);
      return aHot - bHot || aSlot - bSlot;
    });

    const temperatures = hostDrives
      .map((drive) => drive.temperature_c)
      .filter(isNumber);

    const searchParts: string[] = [name, group, address ?? ''];
    for (const drive of hostDrives) {
      searchParts.push(String(drive.model ?? ''), String(drive.serial ?? ''));
    }
    const searchText = searchParts.join(' ').toLowerCase();

    rows.push({
      name,
      anchor: anchorSlug(name),
      host: address,
      group,
      status: counts.status,
      healthy: counts.healthy,
      warning: counts.warning,
      critical: counts.critical,
      needs_attention:
        Boolean(counts.warning || counts.critical) ||
        counts.status === 'error' ||
        counts.status === 'no_storcli',
      controller_count: health ? (health.controllers ?? []).length : 0,
      vd_count: health ? (health.virtual_drives ?? []).length : 0,
      pd_count: health ? (health.physical_drives ?? []).length : 0,
      message: health ? health.message : null,
      temperature_max: temperatures.length > 0 ? Math.max(...temperatures) : null,
      collected_at: health ? toLocalIso(health.collected_at, tz) : null,
      drives: hostDrives,
      search_text: searchText,
    });
  }

  rows.sort((a, b) => {
    const rankA = SEVERITY_RANK[String(a.status)] ?? 9;
    const rankB = SEVERITY_RANK[String(b.status)] ?? 9;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
  });

  // --- group statistics + group headers -----------------------------------
  const groupStats: DiskHealthContext['group_stats'] = {};
  for (const row of rows) {
    const group = String(row.group);
    let stats = groupStats[group];
    if (!stats) {
      stats = { hosts: 0, healthy: 0, warning: 0, critical: 0, max_temp: null };
      groupStats[group] = stats;
    }
    stats.hosts += 1;
    stats.healthy += Number(row.healthy) || 0;
    stats.warning += Number(row.warning) || 0;
    stats.critical += Number(row.critical) || 0;
    const temp = row.temperature_max;
    if (isNumber(temp) && (stats.max_temp === null || temp > stats.max_temp)) {
      stats.max_temp = temp;
    }
  }

  const distinctGroups = new Set(rows.map((row) => String(row.group)));
  const showGroupHeaders = distinctGroups.size > 1;
  const groupSizes = new Map<string, number>();
  for (const row of rows) {
    const group = String(row.group);
    groupSizes.set(group, (groupSizes.get(group) ?? 0) + 1);
  }
  const seenGroup = new Set<string>();
  for (const row of rows) {
    const group = String(row.group);
    if (showGroupHeaders && !seenGroup.has(group)) {
      row.group_header = group;
      seenGroup.add(group);
    } else {
      row.group_header = null;
    }
    row.group_size = showGroupHeaders ? (groupSizes.get(group) ?? 0) : 0;
  }

  // --- temperature statistics across every drive -------------------------
  const allTemps = drives.map((drive) => drive.temperature_c).filter(isNumber);
  const temperatureStats: DiskHealthContext['temperature_stats'] =
    allTemps.length > 0
      ? {
          max: Math.max(...allTemps),
          average: roundTo(allTemps.reduce((sum, value) => sum + value, 0) / allTemps.length, 1),
          hot: allTemps.filter((value) => value >= 55).length,
          samples: allTemps.length,
        }
      : { max: null, average: null, hot: 0, samples: 0 };

  const hasGroups = config.servers.some(
    (server: HostConfig) => Boolean(server.group) && server.group !== '未分组',
  );

  return {
    hosts: rows,
    drives,
    totals,
    temperature_stats: temperatureStats,
    group_stats: groupStats,
    has_groups: hasGroups,
  };
}

/** Injected dependencies. Only `db` + `config` are required. */
export interface DiskHealthRouteDeps {
  /** Open SQLite handle (disk-health snapshots + settings). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, app version, paths). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
}

/** Registers the disk-health page on `app`. */
export function registerDiskHealthRoutes(app: Express, deps: DiskHealthRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });

  app.get(ENDPOINTS.disk_health_page, (_req, res) => {
    const context = buildDiskHealthContext(db, config);
    templating.renderPage(res, 'disk_health.html', {
      active_page: 'disk_health',
      ...context,
    });
  });
}
