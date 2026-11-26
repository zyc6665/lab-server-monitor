/**
 * Report-layer data model — 1:1 with the Python oracle report dataclasses
 * (`servermanage/models.py` `DailyReport` / `HostReport` / `WeeklyHostSummary`
 * / `WeeklyReport` / `RenderedReport`) and the context dictionaries produced by
 * the helpers in `servermanage/report.py` (lines 28-497).
 *
 * Conventions (same as `backend/src/collect/types.ts`):
 * - Python field names are camelCased for TypeScript views; input report
 *   objects reuse the existing collect-layer `HostReport` / `HostMetrics`.
 * - The *output* context views are camelCase; `toSnakeCaseDeep` reproduces the
 *   exact snake_case shape the Python oracle emits, so the differential test
 *   can compare the two stacks directly.
 * - Timestamps are ISO-8601 strings. `DailyReport.generatedAt` /
 *   `WeeklyReport.generatedAt` carry the originating offset (Python keeps the
 *   wall clock and renders `%Z`); `weekStart` / `weekEnd` are `YYYY-MM-DD`.
 *
 * Template rendering (P5 Task 10) and DB report assembly (P5 Task 11) are NOT
 * part of this module: the context builders take already-constructed report
 * objects.
 */
import type {
  HostCheckResult,
  HostCollectionError,
  HostMetrics,
  HostReport,
  ProcessRow,
} from '../collect/types';

// ---------------------------------------------------------------------------
// Input report objects (already-constructed; no DB assembly here)
// ---------------------------------------------------------------------------

/** `servermanage/models.py:468-472` — `DailyReport`. */
export interface DailyReport {
  generatedAt: string;
  reports: HostReport[];
  subjectPrefix: string;
}

/**
 * `WeeklyHostSummary` with the extra `check_*` / `*_chart` keys that
 * `_weekly_host_context` (report.py:454-474) injects. The `dailyPoints` /
 * `checks` payloads are domain dictionaries created by the weekly aggregation
 * (`servermanage/weekly.py:100-122`) and keep their native snake_case keys —
 * they are opaque to this layer.
 */
export interface DailyPoint {
  day: string;
  cpu_avg?: number | null;
  memory_percent?: number | null;
  gpu_util?: number | null;
}

/** Raw service-check dictionaries attached to a weekly summary. */
export type WeeklyCheck = Record<string, unknown>;

/** `servermanage/models.py:482-503` — `WeeklyHostSummary`. */
export interface WeeklyHostSummary {
  hostName: string;
  host: string;
  sampleCount: number;
  successCount: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  cpuMin: number | null;
  memoryAvgPercent: number | null;
  memoryMaxPercent: number | null;
  diskAvgPercent: number | null;
  diskMaxPercent: number | null;
  gpuUtilAvg: number | null;
  gpuUtilMax: number | null;
  gpuMemoryAvgPercent: number | null;
  gpuMemoryMaxPercent: number | null;
  loadAvg: number | null;
  usersAvg: number | null;
  processesAvg: number | null;
  dailyPoints: DailyPoint[];
  checks: WeeklyCheck[];
}

/** `servermanage/models.py:506-514` — `WeeklyReport`. */
export interface WeeklyReport {
  generatedAt: string;
  weekStart: string;
  weekEnd: string;
  summaries: WeeklyHostSummary[];
  busyHosts: WeeklyHostSummary[];
  idleHosts: WeeklyHostSummary[];
  subjectPrefix: string;
}

/** `servermanage/models.py:475-479` — `RenderedReport` (Task 10 fills bodies). */
export interface RenderedReport {
  subject: string;
  textBody: string;
  htmlBody: string;
}

// ---------------------------------------------------------------------------
// Technical context views (`_build_context`, report.py:302-365)
// ---------------------------------------------------------------------------

/** `ProcessRow` plus the derived `display_user` label. */
export interface ProcessRowView extends ProcessRow {
  displayUser: string;
}

/** `asdict(HostMetrics)` with the two process lists replaced by views. */
export interface HostMetricsView extends HostMetrics {
  topCpuProcesses: ProcessRowView[];
  topMemoryProcesses: ProcessRowView[];
}

/** One entry of `_host_context`'s `checks` list (report.py:307-317). */
export interface CheckView {
  name: string;
  type: string;
  target: string;
  status: string;
  message: string;
  latencyMs: number | null;
}

/** `_host_context` (report.py:302-341) — one technical host entry. */
export interface HostReportView {
  hostName: string;
  host: string;
  success: boolean;
  overview: string;
  metrics: HostMetricsView;
  memoryUsedGib: string;
  memoryTotalGib: string;
  usersOnline: string;
  processCountsText: string;
  errors: HostCollectionError[];
  hasPartialErrors: boolean;
  checks: CheckView[];
  checkTotal: number;
  checkOk: number;
  failedChecks: CheckView[];
}

/** `_build_context`'s `failed_hosts` entry. */
export interface FailedHostView {
  hostName: string;
  host: string;
  reason: string;
}

/** `_build_context` summary counts. */
export interface TechnicalSummary {
  totalHosts: number;
  successCount: number;
  failedCount: number;
}

/** `_build_context` (report.py:344-365). */
export interface TechnicalContext {
  subject: string;
  generatedAt: string;
  summary: TechnicalSummary;
  failedHosts: FailedHostView[];
  hosts: HostReportView[];
}

// ---------------------------------------------------------------------------
// Executive context views (`_build_executive_context`, report.py:255-382)
// ---------------------------------------------------------------------------

/** `_disk_total` result (report.py:149-179). */
export interface DiskTotalView {
  totalGib: number;
  usedGib: number;
  availableGib: number;
  usedPercent: number;
  displayText: string;
}

/** `_gpu_total` result (report.py:194-210). */
export interface GpuTotalView {
  gpuCount: number;
  totalGib: number;
  usedGib: number;
  usedPercent: number;
  displayText: string;
}

/** `_executive_host_context` (report.py:255-299). */
export interface ExecutiveHostView {
  hostName: string;
  host: string;
  statusText: string;
  statusColor: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  diskTotal: DiskTotalView | null;
  diskTotalText: string;
  gpuTotal: GpuTotalView | null;
  gpuTotalText: string;
  topCpuOwner: string;
  topMemoryOwner: string;
  ownershipText: string;
}

/** `_build_executive_context` summary counts. */
export interface ExecutiveSummary extends TechnicalSummary {
  riskCount: number;
}

/** `_build_executive_context` (report.py:368-382). */
export interface ExecutiveContext {
  subject: string;
  generatedAt: string;
  summary: ExecutiveSummary;
  riskItems: string[];
  hosts: ExecutiveHostView[];
}

// ---------------------------------------------------------------------------
// Weekly context views (`_build_weekly_context`, report.py:454-497)
// ---------------------------------------------------------------------------

/** `_weekly_host_context` (report.py:454-474). */
export interface WeeklyHostView extends WeeklyHostSummary {
  checkTotal: number;
  checkOk: number;
  cpuChart: string;
  memoryChart: string;
  gpuChart: string;
}

/** `_build_weekly_context` summary counts. */
export interface WeeklySummary {
  totalHosts: number;
  withDataCount: number;
  insufficientDataCount: number;
  noDataCount: number;
}

/** `_build_weekly_context` (report.py:477-497). */
export interface WeeklyContext {
  subject: string;
  generatedAt: string;
  weekRange: string;
  summary: WeeklySummary;
  busyHosts: WeeklyHostView[];
  idleHosts: WeeklyHostView[];
  hosts: WeeklyHostView[];
}

// ---------------------------------------------------------------------------
// snake_case <-> camelCase key mapping
// ---------------------------------------------------------------------------

/**
 * Convert one camelCase key to the Python snake_case spelling.
 *
 * Handles both acronym-ish boundaries (`osPrettyName` -> `os_pretty_name`) and
 * trailing digits (`load1` -> `load_1`, `buffCacheMb` -> `buff_cache_mb`).
 */
export function toSnakeCaseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Za-z])([0-9])/g, '$1_$2')
    .toLowerCase();
}

/** Convert one snake_case key to camelCase (`load_1` -> `load1`). */
export function snakeToCamelKey(key: string): string {
  return key.replace(/_([0-9a-zA-Z])/g, (_match, ch: string) => ch.toUpperCase());
}

/** Recursively convert every object key in a value to snake_case. */
export function toSnakeCaseDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toSnakeCaseDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[toSnakeCaseKey(key)] = toSnakeCaseDeep(item);
    }
    return out;
  }
  return value;
}

/** Recursively convert every object key in a value to camelCase. */
export function snakeToCamelDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => snakeToCamelDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[snakeToCamelKey(key)] = snakeToCamelDeep(item);
    }
    return out;
  }
  return value;
}

/** Re-exported for callers that model service-check views directly. */
export type { HostCheckResult, HostCollectionError };
