/**
 * Collection-layer data model — ported 1:1 from the Python oracle
 * `servermanage/models.py` (the collection dataclasses around lines 284-540).
 *
 * Conventions:
 * - Every Python field name is camelCased (`load_1` -> `load1`,
 *   `buff_cache_mb` -> `buffCacheMb`, ...).
 * - Every `X | None` field becomes `X | null` (never optional/`undefined`).
 * - Timestamps are ISO-8601 UTC strings of the exact shape
 *   `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` produced by `nowIsoUtc()` — the JSON
 *   form of Python's `datetime` — never `Date.prototype.toISOString()` shape.
 *
 * `emptyHostMetrics()` reproduces `HostMetrics()`'s `field(default_factory=...)`
 * defaults. The remaining record types carry only trivial Python defaults
 * (`None` / `""` / `[]` / `False`), which callers supply directly.
 */

/** `servermanage/models.py:284-289` — `LoadAverage`. Frozen; all required. */
export interface LoadAverage {
  load1: number;
  load5: number;
  load15: number;
}

/** `servermanage/models.py:292-302` — `MemorySummary`. All required ints. */
export interface MemorySummary {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  sharedMb: number;
  buffCacheMb: number;
  availableMb: number;
  swapTotalMb: number;
  swapUsedMb: number;
  swapFreeMb: number;
}

/** `servermanage/models.py:305-311` — `DiskUsageRow`. All required strings. */
export interface DiskUsageRow {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  percent: string;
  mountpoint: string;
}

/**
 * `servermanage/models.py:314-319` — `LoggedInUser`.
 * `remote_host` defaults to `None` in Python.
 */
export interface LoggedInUser {
  username: string;
  terminal: string;
  loginAt: string;
  remoteHost: string | null;
}

/**
 * `servermanage/models.py:322-327` — `UserProcessCount`.
 * `container_id` / `container_name` default to `None`.
 */
export interface UserProcessCount {
  username: string;
  count: number;
  containerId: string | null;
  containerName: string | null;
}

/**
 * `servermanage/models.py:330-339` — `ProcessRow`.
 * `container_id` / `container_name` default to `None`.
 */
export interface ProcessRow {
  username: string;
  pid: number;
  cpuPercent: number;
  memPercent: number;
  elapsed: string;
  command: string;
  containerId: string | null;
  containerName: string | null;
}

/**
 * `servermanage/models.py:342-348` — `GPUSummaryRow`.
 * `temperature_c` is `int | None` with no default, so it is a required field
 * whose value may be `null`.
 */
export interface GPUSummaryRow {
  index: number;
  name: string;
  utilizationPercent: number;
  temperatureC: number | null;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

/**
 * `servermanage/models.py:351-356` — `GPUProcessRow`.
 * `username` is `str | None` with no default (required, may be `null`).
 */
export interface GPUProcessRow {
  index: number;
  pid: number;
  username: string | null;
  memoryUsedMb: number;
  command: string;
}

/** `servermanage/models.py:359-363` — `ThermalZone`. Both fields required. */
export interface ThermalZone {
  label: string;
  celsius: number;
}

/**
 * `servermanage/models.py:366-372` — `ContainerInfo`.
 * `image` / `state` / `status` default to `""`.
 */
export interface ContainerInfo {
  name: string;
  image: string;
  state: string;
  status: string;
}

/**
 * `servermanage/models.py:380-401` — `HostMetrics`.
 *
 * Every field mirrors the Python dataclass; nullable fields default to `null`
 * and list fields default to empty arrays (see `emptyHostMetrics()`).
 */
export interface HostMetrics {
  hostname: string | null;
  osPrettyName: string | null;
  kernelVersion: string | null;
  uptime: string | null;
  collectedAt: string | null;
  loadAverage: LoadAverage | null;
  cpuCoreCount: number | null;
  cpuUsagePercent: number | null;
  memory: MemorySummary | null;
  diskUsage: DiskUsageRow[];
  loggedInUsers: LoggedInUser[];
  totalProcesses: number | null;
  processCountsByUser: UserProcessCount[];
  topCpuProcesses: ProcessRow[];
  topMemoryProcesses: ProcessRow[];
  gpuSummary: GPUSummaryRow[];
  gpuProcesses: GPUProcessRow[];
  netRxBytes: number | null;
  netTxBytes: number | null;
  containers: ContainerInfo[];
  thermalZones: ThermalZone[];
}

/** Fresh `HostMetrics` matching Python `HostMetrics()` defaults. */
export function emptyHostMetrics(): HostMetrics {
  return {
    hostname: null,
    osPrettyName: null,
    kernelVersion: null,
    uptime: null,
    collectedAt: null,
    loadAverage: null,
    cpuCoreCount: null,
    cpuUsagePercent: null,
    memory: null,
    diskUsage: [],
    loggedInUsers: [],
    totalProcesses: null,
    processCountsByUser: [],
    topCpuProcesses: [],
    topMemoryProcesses: [],
    gpuSummary: [],
    gpuProcesses: [],
    netRxBytes: null,
    netTxBytes: null,
    containers: [],
    thermalZones: [],
  };
}

/**
 * `servermanage/models.py:416-453` — `HostUserAccount`.
 *
 * Included because `HostReport.users` (models.py:476) is typed
 * `list[HostUserAccount]`; without it `HostReport` cannot be modelled 1:1.
 * `primary_group`, `home_*` and `data_*` metadata default to `None`;
 * `groups` defaults to `[]`; the booleans default to their Python literals;
 * `collected_at` defaults to `datetime.now(timezone.utc)` (caller supplies the
 * `nowIsoUtc()` string); `state` defaults to `"present"`.
 */
export interface HostUserAccount {
  hostName: string;
  username: string;
  uid: number;
  gid: number;
  primaryGroup: string | null;
  gecos: string;
  home: string;
  shell: string;
  groups: string[];
  inDocker: boolean;
  inSudo: boolean;
  homeExists: boolean;
  homeOwner: string | null;
  homeGroup: string | null;
  homeMode: string | null;
  homeSizeBytes: number | null;
  dataExists: boolean;
  dataOwner: string | null;
  dataGroup: string | null;
  dataMode: string | null;
  dataSizeBytes: number | null;
  dataSupported: boolean;
  usageReadable: boolean;
  usageStale: boolean;
  usageCollectedAt: string | null;
  collectedAt: string;
  state: string;
}

/** `servermanage/models.py:472-475` — `HostCollectionError`. */
export interface HostCollectionError {
  stage: string;
  message: string;
}

/**
 * `servermanage/models.py:53-62` — `HostCheckResult`.
 * `latency_ms` / `checked_at` default to `None`.
 */
export interface HostCheckResult {
  name: string;
  type: string;
  target: string;
  status: string;
  message: string;
  latencyMs: number | null;
  checkedAt: string | null;
}

/**
 * `servermanage/models.py:478-486` — `HostReport`.
 * `metrics` defaults to `HostMetrics()`; `errors` / `checks` / `users`
 * default to empty arrays.
 */
export interface HostReport {
  hostName: string;
  host: string;
  success: boolean;
  metrics: HostMetrics;
  errors: HostCollectionError[];
  checks: HostCheckResult[];
  users: HostUserAccount[];
}

/** `servermanage/models.py:568-571` — `CommandResult` (camelCase `exitStatus`). */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitStatus: number;
}

// ---------------------------------------------------------------------------
// Python-compatible rounding
// ---------------------------------------------------------------------------

const FLOAT64 = new DataView(new ArrayBuffer(8));

/**
 * Decomposes a finite non-zero double into the exact value `mantissa * 2^exponent`
 * (sign folded into `mantissa`) so decimal rounding can be done without the
 * precision loss of `x * 10 ** digits`.
 */
function decompose(x: number): { mantissa: bigint; exponent: number } {
  FLOAT64.setFloat64(0, x);
  const high = FLOAT64.getUint32(0);
  const low = FLOAT64.getUint32(4);
  const negative = (high >>> 31) === 1;
  const rawExponent = (high >>> 20) & 0x7ff;
  let mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low);
  let exponent: number;
  if (rawExponent === 0) {
    // Subnormal: no implicit leading 1.
    exponent = -1074;
  } else {
    mantissa |= 1n << 52n; // restore the implicit leading 1
    exponent = rawExponent - 1075;
  }
  return { mantissa: negative ? -mantissa : mantissa, exponent };
}

/**
 * Python 3 `round(value, digits)` for a float — round-half-to-even
 * (banker's rounding), computed on the *exact* binary value so results match
 * CPython for values where the naive `roundHalfEven(x * 10) / 10` trick
 * drifts (e.g. `0.15 -> 0.1`, `2.675 -> 2.67`, `41.15 -> 41.1`).
 *
 * Equivalent to rounding the exact rational `value * 10^digits` to the nearest
 * integer with ties going to the even neighbour, then dividing by `10^digits`.
 * `digits` must be a non-negative integer.
 */
export function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x) || x === 0) {
    return x;
  }
  if (!Number.isInteger(digits) || digits < 0) {
    throw new RangeError('roundHalfEven expects a non-negative integer digits');
  }

  const { mantissa, exponent } = decompose(x);
  const scale = 10n ** BigInt(digits);
  // Exact value of x * 10^digits, sign preserved.
  const scaled = mantissa * scale;
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;

  let rounded: bigint;
  if (exponent >= 0) {
    // x * 10^digits is already an integer.
    rounded = magnitude << BigInt(exponent);
  } else {
    const divisor = 1n << BigInt(-exponent);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    const twiceRemainder = 2n * remainder;
    if (twiceRemainder > divisor) {
      rounded = quotient + 1n;
    } else if (twiceRemainder < divisor) {
      rounded = quotient;
    } else {
      // Exact half — round to the even neighbour (banker's rounding).
      rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
    }
  }

  const signed = negative ? -rounded : rounded;
  return Number(signed) / 10 ** digits;
}

// ---------------------------------------------------------------------------
// Derived metrics
// ---------------------------------------------------------------------------

/**
 * Port of `HostMetrics.hottest_temperature_c` (`models.py:403-413`).
 *
 * Highest CPU/board/GPU temperature in the collection, rounded to 1 decimal
 * with Python's banker's rounding; `null` when nothing was measured.
 *
 * Faithful to the oracle's filters: thermal readings use Python truthiness
 * (`if zone.celsius` — a `0.0` zone is skipped), while GPU rows use
 * `if row.temperature_c is not None` (a `0` GPU temperature is kept).
 */
export function hottestTemperatureC(m: HostMetrics): number | null {
  const values: number[] = [];
  for (const zone of m.thermalZones ?? []) {
    if (zone.celsius) {
      values.push(zone.celsius);
    }
  }
  for (const row of m.gpuSummary ?? []) {
    if (row.temperatureC !== null) {
      values.push(Number(row.temperatureC));
    }
  }
  if (values.length === 0) {
    return null;
  }
  return roundHalfEven(Math.max(...values), 1);
}
