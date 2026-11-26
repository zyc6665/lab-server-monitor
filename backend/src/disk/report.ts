/**
 * Disk-health report assembly — 1:1 TypeScript port of the report-shaped parts
 * of `servermanage/disk_health.py` (P5 Task 5).
 *
 * Covered oracle pieces:
 * - `DiskControllerInfo` / `VirtualDriveInfo` / `PhysicalDriveInfo` /
 *   `DiskHealthReport` dataclasses (`disk_health.py:46-101`).
 * - `disk_report_from_snapshot` (`disk_health.py:703-790`).
 * - `_disk_health_summary` (`servermanage/web/routes/_core.py:917-931`) —
 *   exposed here as {@link aggregateDiskHealth} for callers that want the page
 *   summary without re-reading the storage layer.
 *
 * ## Field naming (deliberate divergence from `parse.ts` / `evaluate.ts`)
 *
 * `parse.ts` and `evaluate.ts` use camelCase field names (`mediaErrors`,
 * `vdId`, …) because they were ported field-for-field from the same Python
 * dataclasses but into idiomatic TS. The *report* type, however, must be
 * consumed **verbatim** by two existing snake_case-only consumers:
 *
 * - `storage/disk.ts` → `saveDiskHealth(db, report: DiskHealthReportInput)`
 * - `alerts/rules.ts` → `evaluateDiskAlerts(report: DiskHealthReport)`
 *
 * To wire those without a second translation layer at every call site, the
 * report keeps the Python dataclass field names (snake_case). It is therefore
 * structurally assignable to both `DiskHealthReportInput` and the alert
 * module's minimal `DiskHealthReport`. `collect.ts` is the single boundary that
 * maps the camelCase parse/evaluate rows into this snake_case report.
 *
 * ## `collected_at`
 *
 * Python's dataclass carries a `datetime`; the storage column and the alert
 * layer both expect an ISO-8601 string. This port normalises every timestamp
 * through {@link nowIsoUtc}, which renders byte-for-byte like Python's
 * `datetime.now(timezone.utc).isoformat()` (`…ffffff+00:00`). Naive ISO inputs
 * (no offset) are treated as UTC, matching `disk_report_from_snapshot`.
 */

import { nowIsoUtc } from '../storage/time';

// ---------------------------------------------------------------------------
// Report / component types (mirror disk_health.py:46-101, snake_case)
// ---------------------------------------------------------------------------

/** `DiskControllerInfo` (`disk_health.py:46`). */
export interface DiskControllerInfo {
  controller: number;
  model: string | null;
  firmware: string | null;
  bbu_state: string | null;
  health: string;
  reasons: string[];
}

/** `VirtualDriveInfo` (`disk_health.py:60`). */
export interface VirtualDriveInfo {
  controller: number;
  vd_id: number;
  raid_level: string | null;
  state: string | null;
  size: string | null;
  health: string;
  reasons: string[];
}

/** `PhysicalDriveInfo` (`disk_health.py:71`). */
export interface PhysicalDriveInfo {
  controller: number;
  enclosure: number | null;
  slot: number | null;
  did: number | null;
  model: string | null;
  serial: string | null;
  state: string | null;
  media_errors: number | null;
  other_errors: number | null;
  predictive_failures: number | null;
  smart_alert: boolean | null;
  temperature_c: number | null;
  shield_counter: number | null;
  health: string;
  reasons: string[];
}

/** `DiskHealthReport` (`disk_health.py:90`). */
export interface DiskHealthReport {
  host_name: string;
  collected_at: string;
  status: string;
  message: string | null;
  controllers: DiskControllerInfo[];
  virtual_drives: VirtualDriveInfo[];
  physical_drives: PhysicalDriveInfo[];
}

/**
 * Loose view of the stored snapshot dict that {@link diskReportFromSnapshot}
 * accepts. Every field is `unknown` because the input comes straight from the
 * SQLite read layer and the Python oracle tolerates arbitrary/partial dicts.
 * A real `DiskHealthSnapshot` is assignable to this shape.
 */
export interface DiskHealthSnapshotLike {
  host_name?: unknown;
  collected_at?: unknown;
  status?: unknown;
  message?: unknown;
  controllers?: unknown;
  virtual_drives?: unknown;
  physical_drives?: unknown;
}

/** Page summary, identical to `_disk_health_summary`'s return dict. */
export interface DiskHealthSummary {
  status: string;
  healthy: number;
  warning: number;
  critical: number;
}

/** Result of {@link aggregateDiskHealth} — `{summary}` per the task contract. */
export interface DiskHealthAggregate {
  summary: DiskHealthSummary;
}

// ---------------------------------------------------------------------------
// Conversion helpers (mirror disk_health.py:121-172)
// ---------------------------------------------------------------------------

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);
const MISSING_WORDS = new Set(['', '-', 'n/a', 'na', 'none', 'null', 'unknown']);
const INT_RE = /-?\d+/;

/** Python `str(value)` for the handful of scalar types that reach here. */
function pyStr(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

/** `_clean` (`disk_health.py:128`) — trim; empty / N/A-ish → `null`. */
function clean(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = pyStr(value).trim();
  if (MISSING_WORDS.has(text.toLowerCase())) {
    return null;
  }
  return text;
}

/** `_to_int` (`disk_health.py:138`) — best-effort integer; missing → `null`. */
function toInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    return Math.trunc(value);
  }
  const text = pyStr(value).trim();
  if (MISSING_WORDS.has(text.toLowerCase())) {
    return null;
  }
  const match = INT_RE.exec(text);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** `_to_bool` (`disk_health.py:158`) — best-effort boolean; missing → `null`. */
function toBool(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const text = pyStr(value).trim().toLowerCase();
  if (TRUE_WORDS.has(text)) {
    return true;
  }
  if (FALSE_WORDS.has(text)) {
    return false;
  }
  return null;
}

/** ISO-8601 date-time (time optional), optional fraction and offset. */
const ISO_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Parse an ISO-8601 string to an absolute UTC instant measured in **microseconds**
 * (the precision of Python's `datetime`). Returns `null` when unparseable.
 *
 * A `Date` cannot hold microsecond precision, so round-tripping through it would
 * silently drop the sub-millisecond digits of a Python-produced snapshot. Doing
 * the arithmetic on micros keeps `diskReportFromSnapshot` byte-faithful to
 * `disk_report_from_snapshot` (which keeps the full `datetime` precision).
 */
function isoToEpochMicros(text: string): number | null {
  const match = ISO_PARTS.exec(text);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h ?? '0');
  const minute = Number(mi ?? '0');
  const second = Number(s ?? '0');
  const micro = frac ? Number((frac + '000000').slice(0, 6)) : 0;
  const baseMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(baseMs)) {
    return null;
  }
  let offsetSeconds = 0;
  if (offset && offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const [oh, om] = offset.slice(1).split(':').map(Number);
    offsetSeconds = sign * (oh * 60 + om) * 60;
  }
  return baseMs * 1000 + micro - offsetSeconds * 1_000_000;
}

/** Render an absolute UTC instant (µs) as `…ffffff+00:00` (Python isoformat). */
function formatUtcMicros(epochMicros: number): string {
  const epochMs = Math.floor(epochMicros / 1000);
  let subMicro = epochMicros - epochMs * 1000;
  if (subMicro < 0) {
    subMicro += 1000;
  }
  const date = new Date(epochMs);
  const msFraction = ((epochMs % 1000) + 1000) % 1000;
  const fraction = msFraction * 1000 + subMicro;
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(fraction, 6)}+00:00`
  );
}

/**
 * `_as_datetime(...).isoformat()` equivalent: a `Date` is rendered via
 * {@link nowIsoUtc}; a parseable ISO string keeps **microsecond** precision and
 * is normalised to UTC (naive → UTC, like the oracle); anything unparseable
 * falls back to *now*.
 */
function toIsoUtc(value: unknown): string {
  if (value instanceof Date) {
    return nowIsoUtc(Number.isNaN(value.getTime()) ? new Date() : value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const micros = isoToEpochMicros(value.trim());
    if (micros !== null) {
      return formatUtcMicros(micros);
    }
  }
  return nowIsoUtc(new Date());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `_dicts(key)`: only dict items of a list survive (mirrors the oracle). */
function dictItems(snapshot: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const raw = snapshot[key];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(isPlainObject);
}

/** `list(item.get("reasons") or [])` — a falsy value yields `[]`. */
function reasonList(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : pyStr(item)));
  }
  if (typeof value === 'string') {
    return Array.from(value);
  }
  return [];
}

/** `item.get("health") or "unknown"` — falsy values fall back to `"unknown"`. */
function healthOrUnknown(value: unknown): string {
  return value ? pyStr(value) : 'unknown';
}

// ---------------------------------------------------------------------------
// disk_report_from_snapshot
// ---------------------------------------------------------------------------

/**
 * `disk_report_from_snapshot` (`disk_health.py:703`).
 *
 * Rebuilds a {@link DiskHealthReport} from `storage.getDiskHealth` output so
 * `run_disk_once` can feed the previous persisted batch back into
 * `collectDiskHealth` (and into `evaluateDriveHealth`'s `error_increase`
 * comparison).
 *
 * This is a **pure reconstruction**: it copies the persisted `health` /
 * `reasons` verbatim and does *not* re-evaluate drives. Missing values map to
 * `null` / empty lists, so a partial previous batch (e.g. `permission_denied`
 * with no drives) round-trips without fabricating data.
 */
export function diskReportFromSnapshot(
  snapshot: DiskHealthSnapshotLike | null | undefined,
): DiskHealthReport {
  const source: Record<string, unknown> = isPlainObject(snapshot)
    ? (snapshot as Record<string, unknown>)
    : {};

  const controllers: DiskControllerInfo[] = dictItems(source, 'controllers').map((item) => ({
    controller: toInt(item.controller) ?? 0,
    model: clean(item.model),
    firmware: clean(item.firmware),
    bbu_state: clean(item.bbu_state),
    health: healthOrUnknown(item.health),
    reasons: reasonList(item.reasons),
  }));

  const virtualDrives: VirtualDriveInfo[] = dictItems(source, 'virtual_drives').map((item) => ({
    controller: toInt(item.controller) ?? 0,
    vd_id: toInt(item.vd_id) ?? 0,
    raid_level: clean(item.raid_level),
    state: clean(item.state),
    size: clean(item.size),
    health: healthOrUnknown(item.health),
    reasons: reasonList(item.reasons),
  }));

  const physicalDrives: PhysicalDriveInfo[] = dictItems(source, 'physical_drives').map((item) => ({
    controller: toInt(item.controller) ?? 0,
    enclosure: toInt(item.enclosure),
    slot: toInt(item.slot),
    did: toInt(item.did),
    model: clean(item.model),
    serial: clean(item.serial),
    state: clean(item.state),
    media_errors: toInt(item.media_errors),
    other_errors: toInt(item.other_errors),
    predictive_failures: toInt(item.predictive_failures),
    smart_alert: toBool(item.smart_alert),
    temperature_c: toInt(item.temperature_c),
    shield_counter: toInt(item.shield_counter),
    health: healthOrUnknown(item.health),
    reasons: reasonList(item.reasons),
  }));

  const hostName = source.host_name ? pyStr(source.host_name) : '';
  const status = source.status ? pyStr(source.status) : 'ok';
  const rawMessage = source.message;
  const message =
    rawMessage === null || rawMessage === undefined
      ? null
      : typeof rawMessage === 'string'
        ? rawMessage
        : pyStr(rawMessage);

  return {
    host_name: hostName,
    collected_at: toIsoUtc(source.collected_at),
    status,
    message,
    controllers,
    virtual_drives: virtualDrives,
    physical_drives: physicalDrives,
  };
}

// ---------------------------------------------------------------------------
// _disk_health_summary
// ---------------------------------------------------------------------------

/**
 * `_disk_health_summary` (`servermanage/web/routes/_core.py:917`).
 *
 * Overall status plus per-drive health counts from the latest batch. A missing
 * batch yields `{status: "unknown", 0, 0, 0}`. Only the three canonical health
 * values are counted (unknown / missing drives are ignored), matching the
 * oracle's `if value in counts` guard.
 *
 * This mirrors the P2 route helper `diskHealthSummary` in
 * `web/routes/disk-health.ts`; it exists here so a caller holding a freshly
 * collected {@link DiskHealthReport} can summarise it without a DB round-trip.
 */
export function aggregateDiskHealth(
  report: Pick<DiskHealthReport, 'status' | 'physical_drives'> | null | undefined,
): DiskHealthAggregate {
  const summary: DiskHealthSummary = { status: 'unknown', healthy: 0, warning: 0, critical: 0 };
  if (!report) {
    return { summary };
  }
  for (const drive of report.physical_drives ?? []) {
    const value = String(drive?.health ?? '').toLowerCase();
    if (value === 'healthy') {
      summary.healthy += 1;
    } else if (value === 'warning') {
      summary.warning += 1;
    } else if (value === 'critical') {
      summary.critical += 1;
    }
  }
  summary.status = String(report.status || 'unknown');
  return { summary };
}
