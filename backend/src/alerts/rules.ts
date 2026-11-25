/**
 * Pure alert-rule functions — ported 1:1 from the Python oracle
 * `servermanage/alerts.py:73-585` (Task 3 of P4).
 *
 * This is the rule layer only: every function is pure (no I/O, no clock, no
 * network) so it is trivial to unit-test. The stateful dedupe/cooldown
 * `AlertEngine` (Task 6) lives in `./engine`.
 *
 * Semantics carried over from the oracle (iron laws):
 * - Threshold comparisons are inclusive (`>=`): a value *at* the threshold
 *   alerts.
 * - A `null` / missing metric is skipped, never coerced to `0` (an unknown
 *   value must not fabricate a `0%`-based alert).
 * - Fingerprints are the lower-cased, colon-joined parts so they stay stable
 *   across runs for the same logical condition.
 * - Availability alerts fire only for explicit `failed` / `error` checks (and
 *   are `critical`); `ok` / `unknown` never alert.
 * - All user-facing strings (titles/messages) are byte-for-byte identical to
 *   the Python f-strings, including `{:.1f}` and `{:g}` formatting.
 *
 * Numeric formatting note: Python's `f"{x:.1f}"` uses round-half-to-even on the
 * exact binary value, and `f"{x:g}"` is the C `%g` "general" format (6
 * significant digits, exponent when `exp < -4` or `exp >= precision`, trailing
 * zeros stripped). Both are reproduced below so message text matches exactly.
 */
import {
  roundHalfEven,
  type HostCheckResult,
  type HostMetrics,
  type HostUserAccount,
} from '../collect/types';

// ---------------------------------------------------------------------------
// Event / config types
// ---------------------------------------------------------------------------

/**
 * `AlertEvent` (`servermanage/disk_health.py:102-113`).
 *
 * Field names stay snake_case because the event is consumed verbatim by the
 * storage layer (`AlertEventInput`) and the alert templates, exactly like the
 * Python dataclass. `reasons` defaults to `[]` (kept for downstream dedupe so
 * the real signal — e.g. `media_errors` — is not lost in localized text).
 */
export interface AlertEvent {
  host_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  reasons: readonly string[];
}

/**
 * `AlertThresholds` (`servermanage/models.py:196-201`). Snake_case to mirror
 * the Python config object used by the templates and `/api/settings`.
 */
export interface AlertThresholds {
  cpu_percent: number;
  memory_percent: number;
  disk_percent: number;
  gpu_memory_percent: number;
  disk_temperature_c: number;
}

/**
 * Per-host threshold overrides (`servermanage/models.py:41-49` — `HostAlertRules`).
 * Any omitted / `null` field means "inherit the global value".
 */
export interface HostAlertRules {
  cpu_percent?: number | null;
  memory_percent?: number | null;
  disk_percent?: number | null;
  gpu_memory_percent?: number | null;
  disk_temperature_c?: number | null;
  consecutive_periods?: number | null;
}

/** Defaults matching `AlertThresholds()` (`models.py:196-201`). */
export const DEFAULT_ALERT_THRESHOLDS: Readonly<AlertThresholds> = Object.freeze({
  cpu_percent: 90,
  memory_percent: 90,
  disk_percent: 90,
  gpu_memory_percent: 90,
  disk_temperature_c: 55,
});

/** `servermanage/models.py:221` — default `alerts.offline_failures`. */
export const DEFAULT_OFFLINE_FAILURES = 2;

/**
 * One disk mount's usage status. Mirrors the dict surface Python reads in
 * `evaluate_system_alerts` (`status.get("present"/"percent"/"mountpoint")`).
 */
export interface DiskMountStatus {
  present?: unknown;
  percent?: number | string | null;
  mountpoint?: unknown;
}

/** `VirtualDriveInfo` (`servermanage/disk_health.py:60-67`) — minimal shape. */
export interface VirtualDriveInfo {
  controller: number;
  vd_id: number;
  raid_level?: string | null;
  state?: string | null;
  size?: string | null;
  health?: string | null;
  reasons?: readonly string[] | null;
}

/** `PhysicalDriveInfo` (`servermanage/disk_health.py:71-87`) — minimal shape. */
export interface PhysicalDriveInfo {
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
  health?: string | null;
  reasons?: readonly string[] | null;
}

/** `DiskHealthReport` (`servermanage/disk_health.py:90-98`) — minimal shape. */
export interface DiskHealthReport {
  host_name: string;
  collected_at?: string | Date | null;
  status?: string | null;
  message?: string | null;
  controllers?: readonly unknown[] | null;
  virtual_drives?: readonly VirtualDriveInfo[] | null;
  physical_drives?: readonly PhysicalDriveInfo[] | null;
}

// ---------------------------------------------------------------------------
// Python-compatible helpers
// ---------------------------------------------------------------------------

/** Python `str(value)` for the scalars encountered here (`None` -> `"None"`). */
function pyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

/**
 * Python `f"{x:.1f}"` — one decimal place, round-half-to-even on the exact
 * binary value (see `roundHalfEven`).
 */
function fixed1(value: number): string {
  return roundHalfEven(value, 1).toFixed(1);
}

/**
 * Python `f"{x:g}"` — C `%g` general format with the default precision of 6.
 *
 * Rounds to `precision` significant digits; uses exponent notation when the
 * decimal exponent is `< -4` or `>= precision`; strips trailing zeros and a
 * dangling decimal point.
 */
export function formatG(value: number, precision = 6): string {
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return value > 0 ? 'inf' : '-inf';
  }
  if (value === 0) {
    return '0';
  }
  const negative = value < 0;
  const abs = Math.abs(value);
  // Round to `precision` significant digits and read back the exponent.
  const exponential = abs.toExponential(precision - 1); // e.g. "9.01235e+1"
  const [mantissa, expText] = exponential.split('e');
  const exponent = Number(expText);

  let result: string;
  if (exponent < -4 || exponent >= precision) {
    let trimmed = mantissa.replace(/0+$/, '').replace(/\.$/, '');
    const sign = exponent < 0 ? '-' : '+';
    const digits = Math.abs(exponent).toString().padStart(2, '0');
    result = `${trimmed}e${sign}${digits}`;
  } else {
    const decimals = Math.max(0, precision - 1 - exponent);
    let fixed = abs.toFixed(decimals);
    if (fixed.includes('.')) {
      fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
    }
    result = fixed;
  }
  return negative ? `-${result}` : result;
}

/** Build an `AlertEvent`, defaulting `reasons` to the empty tuple. */
function makeEvent(
  fields: Omit<AlertEvent, 'reasons'> & { reasons?: readonly string[] },
): AlertEvent {
  return {
    host_name: fields.host_name,
    category: fields.category,
    severity: fields.severity,
    title: fields.title,
    message: fields.message,
    fingerprint: fields.fingerprint,
    reasons: fields.reasons ?? [],
  };
}

// ---------------------------------------------------------------------------
// fingerprint_for
// ---------------------------------------------------------------------------

/**
 * Join `parts` with `:` and lower-case the result (`alerts.py:75-82`).
 *
 * A fingerprint identifies one logical condition, e.g.
 * `system:gpu-01:cpu` or `disk:gpu-01:c0:e252:s3:media_errors`.
 */
export function fingerprintFor(...parts: string[]): string {
  return parts.map((part) => String(part)).join(':').toLowerCase();
}

// ---------------------------------------------------------------------------
// System metric rules
// ---------------------------------------------------------------------------

/** `alerts.py:88-95` — memory used percentage, or `null` when unknown. */
function memoryPercent(metrics: HostMetrics): number | null {
  const memory = metrics.memory;
  if (memory === null || memory === undefined || !memory.totalMb) {
    return null;
  }
  return (memory.usedMb / memory.totalMb) * 100;
}

/** `alerts.py:98-107` — aggregate GPU memory used percentage, or `null`. */
function gpuMemoryPercent(metrics: HostMetrics): number | null {
  const rows = metrics.gpuSummary ?? [];
  if (rows.length === 0) {
    return null;
  }
  const total = rows.reduce((sum, row) => sum + row.memoryTotalMb, 0);
  if (!total) {
    return null;
  }
  const used = rows.reduce((sum, row) => sum + row.memoryUsedMb, 0);
  return (used / total) * 100;
}

/** Options for {@link evaluateSystemAlerts} (Python keyword-only args). */
export interface EvaluateSystemAlertsOptions {
  /** Highest usage across real data filesystems (`alerts.py:110`). */
  diskPercent?: number | null;
  /** Per-mount usage rows; when supplied they take precedence over `diskPercent`. */
  diskMounts?: readonly DiskMountStatus[] | null;
}

/**
 * Build `warning` events for CPU / memory / disk / GPU over-utilisation
 * (`alerts.py:109-212`).
 *
 * `diskMounts` (when supplied) wins over `diskPercent`, exactly like the Python
 * `if disk_mounts is not None: ... elif disk_percent is not None: ...` branch.
 * A metric that is `null`/missing is skipped.
 */
export function evaluateSystemAlerts(
  hostName: string,
  metrics: HostMetrics,
  thresholds: AlertThresholds,
  options: EvaluateSystemAlertsOptions = {},
): AlertEvent[] {
  const events: AlertEvent[] = [];

  const cpu = metrics.cpuUsagePercent;
  if (cpu !== null && cpu !== undefined && cpu >= thresholds.cpu_percent) {
    events.push(
      makeEvent({
        host_name: hostName,
        category: 'system',
        severity: 'warning',
        title: 'CPU 使用率过高',
        message:
          `主机 ${hostName} CPU 使用率 ${fixed1(cpu)}% `
          + `达到阈值 ${formatG(thresholds.cpu_percent)}%`,
        fingerprint: fingerprintFor('system', hostName, 'cpu'),
      }),
    );
  }

  const memory = memoryPercent(metrics);
  if (
    memory !== null
    && memory !== undefined
    && memory >= thresholds.memory_percent
  ) {
    events.push(
      makeEvent({
        host_name: hostName,
        category: 'system',
        severity: 'warning',
        title: '内存使用率过高',
        message:
          `主机 ${hostName} 内存使用率 ${fixed1(memory)}% `
          + `达到阈值 ${formatG(thresholds.memory_percent)}%`,
        fingerprint: fingerprintFor('system', hostName, 'memory'),
      }),
    );
  }

  const { diskMounts, diskPercent } = options;
  if (diskMounts !== null && diskMounts !== undefined) {
    for (const status of diskMounts) {
      if (!status.present) {
        continue;
      }
      const rawPercent = status.percent;
      if (rawPercent === null || rawPercent === undefined) {
        continue;
      }
      const percent = Number(rawPercent);
      if (percent < thresholds.disk_percent) {
        continue;
      }
      const mountpoint = pyValue(status.mountpoint);
      events.push(
        makeEvent({
          host_name: hostName,
          category: 'system',
          severity: 'warning',
          title: '磁盘使用率过高',
          message:
            `主机 ${hostName} 挂载点 ${mountpoint} 磁盘使用率 `
            + `${fixed1(percent)}% 达到阈值 ${formatG(thresholds.disk_percent)}%`,
          fingerprint: fingerprintFor('system', hostName, 'disk', mountpoint),
        }),
      );
    }
  } else if (
    diskPercent !== null
    && diskPercent !== undefined
    && diskPercent >= thresholds.disk_percent
  ) {
    events.push(
      makeEvent({
        host_name: hostName,
        category: 'system',
        severity: 'warning',
        title: '磁盘使用率过高',
        message:
          `主机 ${hostName} 磁盘使用率 ${fixed1(diskPercent)}% `
          + `达到阈值 ${formatG(thresholds.disk_percent)}%`,
        fingerprint: fingerprintFor('system', hostName, 'disk'),
      }),
    );
  }

  const gpu = gpuMemoryPercent(metrics);
  if (
    gpu !== null
    && gpu !== undefined
    && gpu >= thresholds.gpu_memory_percent
  ) {
    events.push(
      makeEvent({
        host_name: hostName,
        category: 'system',
        severity: 'warning',
        title: 'GPU 显存占用过高',
        message:
          `主机 ${hostName} GPU 显存占用 ${fixed1(gpu)}% `
          + `达到阈值 ${formatG(thresholds.gpu_memory_percent)}%`,
        fingerprint: fingerprintFor('system', hostName, 'gpu_memory'),
      }),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// effective_thresholds
// ---------------------------------------------------------------------------

/**
 * Resolve a host's effective alert thresholds (`alerts.py:215-262`).
 *
 * `globalT` may be an {@link AlertThresholds} object (the configured global
 * thresholds) or a single scalar used for every field. Any non-`null` field on
 * `hostRules` overrides the matching global value; `null`/missing means inherit.
 */
export function effectiveThresholds(
  globalT: AlertThresholds | number = 90,
  hostRules?: HostAlertRules | null,
): AlertThresholds {
  let base: AlertThresholds;
  if (typeof globalT === 'number') {
    const value = globalT;
    base = {
      cpu_percent: value,
      memory_percent: value,
      disk_percent: value,
      gpu_memory_percent: value,
      disk_temperature_c: value,
    };
  } else {
    base = {
      cpu_percent: globalT.cpu_percent,
      memory_percent: globalT.memory_percent,
      disk_percent: globalT.disk_percent,
      gpu_memory_percent: globalT.gpu_memory_percent,
      disk_temperature_c: globalT.disk_temperature_c,
    };
  }

  if (hostRules === null || hostRules === undefined) {
    return base;
  }

  const fields: (keyof AlertThresholds)[] = [
    'cpu_percent',
    'memory_percent',
    'disk_percent',
    'gpu_memory_percent',
    'disk_temperature_c',
  ];
  const result: AlertThresholds = { ...base };
  let changed = false;
  for (const field of fields) {
    const value = hostRules[field];
    if (value !== null && value !== undefined) {
      result[field] = value;
      changed = true;
    }
  }
  return changed ? result : base;
}

// ---------------------------------------------------------------------------
// Availability (service check) rules
// ---------------------------------------------------------------------------

/** `alerts.py:269` — statuses that mean a configured check was not satisfied. */
const AVAILABILITY_FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'error',
]);

/**
 * Build `critical` events for failed service checks (`alerts.py:272-315`).
 *
 * Only explicit `failed` / `error` results alert. `ok` and `unknown` are
 * healthy/indeterminate — a dropped-offline host gets `unknown` and must not
 * masquerade as a service failure.
 */
export function evaluateAvailabilityAlerts(
  hostName: string,
  results: readonly HostCheckResult[],
): AlertEvent[] {
  const events: AlertEvent[] = [];
  for (const result of results) {
    const status = String(result.status ?? '').trim().toLowerCase();
    if (!AVAILABILITY_FAILURE_STATUSES.has(status)) {
      continue;
    }
    const name = String(result.name ?? '');
    const checkType = String(result.type ?? '');
    const target = String(result.target ?? '');
    const message = String(result.message ?? '');
    events.push(
      makeEvent({
        host_name: hostName,
        category: 'availability',
        severity: 'critical',
        title: `服务检查失败：${name}`,
        message:
          `主机 ${hostName} 服务检查 ${name}（类型 ${checkType}，`
          + `目标 ${target}）失败：${message}`,
        fingerprint: fingerprintFor('availability', hostName, name),
      }),
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// User account rules
// ---------------------------------------------------------------------------

/** Options for {@link evaluateUserAlerts} (Python keyword-only args). */
export interface EvaluateUserAlertsOptions {
  /** Whether the account already belongs to the monitoring baseline. */
  inBaseline: boolean;
  /** Whether the account is in the baseline but absent from the snapshot. */
  missing: boolean;
}

/**
 * Build `warning` events for a lab account on one host (`alerts.py:319-440`).
 *
 * Two kinds of `category="user"` / `severity="warning"` event are produced:
 * - **Transition** — `user-added` fires only for a first-seen account
 *   (`!inBaseline`) that is not a still-firing condition; callers must exclude
 *   it from automatic resolution.
 * - **State** — `user-docker` / `user-home` / `user-data` / `user-config` fire
 *   while the condition holds and vanish once fixed.
 *
 * `missing` means the account is in the baseline but absent from the current
 * snapshot; directory/group data is frozen at last-known values so only
 * `user-present` is emitted (judging stale data would raise false alarms).
 * Directory-owner checks only run for existing dirs, and `/data` checks are
 * skipped when the host has no `/data` (`dataSupported === false`).
 */
export function evaluateUserAlerts(
  account: HostUserAccount,
  options: EvaluateUserAlertsOptions,
): AlertEvent[] {
  const hostName = account.hostName;
  const username = account.username;

  const event = (kind: string, title: string, message: string): AlertEvent =>
    makeEvent({
      host_name: hostName,
      category: 'user',
      severity: 'warning',
      title,
      message,
      fingerprint: fingerprintFor(kind, hostName, username),
    });

  if (options.missing) {
    return [
      event(
        'user-present',
        '账号缺失',
        `主机 ${hostName} 的账号 ${username} 已从当前快照中消失，`
          + '但仍在监控基线中',
      ),
    ];
  }

  const events: AlertEvent[] = [];

  if (!options.inBaseline) {
    events.push(
      event(
        'user-added',
        '发现新账号',
        `主机 ${hostName} 发现新账号 ${username}，已加入监控基线`,
      ),
    );
  }

  if (!account.inDocker) {
    events.push(
      event(
        'user-docker',
        '未加入 docker 组',
        `主机 ${hostName} 的账号 ${username} 未加入 docker 组`,
      ),
    );
  }

  const homePath = account.home || `/home/${username}`;
  if (!account.homeExists) {
    events.push(
      event(
        'user-home',
        '家目录缺失',
        `主机 ${hostName} 的账号 ${username} 家目录 ${homePath} 不存在`,
      ),
    );
  }

  const dataPath = `/data/${username}`;
  if (account.dataSupported && !account.dataExists) {
    events.push(
      event(
        'user-data',
        '数据目录缺失',
        `主机 ${hostName} 的账号 ${username} 数据目录 ${dataPath} 不存在`,
      ),
    );
  }

  // An unreadable owner (`null` => stat failed) is not a mismatch: alerting on
  // it would claim "owner is 未知" for a directory we simply cannot read.
  const homeOwnerBad = Boolean(
    account.homeExists && account.homeOwner && account.homeOwner !== username,
  );
  const dataOwnerBad = Boolean(
    account.dataSupported
      && account.dataExists
      && account.dataOwner
      && account.dataOwner !== username,
  );
  if (homeOwnerBad || dataOwnerBad) {
    const details: string[] = [];
    if (homeOwnerBad) {
      details.push(
        `家目录 ${homePath} 所有者为 ${account.homeOwner || '未知'}`,
      );
    }
    if (dataOwnerBad) {
      details.push(
        `数据目录 ${dataPath} 所有者为 ${account.dataOwner || '未知'}`,
      );
    }
    events.push(
      event(
        'user-config',
        '目录所有者异常',
        `主机 ${hostName} 的账号 ${username} `
          + details.join('；')
          + `，应为 ${username}`,
      ),
    );
  }

  return events;
}

// ---------------------------------------------------------------------------
// Disk rules
// ---------------------------------------------------------------------------

/**
 * Stable identity parts for one physical drive (`alerts.py:447-459`).
 *
 * Prefer controller/enclosure/slot; fall back to the device id (`did`) when the
 * drive has no slot, and finally to the controller alone.
 */
function driveIdentity(drive: PhysicalDriveInfo): string[] {
  if (drive.slot !== null && drive.slot !== undefined) {
    return [
      `c${drive.controller}`,
      `e${pyValue(drive.enclosure)}`,
      `s${drive.slot}`,
    ];
  }
  if (drive.did !== null && drive.did !== undefined) {
    return [`c${drive.controller}`, `did${drive.did}`];
  }
  return [`c${drive.controller}`];
}

/** Human-readable location such as `c0/e252/s3` (`alerts.py:462-468`). */
function driveLocation(drive: PhysicalDriveInfo): string {
  if (drive.slot !== null && drive.slot !== undefined) {
    return `c${drive.controller}/e${pyValue(drive.enclosure)}/s${drive.slot}`;
  }
  if (drive.did !== null && drive.did !== undefined) {
    return `c${drive.controller}/did${drive.did}`;
  }
  return `c${drive.controller}`;
}

/** Compose the physical-drive alert message (`alerts.py:471-482`). */
function driveMessage(drive: PhysicalDriveInfo): string {
  const health = drive.health ?? 'unknown';
  const parts = [`物理盘 ${driveLocation(drive)} 健康状态 ${health}`];
  const reasons = drive.reasons ?? [];
  if (reasons.length > 0) {
    parts.push(`原因：${reasons.join(', ')}`);
  }
  if (drive.state) {
    parts.push(`状态 ${drive.state}`);
  }
  if (drive.model) {
    parts.push(`型号 ${drive.model}`);
  }
  if (drive.serial) {
    parts.push(`序列号 ${drive.serial}`);
  }
  return parts.join('；');
}

/** `alerts.py:485-501` — one physical-drive alert. */
function physicalDriveAlert(
  hostName: string,
  drive: PhysicalDriveInfo,
): AlertEvent {
  const reasons = drive.reasons ?? [];
  const reason = reasons.length > 0 ? reasons[0] : 'unknown';
  const health = drive.health ?? 'unknown';
  return makeEvent({
    host_name: hostName,
    category: 'disk',
    severity: health,
    title: `磁盘 ${hostName} ${driveLocation(drive)} 异常`,
    message: driveMessage(drive),
    fingerprint: fingerprintFor('disk', hostName, ...driveIdentity(drive), reason),
    reasons,
  });
}

/** `alerts.py:504-527` — one virtual-drive alert. */
function virtualDriveAlert(
  hostName: string,
  vd: VirtualDriveInfo,
): AlertEvent {
  const reasons = vd.reasons ?? [];
  const reason = reasons.length > 0 ? reasons[0] : 'unknown';
  const health = vd.health ?? 'unknown';
  const details = [`虚拟盘 c${vd.controller}/vd${vd.vd_id} 健康状态 ${health}`];
  if (vd.raid_level) {
    details.push(`RAID ${vd.raid_level}`);
  }
  if (vd.state) {
    details.push(`状态 ${vd.state}`);
  }
  if (reasons.length > 0) {
    details.push(`原因：${reasons.join(', ')}`);
  }
  return makeEvent({
    host_name: hostName,
    category: 'disk',
    severity: health,
    title: `虚拟磁盘 ${hostName} c${vd.controller}/vd${vd.vd_id} 异常`,
    message: details.join('；'),
    fingerprint: fingerprintFor(
      'disk',
      hostName,
      `c${vd.controller}`,
      `vd${vd.vd_id}`,
      reason,
    ),
    reasons,
  });
}

/** `alerts.py:530-539` — non-`ok` report status alert. */
function statusAlert(report: DiskHealthReport): AlertEvent {
  const status = report.status ?? 'ok';
  const message =
    report.message || `主机 ${report.host_name} 磁盘健康检查状态：${status}`;
  return makeEvent({
    host_name: report.host_name,
    category: 'disk',
    severity: 'warning',
    title: `磁盘健康检查异常（${report.host_name}）`,
    message,
    fingerprint: fingerprintFor('disk', report.host_name, 'status', status),
  });
}

/**
 * Derive alert events from one disk-health report (`alerts.py:542-575`).
 *
 * - Every physical drive whose `health` is `warning`/`critical` yields an event
 *   (severity mirrors the drive health).
 * - Every virtual drive whose `health` is `warning`/`critical` yields an event.
 * - A non-`ok` report status (`permission_denied` / `no_storcli` /
 *   `no_controller` / `error` / `degraded`) yields an event: a host whose disk
 *   health cannot be checked is itself a maintenance risk, not silence.
 */
export function evaluateDiskAlerts(report: DiskHealthReport): AlertEvent[] {
  const hostName = report.host_name;
  const events: AlertEvent[] = [];

  if ((report.status ?? 'ok') !== 'ok') {
    events.push(statusAlert(report));
  }

  for (const drive of report.physical_drives ?? []) {
    if (drive.health === 'warning' || drive.health === 'critical') {
      events.push(physicalDriveAlert(hostName, drive));
    }
  }

  for (const vd of report.virtual_drives ?? []) {
    if (vd.health === 'warning' || vd.health === 'critical') {
      events.push(virtualDriveAlert(hostName, vd));
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// Host reachability rules
// ---------------------------------------------------------------------------

/** Event for a host that has failed `failures` consecutive collections. */
export function offlineAlert(hostName: string, failures: number): AlertEvent {
  return makeEvent({
    host_name: hostName,
    category: 'offline',
    severity: 'critical',
    title: `主机 ${hostName} 离线`,
    message: `主机 ${hostName} 连续 ${failures} 次采集失败，判定为离线。`,
    fingerprint: fingerprintFor('offline', hostName),
  });
}

/** Informational event announcing that a host condition has recovered. */
export function recoveryEvent(hostName: string, category: string): AlertEvent {
  return makeEvent({
    host_name: hostName,
    category,
    severity: 'info',
    title: `主机 ${hostName} ${category} 告警恢复`,
    message: `主机 ${hostName} 的 ${category} 告警已恢复。`,
    fingerprint: fingerprintFor('recovery', hostName, category),
  });
}
