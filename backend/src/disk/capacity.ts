/**
 * Per-mount disk-capacity status helpers.
 *
 * Ported 1:1 from the Python oracle `servermanage/disk_capacity.py:32-138`:
 *
 * - `normalize_mounts` (`disk_capacity.py:32`)  -> {@link normalizeMounts}
 * - `mount_statuses`  (`disk_capacity.py:71`)  -> {@link mountStatuses}
 * - `max_percent`     (`disk_capacity.py:126`) -> {@link maxPercent}
 * - `_row_value`      (`disk_capacity.py:49`)  -> internal `rowValue`
 * - `_parse_percent`  (`disk_capacity.py:55`)  -> internal `parsePercent`
 *
 * The monitoring feature lets each host declare the mount points whose
 * capacity should be tracked (`HostConfig.disk_mounts`).  These helpers turn
 * the raw `DiskUsageRow` data into a normalised, per-mount view so the
 * collector, the alert engine and the web dashboard all agree on what "the
 * disk usage" is.
 *
 * Adaptations vs. the Python oracle (called out here and at each call site):
 *
 * - **`status` field + `opts.thresholds`**: the Python `mount_statuses` dict
 *   has no verdict, only the raw numbers (the alert engine applies the single
 *   `disk_percent` threshold itself).  The P5 Task-2 plan asks for a per-mount
 *   `status` so the dashboard can render one, so {@link mountStatuses} adds a
 *   `status` field and an optional `{ thresholds?: { warning?, critical? } }`.
 *   Callers that want the exact Python dict can ignore `status`; the six data
 *   fields (`mountpoint`/`present`/`filesystem`/`size`/`used`/`available`/
 *   `percent`) are byte-for-byte the Python keys.
 * - **Field naming**: Python field names that are a single word are kept as
 *   is (`mountpoint`, `filesystem`, `size`, `used`, `available`, `percent`,
 *   `present`) — matching the sibling P3 `DiskUsageRow` (`collect/types.ts`)
 *   and the `DiskMountStatus` read by `alerts/rules.ts`.  Function/parameter
 *   names follow the usual snake_case -> camelCase rename (`normalize_mounts`
 *   -> `normalizeMounts`, `max_percent` -> `maxPercent`).
 * - **Percent parsing**: Python `_parse_percent` keeps only digits and `.`
 *   then calls `float()` (raising `ValueError` -> `None` on malformed input
 *   such as `"12.5.6"`).  {@link parsePercent} reproduces that with
 *   `Number(digits)` (whose `NaN` on malformed input matches `float()`'s
 *   `ValueError`), *not* `parseFloat`, which would silently accept `"12.5.6"`
 *   as `12.5`.
 */

/** `DEFAULT_DISK_MOUNTS` (`disk_capacity.py:14`) — used when none configured. */
export const DEFAULT_DISK_MOUNTS: readonly string[] = ['/', '/data'];

/**
 * Filesystems that do not represent real, monitored capacity
 * (`VIRTUAL_FILESYSTEMS`, `disk_capacity.py:17`).  Rows backed by one of these
 * are treated as absent so they never raise a capacity alert.
 */
export const VIRTUAL_FILESYSTEMS: ReadonlySet<string> = new Set([
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

/**
 * The subset of a raw disk-usage row these helpers read.  A P3
 * {@link DiskUsageRow} satisfies it structurally; plain objects (the Python
 * `dict` path of `_row_value`) satisfy it too.  Every field is `unknown`
 * because the oracle passes values through untouched and only `percent` is
 * coerced.
 */
export interface DiskUsageRowLike {
  mountpoint?: unknown;
  filesystem?: unknown;
  size?: unknown;
  used?: unknown;
  available?: unknown;
  percent?: unknown;
}

/** Per-mount verdict produced by {@link mountStatuses}. */
export type MountStatusLevel = 'ok' | 'warning' | 'critical' | 'missing' | 'unknown';

/** Threshold set for {@link mountStatuses} (additive P5 extension, not Python). */
export interface MountStatusThresholds {
  /** Usage at/above which a present mount is `warning`. Defaults to `90`. */
  warning?: number;
  /** Usage at/above which a present mount is `critical`. Defaults to `95`. */
  critical?: number;
}

/** Options for {@link mountStatuses}. */
export interface MountStatusOptions {
  /** Usage thresholds used to classify a present mount's `status`. */
  thresholds?: MountStatusThresholds;
}

/**
 * One entry per configured mount point.  Mirrors the Python dict returned by
 * `mount_statuses` (`disk_capacity.py:112`) and adds a `status` verdict.
 */
export interface MountStatus {
  mountpoint: string;
  present: boolean;
  filesystem: unknown;
  size: unknown;
  used: unknown;
  available: unknown;
  percent: number | null;
  status: MountStatusLevel;
}

/** Default `warning` threshold — the Python oracle's `disk_percent` default. */
const DEFAULT_WARNING_THRESHOLD = 90;
/** Default `critical` threshold (extension; Python has no second tier). */
const DEFAULT_CRITICAL_THRESHOLD = 95;

/**
 * `normalize_mounts` (`disk_capacity.py:32`): a clean, de-duplicated list of
 * mount points.  `null`/`undefined` or an empty sequence falls back to
 * {@link DEFAULT_DISK_MOUNTS}; entries are stringified, trimmed, blanks and
 * duplicates dropped, order preserved.  If every entry is blank the defaults
 * are returned too (`return result or list(DEFAULT_DISK_MOUNTS)`).
 */
export function normalizeMounts(
  mounts: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  if (!mounts || mounts.length === 0) {
    return [...DEFAULT_DISK_MOUNTS];
  }
  const result: string[] = [];
  for (const mount of mounts) {
    if (mount === null || mount === undefined) {
      continue;
    }
    const text = String(mount).trim();
    if (text && !result.includes(text)) {
      result.push(text);
    }
  }
  return result.length > 0 ? result : [...DEFAULT_DISK_MOUNTS];
}

/**
 * `_row_value` (`disk_capacity.py:49`): read `key` off a row that may be a
 * plain object (Python `dict.get`) or a class instance (Python `getattr`).
 * In JavaScript both are ordinary property reads; a non-object (e.g. `null`)
 * yields `undefined`, matching Python's missing-attribute default of `None`.
 */
function rowValue(row: unknown, key: string): unknown {
  if (row === null || typeof row !== 'object') {
    return undefined;
  }
  return (row as Record<string, unknown>)[key];
}

/**
 * `_parse_percent` (`disk_capacity.py:55`): parse an `int`/`float`/`"95%"`-style
 * value into a float.  `None`/`null`/booleans -> `null`; numbers pass through;
 * anything else is stringified, stripped to `[0-9.]`, and `Number()`-parsed
 * (empty or malformed -> `null`).
 */
function parsePercent(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  const text = String(value).trim();
  let digits = '';
  for (const ch of text) {
    if ((ch >= '0' && ch <= '9') || ch === '.') {
      digits += ch;
    }
  }
  if (!digits) {
    return null;
  }
  const parsed = Number(digits);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Classify a present mount's usage against the (defaulted) thresholds. */
function classifyStatus(percent: number | null, thresholds: MountStatusThresholds | undefined): MountStatusLevel {
  if (percent === null) {
    return 'unknown';
  }
  const warning = thresholds?.warning ?? DEFAULT_WARNING_THRESHOLD;
  const critical = thresholds?.critical ?? DEFAULT_CRITICAL_THRESHOLD;
  if (percent >= critical) {
    return 'critical';
  }
  if (percent >= warning) {
    return 'warning';
  }
  return 'ok';
}

/**
 * `mount_statuses` (`disk_capacity.py:71`): build one status entry per
 * configured mount point.
 *
 * Every configured mount appears in the result, in the configured order,
 * whether or not it was reported.  A missing mount has `present` `false`, all
 * values `null` and `status: 'missing'`.  Rows backed by a virtual filesystem
 * (for example `tmpfs` mounted at `/`) are treated as absent so they never
 * raise a capacity alert.  When the same mount is reported more than once the
 * first non-virtual row wins.
 *
 * `opts.thresholds` (additive, see the file header) drives the `status`
 * verdict; it never affects the six data fields.
 */
export function mountStatuses(
  rows: readonly DiskUsageRowLike[] | null | undefined,
  mounts: readonly (string | null | undefined)[] | null | undefined,
  opts?: MountStatusOptions,
): MountStatus[] {
  const orderedMounts = normalizeMounts(mounts);
  const thresholds = opts?.thresholds;

  const indexed = new Map<string, DiskUsageRowLike>();
  for (const row of rows ?? []) {
    const mountpoint = rowValue(row, 'mountpoint');
    if (mountpoint === null || mountpoint === undefined) {
      continue;
    }
    const filesystem = rowValue(row, 'filesystem');
    if (filesystem !== null && filesystem !== undefined && VIRTUAL_FILESYSTEMS.has(String(filesystem))) {
      continue;
    }
    const key = String(mountpoint);
    if (!indexed.has(key)) {
      indexed.set(key, row);
    }
  }

  const statuses: MountStatus[] = [];
  for (const mountpoint of orderedMounts) {
    const row = indexed.get(mountpoint);
    if (row === undefined) {
      statuses.push({
        mountpoint,
        present: false,
        filesystem: null,
        size: null,
        used: null,
        available: null,
        percent: null,
        status: 'missing',
      });
      continue;
    }
    const percent = parsePercent(rowValue(row, 'percent'));
    statuses.push({
      mountpoint,
      present: true,
      filesystem: rowValue(row, 'filesystem') ?? null,
      size: rowValue(row, 'size') ?? null,
      used: rowValue(row, 'used') ?? null,
      available: rowValue(row, 'available') ?? null,
      percent,
      status: classifyStatus(percent, thresholds),
    });
  }
  return statuses;
}

/**
 * `max_percent` (`disk_capacity.py:126`): highest usage percentage among the
 * configured, present mounts (mounts missing a usable `percent` are ignored).
 * Returns `null` when no mount qualifies.
 */
export function maxPercent(
  rows: readonly DiskUsageRowLike[] | null | undefined,
  mounts: readonly (string | null | undefined)[] | null | undefined,
): number | null {
  const values: number[] = [];
  for (const status of mountStatuses(rows, mounts)) {
    if (status.present && status.percent !== null) {
      values.push(status.percent);
    }
  }
  return values.length > 0 ? Math.max(...values) : null;
}
