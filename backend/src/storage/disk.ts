/**
 * Disk-health batch storage, mirroring the Python oracle
 * `servermanage/storage/disk.py` (the four `disk_*_snapshot` tables).
 *
 * Functions (Python -> Node):
 *
 * - `save_disk_health`    (`disk.py:270`) -> {@link saveDiskHealth}
 * - `get_disk_health`     (`disk.py:134`) -> {@link getDiskHealth}
 * - `get_all_disk_health` (`disk.py:28`)  -> {@link getAllDiskHealth}
 * - `prune_disk_health`   (`disk.py:212`) -> {@link pruneDiskHealth}
 *
 * All functions take an already-open `better-sqlite3` handle instead of a path
 * (the whole backend runs in one process against one file; see `./db`).
 *
 * Behaviour notes carried over from the oracle:
 *
 * - `save_disk_health` calls `init_storage(db_path)` first; the equivalent here
 *   is an idempotent {@link initSchema} call so a save against a bare handle
 *   still creates the tables.
 * - The reasons JSON columns are written through `_dump_reasons`
 *   (`json.dumps(reasons or [], ensure_ascii=False)`), reproduced by
 *   {@link dumpJson}. Booleans in the `smart_alert` INTEGER column are `0`/`1`
 *   (or `NULL`); reads turn them back into real booleans.
 * - Overall `status` / `message` are read from the newest
 *   `disk_health_snapshot` header row and returned unchanged; component lists
 *   come from the latest batch at that same `collected_at`.
 * - A batch is keyed by `(host_name, collected_at)`; re-saving the same pair
 *   replaces its component rows (delete-then-insert) and updates the header.
 */
import { initSchema } from './schema';
import { dumpJson } from './json';
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

// --- Input model types (mirror servermanage/disk_health.py dataclasses) -----

/** `DiskControllerInfo` (`disk_health.py:50`). */
export interface DiskControllerInfoInput {
  controller: number;
  model?: string | null;
  firmware?: string | null;
  bbu_state?: string | null;
  /** Defaults to `"unknown"` when omitted (matches the dataclass default). */
  health?: string | null;
  reasons?: string[] | null;
}

/** `VirtualDriveInfo` (`disk_health.py:60`). */
export interface VirtualDriveInfoInput {
  controller: number;
  vd_id: number;
  raid_level?: string | null;
  state?: string | null;
  size?: string | null;
  /** Defaults to `"unknown"` when omitted (matches the dataclass default). */
  health?: string | null;
  reasons?: string[] | null;
}

/** `PhysicalDriveInfo` (`disk_health.py:71`). */
export interface PhysicalDriveInfoInput {
  controller: number;
  enclosure?: number | null;
  slot?: number | null;
  did?: number | null;
  model?: string | null;
  serial?: string | null;
  state?: string | null;
  media_errors?: number | null;
  other_errors?: number | null;
  predictive_failures?: number | null;
  smart_alert?: boolean | null;
  temperature_c?: number | null;
  shield_counter?: number | null;
  /** Defaults to `"unknown"` when omitted (matches the dataclass default). */
  health?: string | null;
  reasons?: string[] | null;
}

/** `DiskHealthReport` (`disk_health.py:90`). */
export interface DiskHealthReportInput {
  host_name: string;
  /** `datetime` on the Python side; a `Date` is rendered via {@link nowIsoUtc}. */
  collected_at: string | Date;
  /** Defaults to `"ok"` when omitted (matches the dataclass default). */
  status?: string | null;
  message?: string | null;
  controllers?: DiskControllerInfoInput[] | null;
  virtual_drives?: VirtualDriveInfoInput[] | null;
  physical_drives?: PhysicalDriveInfoInput[] | null;
}

// --- Output shapes (match Python's dict(row) results) -----------------------

/** One decoded `disk_controller_snapshot` row (without `host_name`). */
export interface DiskControllerSnapshot {
  controller: number | null;
  model: string | null;
  firmware: string | null;
  bbu_state: string | null;
  health: string | null;
  reasons: string[];
}

/** One decoded `disk_vd_snapshot` row (without `host_name`). */
export interface VirtualDriveSnapshot {
  controller: number | null;
  vd_id: number | null;
  raid_level: string | null;
  state: string | null;
  size: string | null;
  health: string | null;
  reasons: string[];
}

/** One decoded `disk_pd_snapshot` row (without `host_name`). */
export interface PhysicalDriveSnapshot {
  controller: number | null;
  enclosure: number | null;
  slot: number | null;
  did: number | null;
  model: string | null;
  serial: string | null;
  state: string | null;
  media_errors: number | null;
  other_errors: number | null;
  predictive_failures: number | null;
  /** `None` stays `null`; a stored `0`/`1` becomes `false`/`true`. */
  smart_alert: boolean | null;
  temperature_c: number | null;
  shield_counter: number | null;
  health: string | null;
  reasons: string[];
}

/** The whole batch dict returned by `get_disk_health` / `get_all_disk_health`. */
export interface DiskHealthSnapshot {
  host_name: string;
  collected_at: string;
  status: string;
  message: string | null;
  controllers: DiskControllerSnapshot[];
  virtual_drives: VirtualDriveSnapshot[];
  physical_drives: PhysicalDriveSnapshot[];
}

/** Per-table delete counts returned by {@link pruneDiskHealth}. */
export interface DiskPruneCounts {
  disk_health_snapshot: number;
  disk_controller_snapshot: number;
  disk_vd_snapshot: number;
  disk_pd_snapshot: number;
}

// --- Small helpers ----------------------------------------------------------

/** A `Date` is rendered as ISO-8601 UTC; a string is passed through unchanged. */
function toIsoUtc(value: string | Date): string {
  return value instanceof Date ? nowIsoUtc(value) : String(value);
}

/** Coerce an optional number to a bindable `number | null`. */
function num(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/** Coerce an optional string to a bindable `string | null`. */
function str(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Dataclass default `health="unknown"` applied only when the field is absent. */
function healthValue(value: string | null | undefined): string | null {
  return value === undefined ? 'unknown' : value;
}

/**
 * `_load_reasons` (`base.py:520`): parse the JSON reasons column; missing or
 * malformed values (or non-list JSON) decode to `[]`.
 */
function loadReasons(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** `_dump_reasons` (`base.py:436`): `json.dumps(reasons or [])`. */
function dumpReasons(reasons: string[] | null | undefined): string {
  return dumpJson(reasons ?? []);
}

/** Row shape for the `disk_health_snapshot` header table. */
interface HeaderRow {
  host_name: string;
  collected_at: string;
  status: string;
  message: string | null;
}

// --- disk_controller_snapshot ----------------------------------------------

interface ControllerRow {
  controller: number | null;
  model: string | null;
  firmware: string | null;
  bbu_state: string | null;
  health: string | null;
  reasons: string | null;
}

function decodeController(row: ControllerRow): DiskControllerSnapshot {
  return {
    controller: row.controller,
    model: row.model,
    firmware: row.firmware,
    bbu_state: row.bbu_state,
    health: row.health,
    reasons: loadReasons(row.reasons),
  };
}

// --- disk_vd_snapshot -------------------------------------------------------

interface VdRow {
  controller: number | null;
  vd_id: number | null;
  raid_level: string | null;
  state: string | null;
  size: string | null;
  health: string | null;
  reasons: string | null;
}

function decodeVirtualDrive(row: VdRow): VirtualDriveSnapshot {
  return {
    controller: row.controller,
    vd_id: row.vd_id,
    raid_level: row.raid_level,
    state: row.state,
    size: row.size,
    health: row.health,
    reasons: loadReasons(row.reasons),
  };
}

// --- disk_pd_snapshot -------------------------------------------------------

interface PdRow {
  controller: number | null;
  enclosure: number | null;
  slot: number | null;
  did: number | null;
  model: string | null;
  serial: string | null;
  state: string | null;
  media_errors: number | null;
  other_errors: number | null;
  predictive_failures: number | null;
  smart_alert: number | null;
  temperature_c: number | null;
  shield_counter: number | null;
  health: string | null;
  reasons: string | null;
}

function decodePhysicalDrive(row: PdRow): PhysicalDriveSnapshot {
  return {
    controller: row.controller,
    enclosure: row.enclosure,
    slot: row.slot,
    did: row.did,
    model: row.model,
    serial: row.serial,
    state: row.state,
    media_errors: row.media_errors,
    other_errors: row.other_errors,
    predictive_failures: row.predictive_failures,
    smart_alert:
      row.smart_alert === null || row.smart_alert === undefined
        ? null
        : Boolean(row.smart_alert),
    temperature_c: row.temperature_c,
    shield_counter: row.shield_counter,
    health: row.health,
    reasons: loadReasons(row.reasons),
  };
}

// --- save_disk_health -------------------------------------------------------

/**
 * Persists one {@link DiskHealthReportInput} batch into the disk tables.
 * Mirrors `save_disk_health` (`disk.py:270`).
 *
 * All rows share `report.collected_at` (rendered exactly like
 * `datetime.isoformat()`) so a batch can be read back together. Re-saving the
 * same `(host_name, collected_at)` replaces the old component rows and updates
 * the header. Writing always happens in a single transaction (Python commits
 * the batch as one unit).
 */
export function saveDiskHealth(db: SqliteDatabase, report: DiskHealthReportInput): void {
  // Python's save_disk_health calls init_storage(db_path) first.
  initSchema(db);

  const collectedAt = toIsoUtc(report.collected_at);
  const hostName = report.host_name;
  const status = report.status === undefined ? 'ok' : report.status;
  const message = report.message === undefined ? null : report.message;

  const controllerRows = (report.controllers ?? []).map((controller) => [
    collectedAt,
    hostName,
    num(controller.controller),
    str(controller.model),
    str(controller.firmware),
    str(controller.bbu_state),
    healthValue(controller.health),
    dumpReasons(controller.reasons),
  ]);

  const vdRows = (report.virtual_drives ?? []).map((vd) => [
    collectedAt,
    hostName,
    num(vd.controller),
    num(vd.vd_id),
    str(vd.raid_level),
    str(vd.state),
    str(vd.size),
    healthValue(vd.health),
    dumpReasons(vd.reasons),
  ]);

  const pdRows = (report.physical_drives ?? []).map((drive) => [
    collectedAt,
    hostName,
    num(drive.controller),
    num(drive.enclosure),
    num(drive.slot),
    num(drive.did),
    str(drive.model),
    str(drive.serial),
    str(drive.state),
    num(drive.media_errors),
    num(drive.other_errors),
    num(drive.predictive_failures),
    drive.smart_alert === null || drive.smart_alert === undefined
      ? null
      : drive.smart_alert
        ? 1
        : 0,
    num(drive.temperature_c),
    num(drive.shield_counter),
    healthValue(drive.health),
    dumpReasons(drive.reasons),
  ]);

  const insertHeader = db.prepare(
    `INSERT INTO disk_health_snapshot
        (host_name, collected_at, status, message)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(host_name, collected_at) DO UPDATE SET
        status = excluded.status,
        message = excluded.message`,
  );
  const deleteControllers = db.prepare(
    'DELETE FROM disk_controller_snapshot WHERE host_name = ? AND collected_at = ?',
  );
  const deleteVirtualDrives = db.prepare(
    'DELETE FROM disk_vd_snapshot WHERE host_name = ? AND collected_at = ?',
  );
  const deletePhysicalDrives = db.prepare(
    'DELETE FROM disk_pd_snapshot WHERE host_name = ? AND collected_at = ?',
  );
  const insertController = db.prepare(
    `INSERT INTO disk_controller_snapshot
        (collected_at, host_name, controller, model, firmware, bbu_state, health, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVirtualDrive = db.prepare(
    `INSERT INTO disk_vd_snapshot
        (collected_at, host_name, controller, vd_id, raid_level, state, size, health, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertPhysicalDrive = db.prepare(
    `INSERT INTO disk_pd_snapshot
        (collected_at, host_name, controller, enclosure, slot, did, model, serial,
         state, media_errors, other_errors, predictive_failures, smart_alert,
         temperature_c, shield_counter, health, reasons)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const run = db.transaction(() => {
    insertHeader.run(hostName, collectedAt, status, message);
    deleteControllers.run(hostName, collectedAt);
    deleteVirtualDrives.run(hostName, collectedAt);
    deletePhysicalDrives.run(hostName, collectedAt);
    for (const row of controllerRows) {
      insertController.run(...row);
    }
    for (const row of vdRows) {
      insertVirtualDrive.run(...row);
    }
    for (const row of pdRows) {
      insertPhysicalDrive.run(...row);
    }
  });
  run();
}

// --- get_disk_health --------------------------------------------------------

/**
 * Returns the most recent disk-health batch for `hostName`, or `null` when no
 * header row exists. Mirrors `get_disk_health` (`disk.py:134`).
 */
export function getDiskHealth(
  db: SqliteDatabase,
  hostName: string,
): DiskHealthSnapshot | null {
  const header = db
    .prepare(
      'SELECT collected_at, status, message FROM disk_health_snapshot'
        + ' WHERE host_name = ?'
        + ' ORDER BY collected_at DESC LIMIT 1',
    )
    .get(hostName) as
    | { collected_at: string; status: string; message: string | null }
    | undefined;
  if (!header) {
    return null;
  }

  const collectedAt = header.collected_at;
  const controllers = db
    .prepare(
      'SELECT controller, model, firmware, bbu_state, health, reasons'
        + ' FROM disk_controller_snapshot'
        + ' WHERE host_name = ? AND collected_at = ?'
        + ' ORDER BY controller',
    )
    .all(hostName, collectedAt) as ControllerRow[];
  const virtualDrives = db
    .prepare(
      'SELECT controller, vd_id, raid_level, state, size, health, reasons'
        + ' FROM disk_vd_snapshot'
        + ' WHERE host_name = ? AND collected_at = ?'
        + ' ORDER BY controller, vd_id',
    )
    .all(hostName, collectedAt) as VdRow[];
  const physicalDrives = db
    .prepare(
      'SELECT controller, enclosure, slot, did, model, serial, state,'
        + ' media_errors, other_errors, predictive_failures, smart_alert,'
        + ' temperature_c, shield_counter, health, reasons'
        + ' FROM disk_pd_snapshot'
        + ' WHERE host_name = ? AND collected_at = ?'
        + ' ORDER BY controller, enclosure, slot',
    )
    .all(hostName, collectedAt) as PdRow[];

  return {
    host_name: hostName,
    collected_at: collectedAt,
    status: header.status,
    message: header.message,
    controllers: controllers.map(decodeController),
    virtual_drives: virtualDrives.map(decodeVirtualDrive),
    physical_drives: physicalDrives.map(decodePhysicalDrive),
  };
}

// --- get_all_disk_health ----------------------------------------------------

/**
 * Returns the latest disk-health batch for every host, ordered by host name.
 * Mirrors `get_all_disk_health` (`disk.py:28`): four fleet-wide queries (header
 * + one per component table) instead of four per host.
 */
export function getAllDiskHealth(db: SqliteDatabase): DiskHealthSnapshot[] {
  const latest =
    'WITH latest AS ('
    + ' SELECT host_name, MAX(collected_at) AS collected_at'
    + ' FROM disk_health_snapshot GROUP BY host_name'
    + ')';

  const headers = db
    .prepare(
      `${latest}
       SELECT h.host_name, h.collected_at, h.status, h.message
         FROM latest l
         JOIN disk_health_snapshot h
           ON h.host_name = l.host_name AND h.collected_at = l.collected_at
        ORDER BY h.host_name`,
    )
    .all() as HeaderRow[];
  if (!headers.length) {
    return [];
  }

  const controllers = db
    .prepare(
      `${latest}
       SELECT c.host_name, c.controller, c.model, c.firmware, c.bbu_state,
              c.health, c.reasons
         FROM latest l
         JOIN disk_controller_snapshot c
           ON c.host_name = l.host_name AND c.collected_at = l.collected_at
        ORDER BY c.host_name, c.controller`,
    )
    .all() as Array<ControllerRow & { host_name: string }>;
  const virtualDrives = db
    .prepare(
      `${latest}
       SELECT v.host_name, v.controller, v.vd_id, v.raid_level, v.state,
              v.size, v.health, v.reasons
         FROM latest l
         JOIN disk_vd_snapshot v
           ON v.host_name = l.host_name AND v.collected_at = l.collected_at
        ORDER BY v.host_name, v.controller, v.vd_id`,
    )
    .all() as Array<VdRow & { host_name: string }>;
  const physicalDrives = db
    .prepare(
      `${latest}
       SELECT p.host_name, p.controller, p.enclosure, p.slot, p.did, p.model,
              p.serial, p.state, p.media_errors, p.other_errors,
              p.predictive_failures, p.smart_alert, p.temperature_c,
              p.shield_counter, p.health, p.reasons
         FROM latest l
         JOIN disk_pd_snapshot p
           ON p.host_name = l.host_name AND p.collected_at = l.collected_at
        ORDER BY p.host_name, p.controller, p.enclosure, p.slot`,
    )
    .all() as Array<PdRow & { host_name: string }>;

  const results = new Map<string, DiskHealthSnapshot>();
  for (const row of headers) {
    results.set(String(row.host_name), {
      host_name: row.host_name,
      collected_at: row.collected_at,
      status: row.status,
      message: row.message,
      controllers: [],
      virtual_drives: [],
      physical_drives: [],
    });
  }

  for (const row of controllers) {
    const entry = results.get(String(row.host_name));
    if (!entry) {
      continue;
    }
    entry.controllers.push({
      controller: row.controller,
      model: row.model,
      firmware: row.firmware,
      bbu_state: row.bbu_state,
      health: row.health,
      reasons: loadReasons(row.reasons),
    });
  }
  for (const row of virtualDrives) {
    const entry = results.get(String(row.host_name));
    if (!entry) {
      continue;
    }
    entry.virtual_drives.push({
      controller: row.controller,
      vd_id: row.vd_id,
      raid_level: row.raid_level,
      state: row.state,
      size: row.size,
      health: row.health,
      reasons: loadReasons(row.reasons),
    });
  }
  for (const row of physicalDrives) {
    const entry = results.get(String(row.host_name));
    if (!entry) {
      continue;
    }
    entry.physical_drives.push({
      controller: row.controller,
      enclosure: row.enclosure,
      slot: row.slot,
      did: row.did,
      model: row.model,
      serial: row.serial,
      state: row.state,
      media_errors: row.media_errors,
      other_errors: row.other_errors,
      predictive_failures: row.predictive_failures,
      smart_alert:
        row.smart_alert === null || row.smart_alert === undefined
          ? null
          : Boolean(row.smart_alert),
      temperature_c: row.temperature_c,
      shield_counter: row.shield_counter,
      health: row.health,
      reasons: loadReasons(row.reasons),
    });
  }

  return [...results.keys()].sort().map((name) => results.get(name)!);
}

// --- disk-health history (trend) -------------------------------------------

/** One point in a host's disk-health history, used by the disk trend chart. */
export interface DiskHealthHistoryPoint {
  /** Stored batch timestamp (ISO-8601 UTC, same form as the snapshot rows). */
  collected_at: string;
  /** Overall batch status from `disk_health_snapshot.status`. */
  status: string;
  message: string | null;
  /** Total physical drives reported in this batch. */
  drives: number;
  healthy: number;
  warning: number;
  critical: number;
  /** Hottest physical-drive temperature in this batch (`null` when unknown). */
  max_temperature_c: number | null;
}

/**
 * Reads a host's recent disk-health batches for the trend chart.
 *
 * `days` filters by a cutoff on `collected_at` (rendered with the same ISO-8601
 * format as the stored rows, so the lexicographic string comparison matches
 * Python's); `limit` caps how many batches are returned. Results are ordered
 * oldest-first so a caller can plot them left-to-right. Per-batch drive counts
 * are aggregated from `disk_pd_snapshot` using the same healthy/warning/
 * critical vocabulary as {@link aggregateDiskHealth} (`disk/report.ts`).
 */
export function fetchDiskHealthHistory(
  db: SqliteDatabase,
  hostName: string,
  options: { days?: number; limit?: number; now?: Date } = {},
): DiskHealthHistoryPoint[] {
  const days = Math.max(1, Math.trunc(options.days ?? 30));
  const limit = Math.min(200, Math.max(1, Math.trunc(options.limit ?? 100)));
  const now = options.now ?? new Date();
  const cutoff = nowIsoUtc(new Date(now.getTime() - days * 86_400_000));

  const headers = db
    .prepare(
      'SELECT collected_at, status, message FROM disk_health_snapshot'
        + ' WHERE host_name = ? AND collected_at >= ?'
        + ' ORDER BY collected_at DESC LIMIT ?',
    )
    .all(hostName, cutoff, limit) as Array<{
    collected_at: string;
    status: string;
    message: string | null;
  }>;
  if (headers.length === 0) {
    return [];
  }

  const aggregates = db
    .prepare(
      'SELECT collected_at,'
        + ' COUNT(*) AS drives,'
        + " SUM(CASE WHEN lower(health) = 'healthy' THEN 1 ELSE 0 END) AS healthy,"
        + " SUM(CASE WHEN lower(health) = 'warning' THEN 1 ELSE 0 END) AS warning,"
        + " SUM(CASE WHEN lower(health) = 'critical' THEN 1 ELSE 0 END) AS critical,"
        + ' MAX(temperature_c) AS max_temperature_c'
        + ' FROM disk_pd_snapshot WHERE host_name = ? GROUP BY collected_at',
    )
    .all(hostName) as Array<{
    collected_at: string;
    drives: number;
    healthy: number;
    warning: number;
    critical: number;
    max_temperature_c: number | null;
  }>;
  const byTime = new Map(aggregates.map((row) => [row.collected_at, row]));

  const points: DiskHealthHistoryPoint[] = headers.map((header) => {
    const agg = byTime.get(header.collected_at);
    return {
      collected_at: header.collected_at,
      status: header.status,
      message: header.message,
      drives: agg ? Number(agg.drives) || 0 : 0,
      healthy: agg ? Number(agg.healthy) || 0 : 0,
      warning: agg ? Number(agg.warning) || 0 : 0,
      critical: agg ? Number(agg.critical) || 0 : 0,
      max_temperature_c: agg ? agg.max_temperature_c : null,
    };
  });
  points.reverse();
  return points;
}

// --- prune_disk_health ------------------------------------------------------

/**
 * Prunes disk batches older than `retentionDays` or beyond the newest
 * `maxBatchesPerHost` per host. Mirrors `prune_disk_health` (`disk.py:212`).
 *
 * Returns the number of rows deleted from each of the four tables. `now`
 * defaults to the current instant (Python's `datetime.now(timezone.utc)`); the
 * cutoff timestamp is rendered with the same ISO-8601 format the batches use so
 * the lexicographic comparison matches Python's string comparison.
 */
export function pruneDiskHealth(
  db: SqliteDatabase,
  retentionDays = 7,
  maxBatchesPerHost = 100,
  now: Date = new Date(),
): DiskPruneCounts {
  const counts: DiskPruneCounts = {
    disk_health_snapshot: 0,
    disk_controller_snapshot: 0,
    disk_vd_snapshot: 0,
    disk_pd_snapshot: 0,
  };

  const days = Math.max(1, Math.trunc(retentionDays));
  const cutoff = nowIsoUtc(new Date(now.getTime() - days * 24 * 60 * 60 * 1000));
  const keepCount = Math.max(1, Math.trunc(maxBatchesPerHost));

  const headers = db
    .prepare(
      'SELECT host_name, collected_at FROM disk_health_snapshot'
        + ' ORDER BY host_name, collected_at DESC',
    )
    .all() as Array<{ host_name: string; collected_at: string }>;

  const keep = new Map<string, number>();
  const toDelete: Array<{ host_name: string; collected_at: string }> = [];
  for (const row of headers) {
    const index = keep.get(row.host_name) ?? 0;
    keep.set(row.host_name, index + 1);
    // Same predicate as Python: drop once past the per-host keep window, or
    // once the batch predates the retention cutoff.
    if (index >= keepCount || row.collected_at < cutoff) {
      toDelete.push(row);
    }
  }

  const run = db.transaction(() => {
    const deleteHeader = db.prepare(
      'DELETE FROM disk_health_snapshot WHERE host_name = ? AND collected_at = ?',
    );
    for (const row of toDelete) {
      deleteHeader.run(row.host_name, row.collected_at);
    }
    counts.disk_health_snapshot = toDelete.length;

    // Drop orphaned component rows whose header batch no longer exists.
    const componentTables = [
      'disk_controller_snapshot',
      'disk_vd_snapshot',
      'disk_pd_snapshot',
    ] as const;
    for (const table of componentTables) {
      const info = db
        .prepare(
          `DELETE FROM ${table}
            WHERE NOT EXISTS (
              SELECT 1 FROM disk_health_snapshot h
               WHERE h.host_name = ${table}.host_name
                 AND h.collected_at = ${table}.collected_at
            )`,
        )
        .run();
      counts[table] = info.changes;
    }
  });
  run();

  return counts;
}
