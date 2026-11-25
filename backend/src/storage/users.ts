/**
 * Server-user snapshot / baseline / scan-state / usage-history / operations
 * storage, mirroring the Python oracle `servermanage/storage/users.py`
 * (plus the small helpers it imports from `servermanage/storage/base.py`,
 * `servermanage/storage/hosts.py` and `servermanage/storage/metrics.py`).
 *
 * Functions (Python -> Node):
 *
 * - `save_host_user_snapshot`      (`users.py:625`)  -> {@link saveHostUserSnapshot}
 * - `save_host_user_scan_result`   (`users.py:569`)  -> {@link saveHostUserScanResult}
 * - `get_host_user_snapshot`       (`users.py:388`)  -> {@link getHostUserSnapshot}
 * - `get_all_host_user_snapshots`  (`users.py:285`)  -> {@link getAllHostUserSnapshots}
 * - `upsert_user_baseline`         (`users.py:799`)  -> {@link upsertUserBaseline}
 * - `get_user_baseline`            (`users.py:408`)  -> {@link getUserBaseline}
 * - `get_all_user_baselines`       (`users.py:306`)  -> {@link getAllUserBaselines}
 * - `delete_user_baseline`         (`users.py:264`)  -> {@link deleteUserBaseline}
 * - `save_user_scan_state`         (`users.py:707`)  -> {@link saveUserScanState}
 * - `get_user_scan_state`          (`users.py:432`)  -> {@link getUserScanState}
 * - `get_all_user_scan_states`     (`users.py:331`)  -> {@link getAllUserScanStates}
 * - `append_user_usage_history`    (`users.py:150`)  -> {@link appendUserUsageHistory}
 * - `get_user_usage_deltas`        (`users.py:452`)  -> {@link getUserUsageDeltas}
 * - `get_all_user_usage_deltas`    (`users.py:349`)  -> {@link getAllUserUsageDeltas}
 * - `get_user_usage_series`        (`users.py:489`)  -> {@link getUserUsageSeries}
 * - `save_user_operation`          (`users.py:656`)  -> {@link saveUserOperation}
 * - `list_user_operations`         (`users.py:544`)  -> {@link listUserOperations}
 * - `top_user_growth`              (`users.py:742`)  -> {@link topUserGrowth}
 * - `delete_host_user_data`        (`users.py:242`)  -> {@link deleteHostUserData}
 *
 * The Python oracle opens a short-lived connection per call (`_connect` +
 * `init_storage`). The Node backend runs one long-lived `better-sqlite3`
 * handle, so every function here takes that handle (`db`) as its first
 * argument instead of a `db_path` — the same convention used by `./hosts`,
 * `./metrics-write` and `./settings`. Row shapes keep the Python column names
 * (`host_name`, `username`, ...) so results match `dict(sqlite3.Row)` for the
 * differential harness.
 *
 * JSON columns (`groups_json`, `steps_json`) are serialised through `./json`
 * (byte-compatible with `json.dumps(..., ensure_ascii=False)`) and timestamps
 * through `./time` (`nowIsoUtc`, `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`).
 * Booleans in INTEGER columns are stored as `0`/`1`.
 */
import { dumpJson } from './json';
import { nowIsoUtc } from './time';

type SqliteDatabase = import('better-sqlite3').Database;

// --- input / output types ---------------------------------------------------

/**
 * One account as stored by the snapshot/baseline writers. Field names mirror
 * the mapping the Python scan code builds (`username`, `uid`, `gid`, ...);
 * every field except `username` is optional.
 */
export interface UserAccountInput {
  username: string;
  uid?: number | string | null;
  gid?: number | string | null;
  primary_group?: string | null;
  gecos?: string | null;
  home?: string | null;
  shell?: string | null;
  /** Group names; serialised to `groups_json` like Python's `_account_groups`. */
  groups?: readonly unknown[] | null;
  in_docker?: unknown;
  in_sudo?: unknown;
  home_exists?: unknown;
  home_owner?: string | null;
  home_group?: string | null;
  home_mode?: string | null;
  home_size_bytes?: number | null;
  data_exists?: unknown;
  data_owner?: string | null;
  data_group?: string | null;
  data_mode?: string | null;
  data_size_bytes?: number | null;
  data_supported?: unknown;
  usage_stale?: unknown;
  usage_readable?: unknown;
  usage_collected_at?: string | Date | null;
  collected_at?: string | Date | null;
}

/** One decoded snapshot/baseline row (`dict(sqlite3.Row)` + `groups`). */
export type UserRow = Record<string, unknown> & { groups: string[] };

/** One decoded `host_user_scan_state` row. */
export interface UserScanState {
  host_name: string;
  last_scan_at: string | null;
  last_usage_at: string | null;
  last_error: string | null;
}

/** One `username -> delta` entry (`_deltas_from_samples`). */
export interface UserUsageDelta {
  delta: number | null;
  base: number | null;
  current: number | null;
  since: string | null;
  points: number;
}

/** One down-sampled usage-history point (`get_user_usage_series`). */
export interface UserUsagePoint {
  at: string;
  home: number | null;
  data: number | null;
  total: number;
}

/** One decoded `user_operations` audit row (`_decode_user_operation`). */
export interface UserOperation {
  id: number;
  created_at: string;
  finished_at: string | null;
  host_name: string;
  account: string;
  operation: string;
  status: string;
  actor: string;
  plan_hash: string;
  steps: unknown[];
  error: string;
}

/** One entry returned by {@link topUserGrowth} (`top_user_growth`). */
export interface UserGrowthItem {
  host: string;
  account: string;
  delta: number;
  base: number;
  current: number;
  since: string;
}

/** Options for {@link appendUserUsageHistory}. */
export interface AppendUserUsageHistoryOptions {
  now?: Date | string | null;
  retainDays?: number;
  minIntervalHours?: number;
}

/** Options for {@link upsertUserBaseline}. */
export interface UpsertUserBaselineOptions {
  now?: Date | string | null;
}

/** Options for {@link saveUserScanState}. `null`/omitted leaves a column untouched. */
export interface SaveUserScanStateOptions {
  lastScanAt?: Date | string | null;
  lastUsageAt?: Date | string | null;
  lastError?: string | null;
}

/** Options for {@link saveHostUserScanResult}. */
export interface SaveHostUserScanResultOptions {
  now?: Date | string | null;
  usageRefreshed?: boolean;
  seedOnly?: boolean;
}

/** Options for {@link saveUserOperation}. */
export interface SaveUserOperationOptions {
  actor?: string;
  planHash?: string;
  steps?: readonly Record<string, unknown>[] | null;
  error?: string;
  createdAt?: Date | string | null;
  finishedAt?: Date | string | null;
}

/** Options for {@link getUserUsageDeltas} / {@link getAllUserUsageDeltas}. */
export interface UsageDeltasOptions {
  days?: number;
  now?: Date | string | null;
}

/** Options for {@link getUserUsageSeries}. */
export interface UserUsageSeriesOptions {
  days?: number;
  now?: Date | string | null;
  maxPoints?: number;
}

/** Options for {@link listUserOperations}. */
export interface ListUserOperationsOptions {
  hostName?: string | null;
  limit?: number;
}

/** Options for {@link topUserGrowth}. */
export interface TopUserGrowthOptions {
  days?: number;
  limit?: number;
  now?: Date | string | null;
}

// --- small helpers (mirror base.py / hosts.py) -----------------------------

/** Left-pad a value to `width` digits. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Python truthiness for `_flag` (`None` -> `default`). */
function flag(value: unknown, defaultValue = false): number {
  if (value === null || value === undefined) {
    return defaultValue ? 1 : 0;
  }
  return value ? 1 : 0;
}

/**
 * `_to_iso_utc` (`base.py:719`): a `Date` is rendered through {@link nowIsoUtc};
 * a string is returned unchanged (already ISO-8601 UTC).
 */
function toIsoUtc(value: string | Date): string {
  return value instanceof Date ? nowIsoUtc(value) : String(value);
}

/** A moment resolved to a UTC `Date` plus its original 6-digit microsecond part. */
interface ParsedInstant {
  date: Date;
  /** Normalised 6-digit fractional string, or `null` when the input had none. */
  frac: string | null;
}

/**
 * Parses an ISO-8601 instant written by Python (`datetime.isoformat()` /
 * {@link nowIsoUtc}). A missing offset is treated as UTC. The fractional part
 * is preserved verbatim (zero-padded to 6 digits) so `datetime(...).isoformat()`
 * can be reproduced, including Python's rule of dropping `.000000`.
 */
function parseInstant(text: string): ParsedInstant {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(
      text.trim(),
    );
  if (!match) {
    throw new Error(`Invalid ISO-8601 timestamp: ${text}`);
  }
  const [, year, month, day, hours, minutes, seconds, frac] = match;
  const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  const date = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hours),
      Number(minutes),
      Number(seconds),
      ms,
    ),
  );
  const frac6 = frac ? frac.padEnd(6, '0').slice(0, 6) : null;
  return { date, frac: frac6 };
}

/**
 * Formats `date` as Python's `datetime.isoformat()` would for an aware UTC
 * datetime: six fractional digits only when the microsecond part is non-zero,
 * always ending in `+00:00`. `frac` (when present) supplies the microsecond
 * digits; otherwise they come from the `Date`'s milliseconds.
 */
function formatPythonIso(date: Date, frac: string | null): string {
  const base =
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-` +
    `${pad(date.getUTCDate(), 2)}T${pad(date.getUTCHours(), 2)}:` +
    `${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  const micro = frac !== null ? frac : pad(date.getUTCMilliseconds() * 1000, 6);
  if (/^0{6}$/.test(micro)) {
    return `${base}+00:00`;
  }
  return `${base}.${micro}+00:00`;
}

/** The ISO string for `now` (default "now"), matching `_to_iso_utc`/`isoformat`. */
function momentString(now: Date | string | null | undefined): string {
  if (now === null || now === undefined) {
    return nowIsoUtc();
  }
  return toIsoUtc(now);
}

/** Shifts a parsed instant by `deltaMs` milliseconds, preserving its fraction. */
function shiftInstant(instant: ParsedInstant, deltaMs: number): string {
  return formatPythonIso(new Date(instant.date.getTime() + deltaMs), instant.frac);
}

/** `_load_groups` (`base.py:507`): decode a `groups_json` value into `string[]`. */
function loadGroups(value: unknown): string[] {
  if (!value) {
    return [];
  }
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.map((group) => String(group));
}

/** `_account_groups` (`base.py:405`): normalise `account.groups`. */
function accountGroups(account: UserAccountInput): string[] {
  const groups = account.groups;
  if (!groups || groups.length === 0) {
    return [];
  }
  return groups.map((group) => String(group));
}

/** `_optional_iso` (`base.py:639`): `Date`/string -> ISO string, `null` stays `null`. */
function optionalIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? nowIsoUtc(value) : String(value);
}

/** Python `round()` (round half to even) for non-negative floats. */
function pythonRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) {
    return floor;
  }
  if (diff > 0.5) {
    return floor + 1;
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

/** `int(value or 0)` for a possibly-null SQLite integer. */
function intOrZero(value: number | null | undefined): number {
  return value === null || value === undefined ? 0 : Math.trunc(Number(value));
}

const BOOL_COLUMNS = [
  'in_docker',
  'in_sudo',
  'home_exists',
  'data_exists',
  'data_supported',
  'usage_stale',
  'usage_readable',
] as const;

/** `_decode_user_row` (`users.py:59`): add `groups`, coerce flag columns to booleans. */
function decodeUserRow(row: Record<string, unknown>): UserRow {
  const { groups_json: groupsJson, ...rest } = row;
  const data: Record<string, unknown> = { ...rest };
  for (const key of BOOL_COLUMNS) {
    if (key in data && data[key] !== null && data[key] !== undefined) {
      data[key] = Boolean(data[key]);
    }
  }
  data.groups = loadGroups(groupsJson);
  return data as UserRow;
}

/** Raw `user_operations` row shape (`SELECT *`). */
interface UserOperationRow {
  id: number;
  created_at: string;
  finished_at: string | null;
  host_name: string;
  account: string;
  operation: string;
  status: string;
  actor: string | null;
  plan_hash: string | null;
  steps_json: string | null;
  error: string | null;
}

/** `_decode_user_operation` (`users.py:39`): parse `steps_json`, default nulls to ''. */
function decodeUserOperation(row: UserOperationRow): UserOperation {
  let steps: unknown[] = [];
  try {
    const parsed = JSON.parse(row.steps_json || '[]') as unknown;
    steps = Array.isArray(parsed) ? parsed : [];
  } catch {
    steps = [];
  }
  return {
    id: row.id,
    created_at: row.created_at,
    finished_at: row.finished_at,
    host_name: row.host_name,
    account: row.account,
    operation: row.operation,
    status: row.status,
    actor: row.actor || '',
    plan_hash: row.plan_hash || '',
    steps,
    error: row.error || '',
  };
}

// --- snapshot insert (mirror hosts.py:_snapshot_row/_replace_snapshot_rows) -

const SNAPSHOT_INSERT_SQL = `
INSERT INTO host_user_snapshot (
    host_name, username, uid, gid, primary_group, gecos, home,
    shell, groups_json, in_docker, in_sudo, home_exists,
    home_owner, home_group, home_mode, home_size_bytes,
    data_exists, data_owner, data_group, data_mode,
    data_size_bytes, data_supported, usage_stale, usage_readable,
    usage_collected_at, collected_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?
)`;

/** One prepared `host_user_snapshot` insert row (26 columns). */
type SnapshotRow = [
  string, // host_name
  string, // username
  unknown, // uid
  unknown, // gid
  unknown, // primary_group
  unknown, // gecos
  unknown, // home
  unknown, // shell
  string, // groups_json
  number, // in_docker
  number, // in_sudo
  number, // home_exists
  unknown, // home_owner
  unknown, // home_group
  unknown, // home_mode
  unknown, // home_size_bytes
  number, // data_exists
  unknown, // data_owner
  unknown, // data_group
  unknown, // data_mode
  unknown, // data_size_bytes
  number, // data_supported
  number, // usage_stale
  number, // usage_readable
  string | null, // usage_collected_at
  string, // collected_at
];

/**
 * `_snapshot_row` (`hosts.py:52`): build the 26-column snapshot row. `uid`/`gid`
 * are deliberately not coerced so a bad value fails inside the transaction
 * (and rolls back) rather than while building rows.
 */
function snapshotRow(
  hostName: string,
  account: UserAccountInput,
  collectedAt: string,
): SnapshotRow {
  const homeSize = account.home_size_bytes ?? null;
  const dataSize = account.data_size_bytes ?? null;
  return [
    hostName,
    String(account.username),
    account.uid ?? null,
    account.gid ?? null,
    account.primary_group ?? null,
    account.gecos ?? null,
    account.home ?? null,
    account.shell ?? null,
    dumpJson(accountGroups(account)),
    flag(account.in_docker),
    flag(account.in_sudo),
    flag(account.home_exists),
    account.home_owner ?? null,
    account.home_group ?? null,
    account.home_mode ?? null,
    homeSize,
    flag(account.data_exists),
    account.data_owner ?? null,
    account.data_group ?? null,
    account.data_mode ?? null,
    dataSize,
    flag(account.data_supported, true),
    flag(account.usage_stale),
    flag(account.usage_readable, homeSize !== null || dataSize !== null),
    optionalIso(account.usage_collected_at),
    optionalIso(account.collected_at) ?? collectedAt,
  ];
}

/** `_replace_snapshot_rows` (`hosts.py:42`): delete a host's rows, then insert. */
function replaceSnapshotRows(
  db: SqliteDatabase,
  hostName: string,
  rows: readonly SnapshotRow[],
): void {
  db.prepare('DELETE FROM host_user_snapshot WHERE host_name = ?').run(hostName);
  if (!rows.length) {
    return;
  }
  const insert = db.prepare(SNAPSHOT_INSERT_SQL);
  for (const row of rows) {
    insert.run(...row);
  }
}

// --- baseline / scan-state writers (mirror users.py) -----------------------

/**
 * `_write_baseline` (`users.py:77`): insert or refresh one baseline row.
 * Returns `true` only when the row was inserted (the `user-added` edge).
 */
function writeBaseline(
  db: SqliteDatabase,
  hostName: string,
  account: UserAccountInput,
  seenAt: string,
): boolean {
  const username = String(account.username);
  const values = [
    account.uid ?? null,
    account.gid ?? null,
    account.primary_group ?? null,
    account.shell ?? null,
    account.home ?? null,
    dumpJson(accountGroups(account)),
    flag(account.in_docker),
    flag(account.in_sudo),
  ] as const;

  const existing = db
    .prepare('SELECT 1 FROM host_user_baseline WHERE host_name = ? AND username = ?')
    .get(hostName, username);
  if (!existing) {
    db.prepare(
      `INSERT INTO host_user_baseline (
         host_name, username, uid, gid, primary_group, shell, home,
         groups_json, in_docker, in_sudo, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(hostName, username, ...values, seenAt, seenAt);
    return true;
  }

  db.prepare(
    `UPDATE host_user_baseline SET
       uid = ?, gid = ?, primary_group = ?, shell = ?, home = ?,
       groups_json = ?, in_docker = ?, in_sudo = ?,
       last_seen_at = ?
     WHERE host_name = ? AND username = ?`,
  ).run(...values, seenAt, hostName, username);
  return false;
}

/**
 * `_write_scan_state` (`users.py:121`): partially upsert the scan-state row.
 * Only non-`null` options overwrite their column; `lastError: ''` clears a
 * previous error, whereas `lastError: null` leaves it untouched.
 */
function writeScanState(
  db: SqliteDatabase,
  hostName: string,
  options: SaveUserScanStateOptions,
): void {
  const updates: Array<[string, unknown]> = [];
  if (options.lastScanAt !== null && options.lastScanAt !== undefined) {
    updates.push(['last_scan_at', toIsoUtc(options.lastScanAt)]);
  }
  if (options.lastUsageAt !== null && options.lastUsageAt !== undefined) {
    updates.push(['last_usage_at', toIsoUtc(options.lastUsageAt)]);
  }
  if (options.lastError !== null && options.lastError !== undefined) {
    updates.push(['last_error', String(options.lastError)]);
  }

  db.prepare(
    'INSERT INTO host_user_scan_state (host_name) VALUES (?)'
      + ' ON CONFLICT(host_name) DO NOTHING',
  ).run(hostName);

  if (updates.length) {
    const assignments = updates.map(([column]) => `${column} = ?`).join(', ');
    db.prepare(
      `UPDATE host_user_scan_state SET ${assignments} WHERE host_name = ?`,
    ).run(...updates.map(([, value]) => value), hostName);
  }
}

// --- user_usage_history aggregation (mirror metrics.py:_deltas_from_samples) -

/**
 * `_deltas_from_samples` (`metrics.py:39`): aggregate per-username
 * `[(collected_at, total)]` into `{delta, base, current, since, points}`.
 */
function deltasFromSamples(
  samples: Record<string, Array<[string, number]>>,
): Record<string, UserUsageDelta> {
  const deltas: Record<string, UserUsageDelta> = {};
  for (const [username, points] of Object.entries(samples)) {
    if (points.length < 2) {
      deltas[username] = {
        delta: null,
        base: points.length ? points[0][1] : null,
        current: points.length ? points[points.length - 1][1] : null,
        since: points.length ? points[0][0] : null,
        points: points.length,
      };
      continue;
    }
    const base = points[0][1];
    const current = points[points.length - 1][1];
    deltas[username] = {
      delta: current - base,
      base,
      current,
      since: points[0][0],
      points: points.length,
    };
  }
  return deltas;
}

// --- snapshots --------------------------------------------------------------

/**
 * Replaces the account snapshot for `hostName` in one `BEGIN IMMEDIATE`
 * transaction. Mirrors `save_host_user_snapshot` (`users.py:625`): passing an
 * empty list clears the host, and any failure rolls back to the previous
 * snapshot.
 */
export function saveHostUserSnapshot(
  db: SqliteDatabase,
  hostName: string,
  accounts: readonly UserAccountInput[],
): void {
  const fallbackCollectedAt = nowIsoUtc();
  const rows = accounts.map((account) =>
    snapshotRow(hostName, account, fallbackCollectedAt),
  );

  db.transaction(() => {
    replaceSnapshotRows(db, hostName, rows);
  }).immediate();
}

/**
 * Persists one successful scan atomically. Mirrors `save_host_user_scan_result`
 * (`users.py:569`): the snapshot, baseline rows and scan state share one
 * `BEGIN IMMEDIATE` transaction. Returns the usernames inserted into the
 * baseline (`seedOnly` returns an empty list: the first scan is silent).
 */
export function saveHostUserScanResult(
  db: SqliteDatabase,
  hostName: string,
  accounts: readonly UserAccountInput[],
  options: SaveHostUserScanResultOptions = {},
): string[] {
  const moment = momentString(options.now);
  const rows = accounts.map((account) => snapshotRow(hostName, account, moment));
  const inserted: string[] = [];

  db.transaction(() => {
    replaceSnapshotRows(db, hostName, rows);
    if (options.seedOnly) {
      for (const account of accounts) {
        writeBaseline(db, hostName, account, moment);
      }
    } else {
      for (const account of accounts) {
        if (writeBaseline(db, hostName, account, moment)) {
          inserted.push(String(account.username));
        }
      }
    }
    writeScanState(db, hostName, {
      lastScanAt: moment,
      lastUsageAt: options.usageRefreshed ? moment : null,
      lastError: '',
    });
  }).immediate();

  return inserted;
}

/** Returns the stored snapshot for `hostName`, ordered by username. */
export function getHostUserSnapshot(db: SqliteDatabase, hostName: string): UserRow[] {
  const rows = db
    .prepare('SELECT * FROM host_user_snapshot WHERE host_name = ? ORDER BY username')
    .all(hostName) as Array<Record<string, unknown>>;
  return rows.map(decodeUserRow);
}

/** Returns every snapshot grouped by host name, in one query. */
export function getAllHostUserSnapshots(
  db: SqliteDatabase,
): Record<string, UserRow[]> {
  const rows = db
    .prepare('SELECT * FROM host_user_snapshot ORDER BY host_name, username')
    .all() as Array<Record<string, unknown>>;
  const snapshots: Record<string, UserRow[]> = {};
  for (const row of rows) {
    const key = String(row.host_name);
    (snapshots[key] ??= []).push(decodeUserRow(row));
  }
  return snapshots;
}

// --- baselines --------------------------------------------------------------

/**
 * Inserts or refreshes the baseline row for one account. Mirrors
 * `upsert_user_baseline` (`users.py:799`): returns `true` only when the row did
 * not exist yet (the caller emits `user-added` on that edge).
 */
export function upsertUserBaseline(
  db: SqliteDatabase,
  hostName: string,
  account: UserAccountInput,
  options: UpsertUserBaselineOptions = {},
): boolean {
  const seenAt = momentString(options.now);
  let inserted = false;
  db.transaction(() => {
    inserted = writeBaseline(db, hostName, account, seenAt);
  }).immediate();
  return inserted;
}

/** Returns the baseline rows for `hostName`, ordered by username. */
export function getUserBaseline(db: SqliteDatabase, hostName: string): UserRow[] {
  const rows = db
    .prepare('SELECT * FROM host_user_baseline WHERE host_name = ? ORDER BY username')
    .all(hostName) as Array<Record<string, unknown>>;
  return rows.map(decodeUserRow);
}

/** Returns every baseline grouped by host name, in one query. */
export function getAllUserBaselines(
  db: SqliteDatabase,
): Record<string, UserRow[]> {
  const rows = db
    .prepare('SELECT * FROM host_user_baseline ORDER BY host_name, username')
    .all() as Array<Record<string, unknown>>;
  const baselines: Record<string, UserRow[]> = {};
  for (const row of rows) {
    const key = String(row.host_name);
    (baselines[key] ??= []).push(decodeUserRow(row));
  }
  return baselines;
}

/** Removes one baseline row; returns whether a row was actually deleted. */
export function deleteUserBaseline(
  db: SqliteDatabase,
  hostName: string,
  username: string,
): boolean {
  const info = db
    .prepare('DELETE FROM host_user_baseline WHERE host_name = ? AND username = ?')
    .run(hostName, username);
  return info.changes > 0;
}

// --- scan state -------------------------------------------------------------

/** Partially upserts the scan state for `hostName`. Mirrors `save_user_scan_state`. */
export function saveUserScanState(
  db: SqliteDatabase,
  hostName: string,
  options: SaveUserScanStateOptions = {},
): void {
  db.transaction(() => {
    writeScanState(db, hostName, options);
  }).immediate();
}

/** Returns the scan-state row for `hostName`, or `null` when absent. */
export function getUserScanState(
  db: SqliteDatabase,
  hostName: string,
): UserScanState | null {
  const row = db
    .prepare(
      'SELECT host_name, last_scan_at, last_usage_at, last_error'
        + ' FROM host_user_scan_state WHERE host_name = ?',
    )
    .get(hostName) as UserScanState | undefined;
  return row ?? null;
}

/** Returns the scan-state row for every host in one query. */
export function getAllUserScanStates(
  db: SqliteDatabase,
): Record<string, UserScanState> {
  const rows = db
    .prepare(
      'SELECT host_name, last_scan_at, last_usage_at, last_error'
        + ' FROM host_user_scan_state',
    )
    .all() as UserScanState[];
  const states: Record<string, UserScanState> = {};
  for (const row of rows) {
    states[String(row.host_name)] = row;
  }
  return states;
}

// --- user_usage_history -----------------------------------------------------

/**
 * Records one measurement per account so growth can be charted later. Mirrors
 * `append_user_usage_history` (`users.py:150`). Only accounts that actually
 * have a size are written (an unmeasured account would show a fake swing).
 * An unchanged size is recorded at most once per `minIntervalHours`; a changed
 * size is always recorded. Rows older than `retainDays` are pruned.
 */
export function appendUserUsageHistory(
  db: SqliteDatabase,
  hostName: string,
  accounts: readonly UserAccountInput[],
  options: AppendUserUsageHistoryOptions = {},
): number {
  const now = options.now;
  const retainDays = options.retainDays ?? 180;
  const minIntervalHours = options.minIntervalHours ?? 12;

  const moment = momentString(now);
  const anchor = parseInstant(moment);
  const cutoff =
    retainDays > 0 ? shiftInstant(anchor, -retainDays * 86_400_000) : null;
  const floor = shiftInstant(anchor, -Math.max(0, minIntervalHours) * 3_600_000);

  const candidates = accounts.filter(
    (account) =>
      Boolean(account.username)
      && (account.home_size_bytes !== null && account.home_size_bytes !== undefined
        || account.data_size_bytes !== null && account.data_size_bytes !== undefined),
  );
  if (!candidates.length) {
    return 0;
  }

  const insert = db.prepare(
    'INSERT OR REPLACE INTO host_user_usage_history'
      + ' (host_name, username, collected_at, home_size_bytes, data_size_bytes)'
      + ' VALUES (?, ?, ?, ?, ?)',
  );
  const lastStmt = db.prepare(
    'SELECT collected_at, home_size_bytes, data_size_bytes'
      + ' FROM host_user_usage_history'
      + ' WHERE host_name = ? AND username = ?'
      + ' ORDER BY collected_at DESC LIMIT 1',
  );
  const deleteStmt = db.prepare(
    'DELETE FROM host_user_usage_history WHERE host_name = ? AND collected_at < ?',
  );

  type UsageRow = [string, string, string, number | null, number | null];
  const rows: UsageRow[] = [];

  db.transaction(() => {
    for (const account of candidates) {
      const username = String(account.username);
      const home = account.home_size_bytes ?? null;
      const data = account.data_size_bytes ?? null;
      if (minIntervalHours > 0) {
        const last = lastStmt.get(hostName, username) as
          | { collected_at: string; home_size_bytes: number | null; data_size_bytes: number | null }
          | undefined;
        if (
          last
          && last.collected_at >= floor
          && last.home_size_bytes === home
          && last.data_size_bytes === data
        ) {
          continue;
        }
      }
      rows.push([hostName, username, moment, home, data]);
    }
    if (!rows.length) {
      return;
    }
    for (const row of rows) {
      insert.run(...row);
    }
    if (cutoff !== null) {
      deleteStmt.run(hostName, cutoff);
    }
  })();

  return rows.length;
}

/** Returns `username -> delta` between the oldest and newest sample in the window. */
export function getUserUsageDeltas(
  db: SqliteDatabase,
  hostName: string,
  options: UsageDeltasOptions = {},
): Record<string, UserUsageDelta> {
  const days = Math.max(1, Math.trunc(options.days ?? 7));
  const since = shiftInstant(parseInstant(momentString(options.now)), -days * 86_400_000);

  const rows = db
    .prepare(
      'SELECT username, collected_at, home_size_bytes, data_size_bytes'
        + ' FROM host_user_usage_history'
        + ' WHERE host_name = ? AND collected_at >= ?'
        + ' ORDER BY username, collected_at',
    )
    .all(hostName, since) as Array<{
      username: string;
      collected_at: string;
      home_size_bytes: number | null;
      data_size_bytes: number | null;
    }>;

  const samples: Record<string, Array<[string, number]>> = {};
  for (const row of rows) {
    const total = intOrZero(row.home_size_bytes) + intOrZero(row.data_size_bytes);
    (samples[String(row.username)] ??= []).push([row.collected_at, total]);
  }
  return deltasFromSamples(samples);
}

/** Returns per-host usage deltas for the whole fleet in one query. */
export function getAllUserUsageDeltas(
  db: SqliteDatabase,
  options: UsageDeltasOptions = {},
): Record<string, Record<string, UserUsageDelta>> {
  const days = Math.max(1, Math.trunc(options.days ?? 7));
  const since = shiftInstant(parseInstant(momentString(options.now)), -days * 86_400_000);

  const rows = db
    .prepare(
      'SELECT host_name, username, collected_at, home_size_bytes, data_size_bytes'
        + ' FROM host_user_usage_history'
        + ' WHERE collected_at >= ?'
        + ' ORDER BY host_name, username, collected_at',
    )
    .all(since) as Array<{
      host_name: string;
      username: string;
      collected_at: string;
      home_size_bytes: number | null;
      data_size_bytes: number | null;
    }>;

  const grouped: Record<string, Record<string, Array<[string, number]>>> = {};
  for (const row of rows) {
    const total = intOrZero(row.home_size_bytes) + intOrZero(row.data_size_bytes);
    const host = String(row.host_name);
    const username = String(row.username);
    ((grouped[host] ??= {})[username] ??= []).push([row.collected_at, total]);
  }

  const result: Record<string, Record<string, UserUsageDelta>> = {};
  for (const [host, samples] of Object.entries(grouped)) {
    result[host] = deltasFromSamples(samples);
  }
  return result;
}

/** Returns down-sampled usage history per account for the last `days` days. */
export function getUserUsageSeries(
  db: SqliteDatabase,
  hostName: string,
  options: UserUsageSeriesOptions = {},
): Record<string, UserUsagePoint[]> {
  const days = options.days ?? 30;
  const maxPoints = options.maxPoints ?? 36;
  const reference = parseInstant(momentString(options.now));
  const cutoff = shiftInstant(reference, -days * 86_400_000);

  let rows: Array<{
    username: string;
    collected_at: string;
    home_size_bytes: number | null;
    data_size_bytes: number | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT username, collected_at, home_size_bytes, data_size_bytes
           FROM host_user_usage_history
          WHERE host_name = ? AND collected_at >= ?
          ORDER BY username, collected_at`,
      )
      .all(hostName, cutoff) as typeof rows;
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) {
      return {};
    }
    throw err;
  }

  const series: Record<string, UserUsagePoint[]> = {};
  for (const row of rows) {
    const home = row.home_size_bytes;
    const data = row.data_size_bytes;
    if (home === null && data === null) {
      continue;
    }
    (series[String(row.username)] ??= []).push({
      at: row.collected_at,
      home,
      data,
      total: intOrZero(home) + intOrZero(data),
    });
  }

  if (maxPoints <= 0) {
    return series;
  }
  for (const [name, points] of Object.entries(series)) {
    if (points.length <= maxPoints) {
      continue;
    }
    const step = (points.length - 1) / (maxPoints - 1);
    const picked: UserUsagePoint[] = [];
    for (let index = 0; index < maxPoints; index += 1) {
      picked.push(points[pythonRound(index * step)]);
    }
    picked[0] = points[0];
    picked[picked.length - 1] = points[points.length - 1];
    series[name] = picked;
  }
  return series;
}

// --- user_operations --------------------------------------------------------

/** Appends one audit row for an account-provisioning attempt; returns its id. */
export function saveUserOperation(
  db: SqliteDatabase,
  hostName: string,
  account: string,
  operation: string,
  status: string,
  options: SaveUserOperationOptions = {},
): number {
  const moment = options.createdAt === null || options.createdAt === undefined
    ? nowIsoUtc()
    : toIsoUtc(options.createdAt);
  const finished = options.finishedAt === null || options.finishedAt === undefined
    ? nowIsoUtc()
    : toIsoUtc(options.finishedAt);
  const payload = dumpJson(options.steps ? [...options.steps] : []);

  const info = db.prepare(
    'INSERT INTO user_operations'
      + ' (created_at, finished_at, host_name, account, operation, status,'
      + '  actor, plan_hash, steps_json, error)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    moment,
    finished,
    hostName,
    account,
    operation,
    status,
    options.actor ?? '',
    options.planHash ?? '',
    payload,
    options.error ?? '',
  );
  return Number(info.lastInsertRowid);
}

/** Returns recent audit rows, newest first. */
export function listUserOperations(
  db: SqliteDatabase,
  options: ListUserOperationsOptions = {},
): UserOperation[] {
  let sql = 'SELECT * FROM user_operations';
  const params: unknown[] = [];
  if (options.hostName) {
    sql += ' WHERE host_name = ?';
    params.push(options.hostName);
  }
  const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 50), 200));
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as UserOperationRow[];
  return rows.map(decodeUserOperation);
}

// --- growth ranking ---------------------------------------------------------

/** Ranks accounts by total usage growth inside the window. Mirrors `top_user_growth`. */
export function topUserGrowth(
  db: SqliteDatabase,
  options: TopUserGrowthOptions = {},
): UserGrowthItem[] {
  const days = options.days ?? 7;
  const limit = options.limit ?? 8;
  if (limit <= 0) {
    return [];
  }
  const reference = parseInstant(momentString(options.now));
  const cutoff = shiftInstant(reference, -days * 86_400_000);

  let rows: Array<{
    host_name: string;
    username: string;
    collected_at: string;
    home_size_bytes: number | null;
    data_size_bytes: number | null;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT host_name, username, collected_at,
                home_size_bytes, data_size_bytes
           FROM host_user_usage_history
          WHERE collected_at >= ?
          ORDER BY host_name, username, collected_at`,
      )
      .all(cutoff) as typeof rows;
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) {
      return [];
    }
    throw err;
  }

  const buckets = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.home_size_bytes === null && row.data_size_bytes === null) {
      continue;
    }
    const key = `${row.host_name}\u0000${row.username}`;
    const list = buckets.get(key);
    if (list) {
      list.push(row);
    } else {
      buckets.set(key, [row]);
    }
  }

  const items: UserGrowthItem[] = [];
  for (const points of buckets.values()) {
    if (points.length < 2) {
      continue;
    }
    const first = points[0];
    const last = points[points.length - 1];
    const base = intOrZero(first.home_size_bytes) + intOrZero(first.data_size_bytes);
    const current = intOrZero(last.home_size_bytes) + intOrZero(last.data_size_bytes);
    const delta = current - base;
    if (delta <= 0) {
      continue;
    }
    items.push({
      host: first.host_name,
      account: first.username,
      delta,
      base,
      current,
      since: first.collected_at,
    });
  }
  items.sort((a, b) => b.delta - a.delta);
  return items.slice(0, limit);
}

// --- deletion ---------------------------------------------------------------

/** Deletes the snapshot, baseline and scan state of `hostName`. */
export function deleteHostUserData(db: SqliteDatabase, hostName: string): void {
  const deleteSnapshot = db.prepare('DELETE FROM host_user_snapshot WHERE host_name = ?');
  const deleteBaseline = db.prepare('DELETE FROM host_user_baseline WHERE host_name = ?');
  const deleteScanState = db.prepare('DELETE FROM host_user_scan_state WHERE host_name = ?');
  db.transaction(() => {
    deleteSnapshot.run(hostName);
    deleteBaseline.run(hostName);
    deleteScanState.run(hostName);
  })();
}
