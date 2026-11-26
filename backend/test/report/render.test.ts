/**
 * P5 Task 10 — tests for `backend/src/report/render.ts`, the Nunjucks port of
 * Python's `servermanage.report.render_report`.
 *
 * Layers:
 *   1. **Byte-for-byte parity** against the real Jinja2 oracle
 *      (`run_report_render_oracle.py`): technical / executive / weekly TEXT
 *      bodies (and subjects) must match exactly; HTML bodies are also compared
 *      exactly where the engines agree.
 *   2. **Structural / escaping assertions** that do not depend on Python:
 *      all six templates compile & render, context autoescaping (both `.txt.j2`
 *      and `.html.j2`), Chinese host names, empty reports, missing GPU, SVG
 *      charts, subject formats and newline handling.
 *
 * Templates are read from `backend/assets/report-templates`.
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
  snakeToCamelDeep,
  snakeToCamelKey,
  type DailyReport,
  type WeeklyHostSummary,
  type WeeklyReport,
} from '../../src/report/model';
import { defaultReportTemplatesDir, renderReport } from '../../src/report/render';
import { buildExecutiveContext } from '../../src/report/context';
import { findRepoRoot } from '../diff/harness';

// ---------------------------------------------------------------------------
// Fixture / oracle plumbing
// ---------------------------------------------------------------------------

const repoRoot = findRepoRoot();
const TEST_DIR = path.join(repoRoot, 'backend', 'test', 'report');
const MAIN_FIXTURE = path.join(TEST_DIR, 'fixtures', 'report-context-scenarios.json');
const EXTRA_FIXTURE = path.join(TEST_DIR, 'fixtures', 'report-render-extra.json');

interface RenderedBodies {
  subject: string;
  text_body: string;
  html_body: string;
}
interface OracleDailyEntry {
  name: string;
  technical: RenderedBodies;
  executive: RenderedBodies;
}
interface OracleWeeklyEntry {
  name: string;
  weekly: RenderedBodies;
}
interface OracleOutput {
  daily: OracleDailyEntry[];
  weekly: OracleWeeklyEntry[];
}

const GOLDEN_FILE = path.join(repoRoot, 'backend', 'test', 'report', 'golden', 'render.json');
function runOracle(fixturePath: string): OracleOutput {
  return golden<OracleOutput>(GOLDEN_FILE, path.basename(fixturePath));
}

interface DailyScenario {
  name: string;
  generated_at: string;
  subject_prefix: string;
  reports: Array<Record<string, any>>;
}
interface WeeklyScenario {
  name: string;
  generated_at: string;
  week_start: string;
  week_end: string;
  subject_prefix: string;
  summaries: Array<Record<string, any>>;
  busy_indices?: number[];
  idle_indices?: number[];
}

function loadFixture(fixturePath: string): { daily: DailyScenario[]; weekly: WeeklyScenario[] } {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8')) as {
    daily?: DailyScenario[];
    weekly?: WeeklyScenario[];
  };
  return { daily: raw.daily ?? [], weekly: raw.weekly ?? [] };
}

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

function buildDaily(row: DailyScenario): DailyReport {
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

function buildWeekly(row: WeeklyScenario): WeeklyReport {
  const summaries = row.summaries.map(buildWeeklySummary);
  return {
    generatedAt: row.generated_at,
    weekStart: row.week_start,
    weekEnd: row.week_end,
    summaries,
    busyHosts: (row.busy_indices ?? []).map((index) => summaries[index]),
    idleHosts: (row.idle_indices ?? []).map((index) => summaries[index]),
    subjectPrefix: row.subject_prefix,
  };
}

// ---------------------------------------------------------------------------
// Byte-exact comparison helper (report the first differing offset)
// ---------------------------------------------------------------------------

function firstDifference(actual: string, expected: string): number {
  const limit = Math.min(actual.length, expected.length);
  let index = 0;
  while (index < limit && actual[index] === expected[index]) {
    index += 1;
  }
  return index;
}

function expectBytes(actual: string, expected: string, label: string): void {
  if (actual !== expected) {
    const index = firstDifference(actual, expected);
    const from = Math.max(0, index - 60);
    const to = index + 60;
    throw new Error(
      `${label} differs at index ${index} (node len=${actual.length}, python len=${expected.length})\n` +
        `node  : ${JSON.stringify(actual.slice(from, to))}\n` +
        `python: ${JSON.stringify(expected.slice(from, to))}`,
    );
  }
  expect(actual).toBe(expected);
}

// ---------------------------------------------------------------------------
// Oracle availability (module scope)
// ---------------------------------------------------------------------------

const itPython = it;

const mainFixture = loadFixture(MAIN_FIXTURE);
const extraFixture = loadFixture(EXTRA_FIXTURE);

const mainOracle: OracleOutput | null = runOracle(MAIN_FIXTURE);
const extraOracle: OracleOutput | null = runOracle(EXTRA_FIXTURE);

function oracleDailyMap(output: OracleOutput | null): Map<string, OracleDailyEntry> {
  return new Map((output?.daily ?? []).map((entry) => [entry.name, entry]));
}
function oracleWeeklyMap(output: OracleOutput | null): Map<string, OracleWeeklyEntry> {
  return new Map((output?.weekly ?? []).map((entry) => [entry.name, entry]));
}

const oracleSets = [
  { label: 'fixtures', data: mainFixture, daily: oracleDailyMap(mainOracle), weekly: oracleWeeklyMap(mainOracle) },
  { label: 'extra', data: extraFixture, daily: oracleDailyMap(extraOracle), weekly: oracleWeeklyMap(extraOracle) },
];

// ---------------------------------------------------------------------------
// 1. Byte-for-byte text parity with the Python Jinja2 oracle
// ---------------------------------------------------------------------------

describe('report/render text parity (Python byte-for-byte)', () => {
  for (const set of oracleSets) {
    for (const scenario of set.data.daily) {
      itPython(`${set.label}/${scenario.name}: technical subject + text`, () => {
        const oracle = set.daily.get(scenario.name);
        expect(oracle, `missing oracle entry for ${scenario.name}`).toBeTruthy();
        const rendered = renderReport(buildDaily(scenario), 'technical');
        expectBytes(rendered.subject, oracle!.technical.subject, 'subject');
        expectBytes(rendered.textBody, oracle!.technical.text_body, 'technical textBody');
      });

      itPython(`${set.label}/${scenario.name}: executive subject + text`, () => {
        const oracle = set.daily.get(scenario.name);
        expect(oracle, `missing oracle entry for ${scenario.name}`).toBeTruthy();
        const rendered = renderReport(buildDaily(scenario), 'executive');
        expectBytes(rendered.subject, oracle!.executive.subject, 'subject');
        expectBytes(rendered.textBody, oracle!.executive.text_body, 'executive textBody');
      });
    }

    for (const scenario of set.data.weekly) {
      itPython(`${set.label}/${scenario.name}: weekly subject + text`, () => {
        const oracle = set.weekly.get(scenario.name);
        expect(oracle, `missing oracle entry for ${scenario.name}`).toBeTruthy();
        const rendered = renderReport(buildWeekly(scenario), 'weekly');
        expectBytes(rendered.subject, oracle!.weekly.subject, 'subject');
        expectBytes(rendered.textBody, oracle!.weekly.text_body, 'weekly textBody');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Byte-for-byte HTML parity (all six template variants)
// ---------------------------------------------------------------------------

describe('report/render HTML parity (Python byte-for-byte)', () => {
  for (const set of oracleSets) {
    for (const scenario of set.data.daily) {
      itPython(`${set.label}/${scenario.name}: technical html`, () => {
        const oracle = set.daily.get(scenario.name);
        expect(oracle).toBeTruthy();
        expectBytes(renderReport(buildDaily(scenario), 'technical').htmlBody, oracle!.technical.html_body, 'technical htmlBody');
      });

      itPython(`${set.label}/${scenario.name}: executive html`, () => {
        const oracle = set.daily.get(scenario.name);
        expect(oracle).toBeTruthy();
        expectBytes(renderReport(buildDaily(scenario), 'executive').htmlBody, oracle!.executive.html_body, 'executive htmlBody');
      });
    }

    for (const scenario of set.data.weekly) {
      itPython(`${set.label}/${scenario.name}: weekly html`, () => {
        const oracle = set.weekly.get(scenario.name);
        expect(oracle).toBeTruthy();
        expectBytes(renderReport(buildWeekly(scenario), 'weekly').htmlBody, oracle!.weekly.html_body, 'weekly htmlBody');
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Template compilation & rendering (all six templates)
// ---------------------------------------------------------------------------

describe('report/render compiles & renders all six templates', () => {
  it('resolves the backend/assets/report-templates directory', () => {
    const dir = defaultReportTemplatesDir();
    expect(dir.endsWith(path.join('assets', 'report-templates'))).toBe(true);
    for (const name of [
      'report.txt.j2',
      'report.html.j2',
      'report_executive.txt.j2',
      'report_executive.html.j2',
      'report_weekly.txt.j2',
      'report_weekly.html.j2',
    ]) {
      expect(() => readFileSync(path.join(dir, name), 'utf-8')).not.toThrow();
    }
  });

  const daily = buildDaily(mainFixture.daily[0]);
  const weekly = buildWeekly(mainFixture.weekly[0]);
  const technical = renderReport(daily, 'technical');
  const executive = renderReport(daily, 'executive');
  const weeklyRendered = renderReport(weekly, 'weekly');

  const templateEvidence: Array<{ template: string; body: string; marker: string; case: string }> = [
    { template: 'report.txt.j2', body: technical.textBody, marker: 'Host:', case: 'baseline-two-hosts/technical' },
    { template: 'report.html.j2', body: technical.htmlBody, marker: '<!DOCTYPE html>', case: 'baseline-two-hosts/technical' },
    { template: 'report_executive.txt.j2', body: executive.textBody, marker: '风险摘要', case: 'baseline-two-hosts/executive' },
    { template: 'report_executive.html.j2', body: executive.htmlBody, marker: '<!DOCTYPE html>', case: 'baseline-two-hosts/executive' },
    { template: 'report_weekly.txt.j2', body: weeklyRendered.textBody, marker: '统计周期', case: 'mixed-week/weekly' },
    { template: 'report_weekly.html.j2', body: weeklyRendered.htmlBody, marker: '<svg', case: 'mixed-week/weekly' },
  ];

  for (const item of templateEvidence) {
    it(`renders ${item.template} (${item.case})`, () => {
      expect(item.body.length).toBeGreaterThan(0);
      expect(item.body).toContain(item.marker);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. Structural / escaping / edge-case assertions (engine-independent)
// ---------------------------------------------------------------------------

function scenarioByName(name: string): DailyScenario {
  const found = extraFixture.daily.find((scenario) => scenario.name === name);
  if (!found) {
    throw new Error(`missing extra daily scenario: ${name}`);
  }
  return found;
}

describe('report/render escaping & edge cases', () => {
  it('escapes < > & " \' in HTML output', () => {
    const rendered = renderReport(buildDaily(scenarioByName('escaping-special-chars')), 'technical');
    expect(rendered.htmlBody).toContain('bad&lt;&amp;&gt;&#34;&#39;host');
    // Raw, unescaped form must not leak into the document.
    expect(rendered.htmlBody).not.toContain('bad<&>"\'host');
  });

  it('autoescapes the .txt.j2 bodies too (Jinja select_autoescape matches .j2)', () => {
    // Python's select_autoescape(['html','xml','j2']) is True for `.txt.j2`,
    // so the text body is HTML-escaped as well.
    const rendered = renderReport(buildDaily(scenarioByName('escaping-special-chars')), 'technical');
    expect(rendered.textBody).toContain('OS &amp; &lt;x&gt;');
    expect(rendered.textBody).not.toContain('OS & <x>');
  });

  it('renders Chinese host names verbatim', () => {
    const rendered = renderReport(buildDaily(scenarioByName('chinese-host')), 'technical');
    expect(rendered.textBody).toContain('服务器-甲');
    expect(rendered.htmlBody).toContain('服务器-甲');
    expect(rendered.subject).toBe('[服务器日报] 2024-05-01');
  });

  it('handles an empty report', () => {
    const empty: DailyReport = {
      generatedAt: '2024-05-02T00:00:00+00:00',
      reports: [],
      subjectPrefix: '[Empty Daily]',
    };
    const technical = renderReport(empty, 'technical');
    expect(technical.textBody).toContain('服务器总数: 0');
    expect(technical.textBody).not.toContain('Failed Hosts');
    expect(technical.htmlBody).toContain('服务器总数');
    const executive = renderReport(empty, 'executive');
    expect(executive.textBody).toContain('风险摘要');
    expect(executive.subject).toBe('[Empty Daily] 2024-05-02');
  });

  it('renders key HTML fragments: subject heading, host count and risk items', () => {
    const baseline = mainFixture.daily[0];
    const technical = renderReport(buildDaily(baseline), 'technical');
    expect(technical.htmlBody).toContain(technical.subject);
    expect(technical.htmlBody).toContain('服务器总数');
    expect(technical.htmlBody).toContain(`>${baseline.reports.length}</div>`);

    const riskHeavy = mainFixture.daily.find((scenario) => scenario.name === 'risk-heavy')!;
    const riskReport = buildDaily(riskHeavy);
    const executive = renderReport(riskReport, 'executive');
    const riskItems = buildExecutiveContext(riskReport).riskItems;
    expect(riskItems.length).toBeGreaterThan(0);
    expect(executive.htmlBody).toContain('风险摘要');
    expect(executive.htmlBody).toContain(`<li style="margin-bottom:8px;">${riskItems[0]}</li>`);
  });

  it('handles hosts without GPU and with multiple disks', () => {
    const rendered = renderReport(buildDaily(mainFixture.daily.find((s) => s.name === 'no-gpu-multidisk')!), 'technical');
    expect(rendered.textBody).toContain('GPU Summary');
    expect(rendered.textBody).toContain('- N/A');
    expect(rendered.textBody).toContain('Disk Usage');
  });

  it('includes SVG charts in weekly HTML', () => {
    const rendered = renderReport(buildWeekly(mainFixture.weekly.find((s) => s.name === 'mixed-week')!), 'weekly');
    expect(rendered.htmlBody).toContain('<svg');
    expect(rendered.htmlBody).toContain('CPU 使用率');
    expect(rendered.htmlBody).toContain('内存使用率');
  });

  it('normalizes CRLF source newlines to LF in the rendered output', () => {
    // Templates are stored as CRLF; Jinja2 (universal newlines +
    // keep_trailing_newline=False) and our loader both normalize to LF and
    // strip one trailing source newline.  The exact leading/trailing
    // whitespace contract is pinned by the byte-for-byte parity tests above.
    const rendered = renderReport(buildDaily(mainFixture.daily[0]), 'technical');
    expect(rendered.textBody).not.toContain('\r');
    expect(rendered.textBody).toContain('生成时间: ');
  });

  it('formats the technical subject as "<prefix> <YYYY-MM-DD>"', () => {
    const rendered = renderReport(buildDaily(mainFixture.daily[0]), 'technical');
    expect(rendered.subject).toBe('[Server Daily Report] 2024-05-01');
  });

  it('formats the weekly subject as "<prefix> <start> ~ <end>"', () => {
    const rendered = renderReport(buildWeekly(mainFixture.weekly[0]), 'weekly');
    expect(rendered.subject).toBe('[Server Weekly Report] 2024-04-29 ~ 2024-05-05');
  });

  it('renders whole-valued raw floats like CPython str(float) (e.g. 1 -> "1.0")', () => {
    const rendered = renderReport(buildDaily(scenarioByName('whole-float-loads')), 'technical');
    expect(rendered.textBody).toContain('Load Avg     : 1.0 / 2.0 / 3.0');
    expect(rendered.textBody).toContain('CPU=12.0 MEM=3.0');
  });
});
