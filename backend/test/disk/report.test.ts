/**
 * Tests for `backend/src/disk/report.ts` — the 1:1 TypeScript port of the
 * report-shaped parts of `servermanage/disk_health.py` (P5 Task 5):
 *
 * - `diskReportFromSnapshot` ↔ `disk_report_from_snapshot` (`disk_health.py:703`).
 * - `aggregateDiskHealth`       ↔ `_disk_health_summary` (`web/routes/_core.py:917`).
 *
 * Layer 1 (**Python-oracle differential**) feeds each fixture snapshot group
 * through both the Node port and the Python production module (invoked in a
 * read-only subprocess by `run_disk_report_oracle.py`), normalises both sides
 * with the shared §9.1 harness (ISO instants → canonical µs, numbers →
 * `toFixed(6)`, keys as a set) and asserts the diff is empty. Groups cover the
 * required healthy / degraded / no-virtual-drives / permission-denied shapes
 * plus a coercion-stress case (string ints, `N/A`, blanks, missing fields,
 * non-dict list items, naive timestamps).
 *
 * Layer 2 (**Node-only**) pins the page-summary counts and the snake_case field
 * contract, mirroring the Python module without needing an interpreter.
 *
 * If `servermanage.disk_health` is not importable the differential suite is
 * skipped; the Node-only suite always runs.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { aggregateDiskHealth, diskReportFromSnapshot } from '../../src/disk/report';
import type { DiskHealthReport } from '../../src/disk/report';

import { diffValues, findRepoRoot, normalizeValue, type Diff } from '../diff/harness';

const repoRoot = findRepoRoot();
const TEST_DIR = path.join(repoRoot, 'backend', 'test', 'disk');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures');
const REPORT_FIXTURES = path.join(FIXTURE_DIR, 'report_snapshots.json');
const ORACLE_SCRIPT = path.join(TEST_DIR, 'run_disk_report_oracle.py');

function defaultPython(): string {
  return process.env.PYTHON ?? 'python';
}

function mergePythonPath(): string {
  const existing = process.env.PYTHONPATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  return existing ? `${repoRoot}${sep}${existing}` : repoRoot;
}

/** Probe once whether the Python disk_health oracle can run here. */
function detectOracle(): { ok: boolean; detail: string } {
  const result = spawnSync(defaultPython(), ['-c', 'import servermanage.disk_health'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: { ...process.env, PYTHONPATH: mergePythonPath(), PYTHONWARNINGS: 'ignore' },
  });
  if (result.error) {
    return { ok: false, detail: String(result.error) };
  }
  if (result.status !== 0) {
    return { ok: false, detail: `exit ${result.status}: ${(result.stderr ?? '').trim()}` };
  }
  return { ok: true, detail: 'ok' };
}

const oracleProbe = detectOracle();
const itPython = oracleProbe.ok ? it : it.skip;
if (!oracleProbe.ok) {
  console.warn(`Python disk_health oracle unavailable; skipping diff groups: ${oracleProbe.detail}`);
}

interface OracleResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  message?: string;
}

function runOracle(group: string): OracleResult {
  const result = spawnSync(defaultPython(), [ORACLE_SCRIPT, 'snapshot', REPORT_FIXTURES, group], {
    cwd: repoRoot,
    encoding: 'utf-8',
    env: {
      ...process.env,
      PYTHONPATH: mergePythonPath(),
      PYTHONIOENCODING: 'utf-8',
      PYTHONWARNINGS: 'ignore',
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `python disk report oracle exited with status ${result.status}\nstderr:\n${result.stderr ?? ''}`,
    );
  }
  const lastLine = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    throw new Error('python disk report oracle produced no JSON output');
  }
  return JSON.parse(lastLine) as OracleResult;
}

const SNAPSHOTS: Record<string, unknown> = JSON.parse(readFileSync(REPORT_FIXTURES, 'utf-8'));
const GROUPS = ['healthy', 'degraded', 'no_virtual_drives', 'permission_denied', 'coercion_mixed'];

function assertNoDiffs(nodeValue: unknown, pythonValue: unknown, at: string): void {
  const nodeNorm = normalizeValue(nodeValue);
  const pythonNorm = normalizeValue(pythonValue);
  const diffs: Diff[] = [];
  diffValues(nodeNorm, pythonNorm, at, diffs);
  if (diffs.length > 0) {
    const detail = diffs
      .map((d) => `  ${d.path}: node=${JSON.stringify(d.node)} python=${JSON.stringify(d.python)}`)
      .join('\n');
    console.error(`[disk-report] ${at}: ${diffs.length} difference(s)\n${detail}`);
  }
  expect(diffs).toEqual([]);
}

describe('disk/report fixtures', () => {
  it('provides the required snapshot groups', () => {
    for (const group of GROUPS) {
      expect(Object.prototype.hasOwnProperty.call(SNAPSHOTS, group)).toBe(true);
    }
    expect(Object.keys(SNAPSHOTS).length).toBeGreaterThanOrEqual(4);
  });
});

describe('disk/report: diskReportFromSnapshot vs Python oracle', () => {
  for (const group of GROUPS) {
    itPython(`${group} snapshot rebuilds identically in both stacks`, () => {
      const python = runOracle(group);
      expect(python.ok, python.message).toBe(true);
      assertNoDiffs(diskReportFromSnapshot(SNAPSHOTS[group] as never), python.value, group);
    });
  }
});

describe('disk/report: Node-only contract', () => {
  it('exposes the exact snake_case field set of the Python dataclasses', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.healthy as never);
    expect(Object.keys(report).sort()).toEqual(
      [
        'host_name',
        'collected_at',
        'status',
        'message',
        'controllers',
        'virtual_drives',
        'physical_drives',
      ].sort(),
    );
    expect(Object.keys(report.controllers[0]).sort()).toEqual(
      ['controller', 'model', 'firmware', 'bbu_state', 'health', 'reasons'].sort(),
    );
    expect(Object.keys(report.virtual_drives[0]).sort()).toEqual(
      ['controller', 'vd_id', 'raid_level', 'state', 'size', 'health', 'reasons'].sort(),
    );
    expect(Object.keys(report.physical_drives[0]).sort()).toEqual(
      [
        'controller',
        'enclosure',
        'slot',
        'did',
        'model',
        'serial',
        'state',
        'media_errors',
        'other_errors',
        'predictive_failures',
        'smart_alert',
        'temperature_c',
        'shield_counter',
        'health',
        'reasons',
      ].sort(),
    );
  });

  it('preserves persisted health/reasons verbatim (no re-evaluation)', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.degraded as never);
    expect(report.status).toBe('degraded');
    expect(report.message).toContain('控制器 1 物理盘查询失败');
    expect(report.physical_drives.map((d) => d.health)).toEqual(['warning', 'warning']);
    expect(report.physical_drives[0].reasons).toEqual(['media_errors']);
    expect(report.physical_drives[0].media_errors).toBe(4);
  });

  it('round-trips a permission_denied batch without fabricating drives', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.permission_denied as never);
    expect(report.status).toBe('permission_denied');
    expect(report.controllers).toEqual([]);
    expect(report.virtual_drives).toEqual([]);
    expect(report.physical_drives).toEqual([]);
  });

  it('coerces string ints / N-A / blanks and defaults missing scalars', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.coercion_mixed as never);
    expect(report.host_name).toBe('');
    expect(report.status).toBe('ok');
    expect(report.message).toBeNull();
    // first controller: "   " model → null, "N/A" firmware → null, "Healthy" kept
    expect(report.controllers[0].model).toBeNull();
    expect(report.controllers[0].firmware).toBeNull();
    expect(report.controllers[0].health).toBe('Healthy');
    // second controller: missing controller → 0, reasons "abc" → ['a','b','c']
    expect(report.controllers[1].controller).toBe(0);
    expect(report.controllers[1].health).toBe('unknown');
    expect(report.controllers[1].reasons).toEqual(['a', 'b', 'c']);
    // non-dict controller item is dropped
    expect(report.controllers).toHaveLength(2);
    // physical drive coercion
    const pd = report.physical_drives[0];
    expect(pd.enclosure).toBe(252);
    expect(pd.slot).toBe(7);
    expect(pd.did).toBe(9);
    expect(pd.model).toBe('Samsung SSD');
    expect(pd.media_errors).toBe(2);
    expect(pd.other_errors).toBeNull();
    expect(pd.predictive_failures).toBeNull();
    expect(pd.smart_alert).toBe(true);
    expect(pd.temperature_c).toBe(41);
    expect(pd.shield_counter).toBe(0);
    // float controller is truncated toward zero
    expect(report.physical_drives[2].controller).toBe(1);
    expect(report.physical_drives[2].health).toBe('unknown');
  });

  it('treats a null/undefined snapshot as an empty ok report', () => {
    for (const snapshot of [null, undefined]) {
      const report = diskReportFromSnapshot(snapshot);
      expect(report.host_name).toBe('');
      expect(report.status).toBe('ok');
      expect(report.message).toBeNull();
      expect(report.controllers).toEqual([]);
      expect(report.virtual_drives).toEqual([]);
      expect(report.physical_drives).toEqual([]);
    }
  });
});

describe('disk/report: aggregateDiskHealth mirrors _disk_health_summary', () => {
  it('counts only canonical health values from the latest batch', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.degraded as never);
    expect(aggregateDiskHealth(report)).toEqual({
      summary: { status: 'degraded', healthy: 0, warning: 2, critical: 0 },
    });
  });

  it('counts a healthy batch', () => {
    const report = diskReportFromSnapshot(SNAPSHOTS.healthy as never);
    expect(aggregateDiskHealth(report).summary).toEqual({
      status: 'ok',
      healthy: 2,
      warning: 0,
      critical: 0,
    });
  });

  it('returns the unknown/zero summary for a missing batch', () => {
    for (const value of [null, undefined]) {
      expect(aggregateDiskHealth(value)).toEqual({
        summary: { status: 'unknown', healthy: 0, warning: 0, critical: 0 },
      });
    }
  });

  it('ignores non-canonical health strings', () => {
    const report: DiskHealthReport = {
      host_name: 'h',
      collected_at: '2026-04-18T00:00:00.000000+00:00',
      status: 'ok',
      message: null,
      controllers: [],
      virtual_drives: [],
      physical_drives: [
        {
          controller: 0,
          enclosure: null,
          slot: 0,
          did: null,
          model: null,
          serial: null,
          state: null,
          media_errors: null,
          other_errors: null,
          predictive_failures: null,
          smart_alert: null,
          temperature_c: null,
          shield_counter: null,
          health: 'unknown',
          reasons: [],
        },
        {
          controller: 0,
          enclosure: null,
          slot: 1,
          did: null,
          model: null,
          serial: null,
          state: null,
          media_errors: null,
          other_errors: null,
          predictive_failures: null,
          smart_alert: null,
          temperature_c: null,
          shield_counter: null,
          health: 'HEALTHY',
          reasons: [],
        },
      ],
    };
    expect(aggregateDiskHealth(report).summary).toEqual({
      status: 'ok',
      healthy: 1,
      warning: 0,
      critical: 0,
    });
  });
});
