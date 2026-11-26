/**
 * 1:1 port of the report *context builders* in `servermanage/report.py`
 * (lines 28-497). These functions turn an already-constructed `DailyReport`
 * / `WeeklyReport` into the dictionaries consumed by the (Task 10) templates.
 *
 * Everything is a per-character transcription, including Python's
 * round-half-to-even `round(x, 1)` (via `roundHalfEven`) and `f"{x:.1f}"`
 * formatting (via `fixed1`). The weekly chart helpers delegate to
 * `./svg.ts`, which reproduces CPython's float rendering.
 *
 * DB assembly (Task 11) and template rendering (Task 10) are intentionally NOT
 * implemented here.
 */
import { roundHalfEven } from '../collect/types';
import type { HostReport, ProcessRow } from '../collect/types';

import type {
  CheckView,
  DailyPoint,
  DailyReport,
  DiskTotalView,
  ExecutiveContext,
  ExecutiveHostView,
  FailedHostView,
  GpuTotalView,
  HostMetricsView,
  HostReportView,
  ProcessRowView,
  TechnicalContext,
  WeeklyContext,
  WeeklyHostSummary,
  WeeklyHostView,
  WeeklyReport,
} from './model';
import { renderSvgLineChart } from './svg';

/** Python `f"{value:.1f}"` (round-half-even at one decimal). */
function fixed1(value: number): string {
  return roundHalfEven(value, 1).toFixed(1);
}

/** `_to_gib` (report.py:37-40). */
export function toGib(valueMb: number | null): string {
  if (valueMb === null) {
    return 'N/A';
  }
  return `${fixed1(valueMb / 1024)} GiB`;
}

/** `_format_capacity_gib` (report.py:43-48). */
export function formatCapacityGib(valueGib: number | null): string {
  if (valueGib === null) {
    return 'N/A';
  }
  if (valueGib >= 1024) {
    return `${fixed1(valueGib / 1024)} TiB`;
  }
  return `${fixed1(valueGib)} GiB`;
}

/** `_disk_percent_value` (report.py:51-55). */
export function diskPercentValue(percent: string): number {
  let digits = '';
  for (const ch of percent) {
    if (ch >= '0' && ch <= '9') {
      digits += ch;
    }
  }
  if (digits.length === 0) {
    return -1;
  }
  return Number.parseInt(digits, 10);
}

/** `_overview_text` (report.py:58-76). */
export function overviewText(hostReport: HostReport): string {
  const metrics = hostReport.metrics;
  const cpuText =
    metrics.cpuUsagePercent === null ? 'N/A' : `${fixed1(metrics.cpuUsagePercent)}%`;

  let memoryText = 'N/A';
  if (metrics.memory !== null) {
    memoryText = `${toGib(metrics.memory.usedMb)}/${toGib(metrics.memory.totalMb)}`;
  }

  let diskText = 'N/A';
  if (metrics.diskUsage.length > 0) {
    const diskFocus = maxBy(metrics.diskUsage, (row) => diskPercentValue(row.percent));
    diskText = `${diskFocus.mountpoint} ${diskFocus.percent}`;
  }

  const gpuText =
    metrics.gpuSummary.length === 0 ? 'N/A' : `GPU ${metrics.gpuSummary.length} active`;

  const checks = hostReport.checks ?? [];
  const checkTotal = checks.length;
  const checkOk = checks.filter((check) => check.status === 'ok').length;
  const checkSuffix = checkTotal > 0 ? ` | 检查 ${checkOk}/${checkTotal}` : '';

  return `CPU ${cpuText} | MEM ${memoryText} | DISK ${diskText} | ${gpuText}${checkSuffix}`;
}

/** `_percent` (report.py:79-82). */
export function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total === 0) {
    return null;
  }
  return roundHalfEven((used / total) * 100, 1);
}

const CAPACITY_FACTORS: Readonly<Record<string, number>> = {
  '': 1 / 1024 ** 3,
  B: 1 / 1024 ** 3,
  K: 1 / 1024 ** 2,
  M: 1 / 1024,
  G: 1,
  T: 1024,
  P: 1024 ** 2,
  E: 1024 ** 3,
};

/** `_parse_capacity_to_gib` (report.py:85-109). */
export function parseCapacityToGib(value: string): number | null {
  const text = value.trim();
  if (text.length === 0) {
    return null;
  }
  const match = /^([0-9]*\.?[0-9]+)\s*([A-Za-z]*)$/.exec(text);
  if (match === null) {
    return null;
  }
  const number = Number.parseFloat(match[1]);
  const unitText = match[2].toUpperCase();
  const unit = unitText.length > 0 ? unitText[0] : '';
  const factor = CAPACITY_FACTORS[unit];
  if (factor === undefined) {
    return null;
  }
  return number * factor;
}

/** Options for {@link processUserLabel} (Python keyword-only arguments). */
export interface ProcessUserLabelOptions {
  username: string;
  containerName?: string | null;
  containerId?: string | null;
}

/** `_process_user_label` (report.py:112-117). */
export function processUserLabel(options: ProcessUserLabelOptions): string {
  const { username, containerName, containerId } = options;
  if (containerName) {
    return `${containerName} | ${username}`;
  }
  if (containerId) {
    return `${containerId.slice(0, 12)} | ${username}`;
  }
  return username;
}

/** `_process_row_context` (report.py:120-131). */
export function processRowContext(rows: ProcessRow[]): ProcessRowView[] {
  return rows.map((row) => ({
    ...row,
    displayUser: processUserLabel({
      username: row.username,
      containerName: row.containerName,
      containerId: row.containerId,
    }),
  }));
}

/** `_disk_peak` (report.py:134-142). */
export function diskPeak(
  hostReport: HostReport,
): { mountpoint: string; percent: string; value: number } | null {
  if (hostReport.metrics.diskUsage.length === 0) {
    return null;
  }
  const row = maxBy(hostReport.metrics.diskUsage, (item) => diskPercentValue(item.percent));
  return {
    mountpoint: row.mountpoint,
    percent: row.percent,
    value: diskPercentValue(row.percent),
  };
}

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

/** `_is_virtual_filesystem` (report.py:145-146). */
export function isVirtualFilesystem(filesystem: string): boolean {
  return VIRTUAL_FILESYSTEMS.has(filesystem.trim().toLowerCase());
}

/** `_disk_total` (report.py:149-179). */
export function diskTotal(hostReport: HostReport): DiskTotalView | null {
  const seenFilesystems = new Set<string>();
  let totalGib = 0.0;
  let usedGib = 0.0;
  let availableGib = 0.0;

  for (const row of hostReport.metrics.diskUsage) {
    const filesystem = row.filesystem.trim();
    if (filesystem.length === 0 || seenFilesystems.has(filesystem) || isVirtualFilesystem(filesystem)) {
      continue;
    }
    const sizeGib = parseCapacityToGib(row.size);
    const usedRowGib = parseCapacityToGib(row.used);
    const availableRowGib = parseCapacityToGib(row.available);
    if (sizeGib === null || usedRowGib === null || availableRowGib === null) {
      continue;
    }
    seenFilesystems.add(filesystem);
    totalGib += sizeGib;
    usedGib += usedRowGib;
    availableGib += availableRowGib;
  }

  if (totalGib <= 0) {
    return null;
  }

  const usedPercent = roundHalfEven((usedGib / totalGib) * 100, 1);
  return {
    totalGib,
    usedGib,
    availableGib,
    usedPercent,
    displayText: `已用 ${formatCapacityGib(usedGib)} / ${formatCapacityGib(totalGib)} (${fixed1(usedPercent)}%)`,
  };
}

/** `_gpu_peak` (report.py:182-191). */
export function gpuPeak(
  hostReport: HostReport,
): { index: number; name: string; utilizationPercent: number; memoryPercent: number | null } | null {
  if (hostReport.metrics.gpuSummary.length === 0) {
    return null;
  }
  const row = maxBy(hostReport.metrics.gpuSummary, (item) => item.utilizationPercent);
  return {
    index: row.index,
    name: row.name,
    utilizationPercent: row.utilizationPercent,
    memoryPercent: percent(row.memoryUsedMb, row.memoryTotalMb),
  };
}

/** `_gpu_total` (report.py:194-210). */
export function gpuTotal(hostReport: HostReport): GpuTotalView | null {
  if (hostReport.metrics.gpuSummary.length === 0) {
    return null;
  }
  let totalMemoryMb = 0;
  let usedMemoryMb = 0;
  for (const row of hostReport.metrics.gpuSummary) {
    totalMemoryMb += row.memoryTotalMb;
    usedMemoryMb += row.memoryUsedMb;
  }
  if (totalMemoryMb <= 0) {
    return null;
  }
  const totalGib = totalMemoryMb / 1024;
  const usedGib = usedMemoryMb / 1024;
  const usedPercent = roundHalfEven((usedMemoryMb / totalMemoryMb) * 100, 1);
  return {
    gpuCount: hostReport.metrics.gpuSummary.length,
    totalGib,
    usedGib,
    usedPercent,
    displayText: `已用 ${formatCapacityGib(usedGib)} / ${formatCapacityGib(totalGib)} (${fixed1(usedPercent)}%)`,
  };
}

/** `_host_status` (report.py:213-228). */
export function hostStatus(hostReport: HostReport): [string, string] {
  if (!hostReport.success) {
    return ['异常', '#c2410c'];
  }
  const metrics = hostReport.metrics;
  const memoryPercent =
    metrics.memory !== null ? percent(metrics.memory.usedMb, metrics.memory.totalMb) : null;
  const disk = diskTotal(hostReport);
  const gpu = gpuTotal(hostReport);
  if (
    hostReport.errors.length > 0 ||
    (metrics.cpuUsagePercent ?? 0) >= 85 ||
    (memoryPercent ?? 0) >= 85 ||
    (disk !== null && disk.usedPercent >= 85) ||
    (gpu !== null && gpu.usedPercent >= 85)
  ) {
    return ['关注', '#c2410c'];
  }
  return ['正常', '#047857'];
}

/** `_build_risk_items` (report.py:231-252). */
export function buildRiskItems(report: DailyReport): string[] {
  const items: string[] = [];
  for (const hostReport of report.reports) {
    const metrics = hostReport.metrics;
    if (!hostReport.success) {
      items.push(`${hostReport.hostName}：主机采集失败`);
      continue;
    }
    if (hostReport.errors.length > 0) {
      const messages = hostReport.errors
        .filter((error) => error.message)
        .map((error) => error.message)
        .join('；');
      items.push(`${hostReport.hostName}：采集异常：${messages || '未知错误'}`);
    }
    if ((metrics.cpuUsagePercent ?? 0) >= 85) {
      items.push(`${hostReport.hostName}：CPU 使用率 ${fixed1(metrics.cpuUsagePercent as number)}%`);
    }
    const memoryPercent =
      metrics.memory !== null ? percent(metrics.memory.usedMb, metrics.memory.totalMb) : null;
    if ((memoryPercent ?? 0) >= 85) {
      items.push(`${hostReport.hostName}：内存使用率 ${fixed1(memoryPercent as number)}%`);
    }
    const disk = diskTotal(hostReport);
    if (disk !== null && disk.usedPercent >= 85) {
      items.push(`${hostReport.hostName}：整体磁盘使用率 ${fixed1(disk.usedPercent)}%`);
    }
    const gpu = gpuTotal(hostReport);
    if (gpu !== null && gpu.usedPercent >= 85) {
      items.push(`${hostReport.hostName}：整体 GPU 显存使用率 ${fixed1(gpu.usedPercent)}%`);
    }
  }
  return items.slice(0, 5);
}

/** `_executive_host_context` (report.py:255-299). */
export function executiveHostContext(hostReport: HostReport): ExecutiveHostView {
  const metrics = hostReport.metrics;
  const memoryPercent =
    metrics.memory !== null ? percent(metrics.memory.usedMb, metrics.memory.totalMb) : null;
  const disk = diskTotal(hostReport);
  const gpu = gpuTotal(hostReport);
  const [statusText, statusColor] = hostStatus(hostReport);

  const ownershipText =
    metrics.processCountsByUser
      .slice(0, 3)
      .map(
        (row) =>
          `${processUserLabel({
            username: row.username,
            containerName: row.containerName,
            containerId: row.containerId,
          })}=${row.count}`,
      )
      .join(' | ') || 'N/A';

  const firstCpu = metrics.topCpuProcesses[0];
  const firstMemory = metrics.topMemoryProcesses[0];

  return {
    hostName: hostReport.hostName,
    host: hostReport.host,
    statusText,
    statusColor,
    cpuPercent: metrics.cpuUsagePercent,
    memoryPercent,
    diskTotal: disk,
    diskTotalText: disk ? disk.displayText : 'N/A',
    gpuTotal: gpu,
    gpuTotalText: gpu ? gpu.displayText : 'N/A',
    topCpuOwner: firstCpu
      ? processUserLabel({
          username: firstCpu.username,
          containerName: firstCpu.containerName,
          containerId: firstCpu.containerId,
        })
      : 'N/A',
    topMemoryOwner: firstMemory
      ? processUserLabel({
          username: firstMemory.username,
          containerName: firstMemory.containerName,
          containerId: firstMemory.containerId,
        })
      : 'N/A',
    ownershipText,
  };
}

/** `_host_context` (report.py:302-341). */
export function hostContext(hostReport: HostReport): HostReportView {
  const metrics = hostReport.metrics;
  const metricsView: HostMetricsView = {
    ...metrics,
    topCpuProcesses: processRowContext(metrics.topCpuProcesses),
    topMemoryProcesses: processRowContext(metrics.topMemoryProcesses),
  };

  const checks: CheckView[] = (hostReport.checks ?? []).map((check) => ({
    name: check.name,
    type: check.type,
    target: check.target,
    status: check.status,
    message: check.message,
    latencyMs: check.latencyMs,
  }));
  const checkTotal = checks.length;
  const checkOk = checks.filter((check) => String(check.status) === 'ok').length;
  const failedChecks = checks.filter((check) => String(check.status) !== 'ok');

  return {
    hostName: hostReport.hostName,
    host: hostReport.host,
    success: hostReport.success,
    overview: overviewText(hostReport),
    metrics: metricsView,
    memoryUsedGib: metrics.memory !== null ? toGib(metrics.memory.usedMb) : 'N/A',
    memoryTotalGib: metrics.memory !== null ? toGib(metrics.memory.totalMb) : 'N/A',
    usersOnline: metrics.loggedInUsers.map((user) => user.username).join(', ') || 'None',
    processCountsText:
      metrics.processCountsByUser
        .map(
          (row) =>
            `${processUserLabel({
              username: row.username,
              containerName: row.containerName,
              containerId: row.containerId,
            })}=${row.count}`,
        )
        .join(' | ') || 'None',
    errors: hostReport.errors.map((error) => ({ stage: error.stage, message: error.message })),
    hasPartialErrors: hostReport.errors.length > 0,
    checks,
    checkTotal,
    checkOk,
    failedChecks,
  };
}

/** `_build_context` (report.py:344-365). */
export function buildContext(report: DailyReport): TechnicalContext {
  const failedHosts: FailedHostView[] = report.reports
    .filter((hostReport) => !hostReport.success)
    .map((hostReport) => ({
      hostName: hostReport.hostName,
      host: hostReport.host,
      reason: hostReport.errors.map((error) => error.message).join('; ') || 'Unknown failure',
    }));
  const successfulCount = report.reports.filter((hostReport) => hostReport.success).length;
  return {
    subject: `${report.subjectPrefix} ${formatSubjectDate(report.generatedAt)}`,
    generatedAt: formatGeneratedAt(report.generatedAt),
    summary: {
      totalHosts: report.reports.length,
      successCount: successfulCount,
      failedCount: report.reports.length - successfulCount,
    },
    failedHosts,
    hosts: report.reports.map((hostReport) => hostContext(hostReport)),
  };
}

/** `_build_executive_context` (report.py:368-382). */
export function buildExecutiveContext(report: DailyReport): ExecutiveContext {
  const executiveHosts = report.reports.map((hostReport) => executiveHostContext(hostReport));
  const riskCount = executiveHosts.filter((host) => host.statusText !== '正常').length;
  return {
    subject: `${report.subjectPrefix} ${formatSubjectDate(report.generatedAt)}`,
    generatedAt: formatGeneratedAt(report.generatedAt),
    summary: {
      totalHosts: report.reports.length,
      successCount: report.reports.filter((hostReport) => hostReport.success).length,
      failedCount: report.reports.filter((hostReport) => !hostReport.success).length,
      riskCount,
    },
    riskItems: buildRiskItems(report),
    hosts: executiveHosts,
  };
}

/** Python `str()` for the values that appear in weekly check statuses. */
function pythonStr(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  return String(value);
}

/** `_weekly_host_context` (report.py:454-474). */
export function weeklyHostContext(host: WeeklyHostSummary): WeeklyHostView {
  const checks = host.checks ?? [];
  const checkTotal = checks.length;
  const checkOk = checks.filter((check) => pythonStr(check.status) === 'ok').length;
  return {
    ...host,
    checkTotal,
    checkOk,
    cpuChart: renderSvgLineChart(
      host.dailyPoints.map((point: DailyPoint) => [
        String(point.day),
        point.cpu_avg === undefined ? null : point.cpu_avg,
      ] as const),
      { title: 'CPU 使用率 (%)' },
    ),
    memoryChart: renderSvgLineChart(
      host.dailyPoints.map((point: DailyPoint) => [
        String(point.day),
        point.memory_percent === undefined ? null : point.memory_percent,
      ] as const),
      { title: '内存使用率 (%)' },
    ),
    gpuChart: renderSvgLineChart(
      host.dailyPoints
        .filter((point: DailyPoint) => point.gpu_util !== undefined && point.gpu_util !== null)
        .map((point: DailyPoint) => [String(point.day), point.gpu_util as number] as const),
      { title: 'GPU 利用率 (%)' },
    ),
  };
}

/** `_build_weekly_context` (report.py:477-497). */
export function buildWeeklyContext(report: WeeklyReport): WeeklyContext {
  const withDataCount = report.summaries.filter((host) => host.sampleCount > 0).length;
  const insufficientDataCount = report.summaries.filter(
    (host) => host.sampleCount > 0 && host.sampleCount < 3,
  ).length;
  const noDataCount = report.summaries.filter((host) => host.sampleCount === 0).length;
  const weekRange = `${report.weekStart} ~ ${report.weekEnd}`;
  return {
    subject: `${report.subjectPrefix} ${weekRange}`,
    generatedAt: formatGeneratedAt(report.generatedAt),
    weekRange,
    summary: {
      totalHosts: report.summaries.length,
      withDataCount,
      insufficientDataCount,
      noDataCount,
    },
    busyHosts: report.busyHosts.map((host) => weeklyHostContext(host)),
    idleHosts: report.idleHosts.map((host) => weeklyHostContext(host)),
    hosts: report.summaries.map((host) => weeklyHostContext(host)),
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/** Python `max(rows, key=...)`: first maximal element wins on ties. */
function maxBy<T>(rows: readonly T[], key: (row: T) => number): T {
  let best = rows[0];
  let bestValue = key(best);
  for (let index = 1; index < rows.length; index += 1) {
    const candidate = rows[index];
    const candidateValue = key(candidate);
    if (candidateValue > bestValue) {
      best = candidate;
      bestValue = candidateValue;
    }
  }
  return best;
}

const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/;

interface ParsedTimestamp {
  date: string;
  timestamp: string;
}

/**
 * Read an ISO-8601 timestamp's *wall-clock* fields exactly as Python's
 * `strftime` would (no timezone conversion) and render `%Y-%m-%d %H:%M:%S %Z`.
 */
function parseTimestamp(iso: string): ParsedTimestamp {
  const match = ISO_DATETIME.exec(iso);
  if (match === null) {
    return { date: iso.slice(0, 10), timestamp: iso };
  }
  const [, year, month, day, hour, minute, second, , offset] = match;
  const date = `${year}-${month}-${day}`;
  let zone = '';
  if (offset !== undefined) {
    zone = offset === 'Z' || offset === '+00:00' || offset === '-00:00' ? 'UTC' : `UTC${offset}`;
  }
  const zoneSuffix = zone.length > 0 ? ` ${zone}` : '';
  return { date, timestamp: `${date} ${hour}:${minute}:${second}${zoneSuffix}` };
}

function formatSubjectDate(iso: string): string {
  return parseTimestamp(iso).date;
}

function formatGeneratedAt(iso: string): string {
  return parseTimestamp(iso).timestamp;
}
