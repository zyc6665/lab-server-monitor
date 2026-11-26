/**
 * Tests for the P5 Task 9 report-context port:
 * `backend/src/report/{model,context,svg}.ts` — a 1:1 TypeScript transcription
 * of the context builders in `servermanage/report.py` (lines 28-497) and
 * `render_svg_line_chart` (lines 385-451).
 *
 * Two layers:
 *
 * 1. **Unit edge cases** mirroring the Python oracle: GiB/TiB formatting,
 *    capacity parsing, disk-percent digit extraction, container labels, virtual
 *    filesystems, rounding, and CPython's `repr(float)` coordinate layout.
 * 2. **Python-oracle differential tests.** Every fixture scenario is evaluated
 *    by the Node port and by the real Python module (`_build_context`,
 *    `_build_executive_context`, `_build_weekly_context`,
 *    `render_svg_line_chart`) in a read-only subprocess. Contexts are
 *    snake_cased and normalised per the shared diff harness; charts are
 *    compared as exact strings. An empty diff / equal string means the two
 *    stacks are observationally identical.
 *
 * The fixture is authored in Python's snake_case shape; the Node side builds
 * equivalent camelCase `DailyReport` / `WeeklyReport` objects directly (no DB
 * assembly, no template rendering — Tasks 11 / 10).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { golden } from '../golden/golden';

import {
  emptyHostMetrics,
  type HostCheckResult,
  type HostCollectionError,
  type HostMetrics,
  type HostReport,
} from '../../src/collect/types';
import {
  buildContext,
  buildExecutiveContext,
  buildWeeklyContext,
  diskPercentValue,
  formatCapacityGib,
  isVirtualFilesystem,
  parseCapacityToGib,
  percent,
  processUserLabel,
  toGib,
} from '../../src/report/context';
import {
  snakeToCamelKey,
  snakeToCamelDeep,
  toSnakeCaseDeep,
  toSnakeCaseKey,
  type DailyReport,
  type WeeklyHostSummary,
  type WeeklyReport,
} from '../../src/report/model';
import { pythonFloatRepr, renderSvgLineChart } from '../../src/report/svg';
import { diffValues, findRepoRoot, normalizeValue, type Diff } from '../diff/harness';

// ---------------------------------------------------------------------------
// Fixture / oracle plumbing
// ---------------------------------------------------------------------------

const repoRoot = findRepoRoot();
const TEST_DIR = path.join(repoRoot, 'backend', 'test', 'report');
const FIXTURE_PATH = path.join(TEST_DIR, 'fixtures', 'report-context-scenarios.json');

interface OracleEntry {
  name: string;
  context: unknown;
}
interface OracleChart {
  name: string;
  svg: string;
}
interface OracleOutput {
  daily: OracleEntry[];
  executive: OracleEntry[];
  weekly: OracleEntry[];
  charts: OracleChart[];
}

const GOLDEN_FILE = path.join(repoRoot, 'backend', 'test', 'report', 'golden', 'context.json');
function runOracle(): OracleOutput {
  return golden<OracleOutput>(GOLDEN_FILE, 'context');
}

const itPython = it;

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as {
  daily: Array<Record<string, any>>;
  weekly: Array<Record<string, any>>;
  charts: Array<Record<string, any>>;
};

const oracle = runOracle();
const dailyByName = new Map<string, unknown>((oracle?.daily ?? []).map((entry) => [entry.name, entry.context]));
const executiveByName = new Map<string, unknown>(
  (oracle?.executive ?? []).map((entry) => [entry.name, entry.context]),
);
const weeklyByName = new Map<string, unknown>((oracle?.weekly ?? []).map((entry) => [entry.name, entry.context]));
const chartByName = new Map<string, string>((oracle?.charts ?? []).map((entry) => [entry.name, entry.svg]));

// ---------------------------------------------------------------------------
// snake_case fixture -> camelCase Node report objects
// ---------------------------------------------------------------------------

function buildMetrics(data: Record<string, any>): HostMetrics {
  const camel = snakeToCamelDeep(data) as Partial<HostMetrics>;
  return { ...emptyHostMetrics(), ...camel };
}

function buildCheck(row: Record<string, any>): HostCheckResult {
  return {
    name: row.name,
    type: row.type,
    target: row.target,
    status: row.status,
    message: row.message,
    latencyMs: row.latency_ms ?? null,
    checkedAt: row.checked_at ?? null,
  };
}

function buildHostReport(row: Record<string, any>): HostReport {
  const errors: HostCollectionError[] = (row.errors ?? []).map((error: Record<string, any>) => ({
    stage: error.stage,
    message: error.message,
  }));
  return {
    hostName: row.host_name,
    host: row.host,
    success: Boolean(row.success),
    metrics: buildMetrics(row.metrics ?? {}),
    errors,
    checks: (row.checks ?? []).map(buildCheck),
    users: [],
  };
}

function buildDaily(row: Record<string, any>): DailyReport {
  return {
    generatedAt: row.generated_at,
    reports: row.reports.map(buildHostReport),
    subjectPrefix: row.subject_prefix,
  };
}

const WEEKLY_NUMERIC_FIELDS = [
  'cpu_avg',
  'cpu_max',
  'cpu_min',
  'memory_avg_percent',
  'memory_max_percent',
  'disk_avg_percent',
  'disk_max_percent',
  'gpu_util_avg',
  'gpu_util_max',
  'gpu_memory_avg_percent',
  'gpu_memory_max_percent',
  'load_avg',
  'users_avg',
  'processes_avg',
] as const;

function buildWeeklySummary(row: Record<string, any>): WeeklyHostSummary {
  const summary: Record<string, unknown> = {
    hostName: row.host_name,
    host: row.host,
    sampleCount: row.sample_count,
    successCount: row.success_count,
    dailyPoints: (row.daily_points ?? []).map((point: Record<string, unknown>) => ({ ...point })),
    checks: (row.checks ?? []).map((check: Record<string, unknown>) => ({ ...check })),
  };
  for (const key of WEEKLY_NUMERIC_FIELDS) {
    summary[snakeToCamelKey(key)] = row[key] ?? null;
  }
  return summary as unknown as WeeklyHostSummary;
}

function buildWeekly(row: Record<string, any>): WeeklyReport {
  const summaries = row.summaries.map(buildWeeklySummary);
  return {
    generatedAt: row.generated_at,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summaries,
    busyHosts: (row.busy_indices ?? []).map((index: number) => summaries[index]),
    idleHosts: (row.idle_indices ?? []).map((index: number) => summaries[index]),
    subjectPrefix: row.subject_prefix,
  };
}

/** Snake_case the camelCase Node context and diff it against the oracle. */
function contextDiffs(nodeContext: unknown, pythonContext: unknown): Diff[] {
  const diffs: Diff[] = [];
  diffValues(normalizeValue(toSnakeCaseDeep(nodeContext)), normalizeValue(pythonContext), '$', diffs);
  return diffs;
}

// ---------------------------------------------------------------------------
// Unit edge cases
// ---------------------------------------------------------------------------

describe('report/context helpers (Python parity)', () => {
  it('formats MiB to GiB', () => {
    expect(toGib(1536)).toBe('1.5 GiB');
    expect(toGib(0)).toBe('0.0 GiB');
    expect(toGib(null)).toBe('N/A');
  });

  it('formats capacity with TiB promotion at 1024 GiB', () => {
    expect(formatCapacityGib(1.5)).toBe('1.5 GiB');
    expect(formatCapacityGib(1023.94)).toBe('1023.9 GiB');
    expect(formatCapacityGib(1024)).toBe('1.0 TiB');
    expect(formatCapacityGib(2048)).toBe('2.0 TiB');
    expect(formatCapacityGib(null)).toBe('N/A');
  });

  it('extracts disk percent digits like Python', () => {
    expect(diskPercentValue('75%')).toBe(75);
    expect(diskPercentValue('0.5%')).toBe(5);
    expect(diskPercentValue(' 100 % ')).toBe(100);
    expect(diskPercentValue('abc')).toBe(-1);
  });

  it('parses GNU df capacity strings to GiB', () => {
    expect(parseCapacityToGib('500G')).toBe(500);
    expect(parseCapacityToGib('1.5T')).toBe(1536);
    expect(parseCapacityToGib('1024M')).toBe(1);
    expect(parseCapacityToGib('1048576K')).toBe(1);
    expect(parseCapacityToGib('1P')).toBe(1024 ** 2);
    expect(parseCapacityToGib('')).toBeNull();
    expect(parseCapacityToGib('bad')).toBeNull();
    expect(parseCapacityToGib('10X')).toBeNull();
  });

  it('labels process owners with container name / id precedence', () => {
    expect(processUserLabel({ username: 'alice' })).toBe('alice');
    expect(processUserLabel({ username: 'alice', containerName: 'web' })).toBe('web | alice');
    expect(
      processUserLabel({ username: 'alice', containerId: 'abcdef1234567890ff' }),
    ).toBe('abcdef123456 | alice');
    expect(
      processUserLabel({ username: 'alice', containerName: 'web', containerId: 'abcdef1234567890ff' }),
    ).toBe('web | alice');
  });

  it('recognises virtual filesystems case/space-insensitively', () => {
    expect(isVirtualFilesystem(' tmpfs ')).toBe(true);
    expect(isVirtualFilesystem('OVERLAY')).toBe(true);
    expect(isVirtualFilesystem('cgroup2')).toBe(true);
    expect(isVirtualFilesystem('/dev/sda1')).toBe(false);
  });

  it('computes percentages with Python round-half-even and N/A guards', () => {
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
    expect(percent(0, 10)).toBe(0);
    expect(percent(null, 10)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(percent(5, null)).toBeNull();
  });

  it('maps keys both directions including trailing digits', () => {
    expect(toSnakeCaseKey('load1')).toBe('load_1');
    expect(toSnakeCaseKey('load15')).toBe('load_15');
    expect(toSnakeCaseKey('osPrettyName')).toBe('os_pretty_name');
    expect(toSnakeCaseKey('gpuMemoryAvgPercent')).toBe('gpu_memory_avg_percent');
    expect(toSnakeCaseKey('checkTotal')).toBe('check_total');
    expect(snakeToCamelKey('load_1')).toBe('load1');
    expect(snakeToCamelKey('cpu_avg')).toBe('cpuAvg');
  });

  it('renders the insufficient-data SVG placeholder exactly', () => {
    expect(renderSvgLineChart([], { title: '' })).toBe(
      '<svg width="360" height="120" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-size="12" fill="#888">Chart: 数据不足</text></svg>',
    );
    expect(renderSvgLineChart([['2024-05-01', 12.0]], { title: 'CPU' })).toBe(
      '<svg width="360" height="120" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-size="12" fill="#888">CPU: 数据不足</text></svg>',
    );
  });

  it('reproduces CPython repr(float) layout', () => {
    expect(pythonFloatRepr(36)).toBe('36.0');
    expect(pythonFloatRepr(92)).toBe('92.0');
    expect(pythonFloatRepr(100)).toBe('100.0');
    expect(pythonFloatRepr(69.33333333333333)).toBe('69.33333333333333');
    expect(pythonFloatRepr(0.1 + 0.2)).toBe('0.30000000000000004');
    expect(pythonFloatRepr(1e-5)).toBe('1e-05');
    expect(pythonFloatRepr(0.0001)).toBe('0.0001');
    expect(pythonFloatRepr(1e15)).toBe('1000000000000000.0');
    expect(pythonFloatRepr(1e16)).toBe('1e+16');
    expect(pythonFloatRepr(1e20)).toBe('1e+20');
    expect(pythonFloatRepr(5e-324)).toBe('5e-324');
    expect(pythonFloatRepr(-0)).toBe('-0.0');
  });
});

// ---------------------------------------------------------------------------
// Differential: _build_context / _build_executive_context
// ---------------------------------------------------------------------------

describe('report/context vs Python oracle (daily)', () => {
  for (const scenario of fixture.daily) {
    itPython(`buildContext: ${scenario.name}`, () => {
      const diffs = contextDiffs(buildContext(buildDaily(scenario)), dailyByName.get(scenario.name));
      expect(diffs, JSON.stringify(diffs, null, 2)).toEqual([]);
    });

    itPython(`buildExecutiveContext: ${scenario.name}`, () => {
      const diffs = contextDiffs(
        buildExecutiveContext(buildDaily(scenario)),
        executiveByName.get(scenario.name),
      );
      expect(diffs, JSON.stringify(diffs, null, 2)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Differential: _build_weekly_context
// ---------------------------------------------------------------------------

describe('report/context vs Python oracle (weekly)', () => {
  for (const scenario of fixture.weekly) {
    itPython(`buildWeeklyContext: ${scenario.name}`, () => {
      const diffs = contextDiffs(buildWeeklyContext(buildWeekly(scenario)), weeklyByName.get(scenario.name));
      expect(diffs, JSON.stringify(diffs, null, 2)).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// Differential: render_svg_line_chart (exact strings)
// ---------------------------------------------------------------------------

describe('report/svg vs Python oracle (charts)', () => {
  for (const scenario of fixture.charts) {
    itPython(`renderSvgLineChart: ${scenario.name}`, () => {
      const options: { width?: number; height?: number; title?: string; yMax?: number } = {};
      if (scenario.width !== undefined) options.width = scenario.width;
      if (scenario.height !== undefined) options.height = scenario.height;
      if (scenario.title !== undefined) options.title = scenario.title;
      if (scenario.y_max !== undefined) options.yMax = scenario.y_max;
      const actual = renderSvgLineChart(scenario.data_points, options);
      const expected = chartByName.get(scenario.name);
      const diffs: Diff[] = [];
      if (actual !== expected) {
        diffs.push({ path: '$', node: actual, python: expected });
      }
      expect(diffs, JSON.stringify(diffs, null, 2)).toEqual([]);
    });
  }
});
