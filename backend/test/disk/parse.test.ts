/**
 * Tests for `backend/src/disk/parse.ts` — the 1:1 TypeScript port of the storcli
 * parsing helpers in `servermanage/disk_health.py` (lines 128-529).
 *
 * Three layers:
 *
 * 1. **Python-oracle differential tests.** Every fixture is fed through both the
 *    Node port and the Python production module (`servermanage.disk_health`,
 *    invoked in a read-only subprocess by `run_disk_parse_oracle.py`). The
 *    Python dataclasses are serialised with `dataclasses.asdict` (snake_case),
 *    camelised, numerically normalised, and diffed against the Node output; an
 *    empty diff means the two stacks are observationally identical.
 * 2. **Node-only sanity assertions** mirroring `tests/test_disk_parse.py`
 *    (drive counts, detail fields, text fallback, controler BBU state, VDs).
 * 3. **Field-map contract**: the exported `*_FIELD_MAP`s must round-trip every
 *    camelCase field back to its Python snake_case name.
 *
 * Fixtures (`test/disk/fixtures/`) cover the required groups: multi-controller
 * JSON, a controller with no virtual drives, SAS/SATA mixed text, text with
 * abnormal/malformed lines, a permission-error transcript, and a JSON payload
 * whose top level is an object wrapping `Controllers` (plus a top-level array
 * that both stacks must reject).
 *
 * If the Python interpreter / `servermanage.disk_health` is not importable the
 * differential suite is skipped; the Node-only suites still run.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CONTROLLER_FIELD_MAP,
  PHYSICAL_DRIVE_FIELD_MAP,
  VIRTUAL_DRIVE_FIELD_MAP,
  StorcliParseError,
  parseControllers,
  parsePhysicalDrives,
  parsePhysicalDrivesText,
  parseTemperature,
  parseVirtualDrives,
} from '../../src/disk/parse';

import { diffValues, findRepoRoot, type Diff } from '../diff/harness';

const repoRoot = findRepoRoot();
const TEST_DIR = path.join(repoRoot, 'backend', 'test', 'disk');
const FIXTURE_DIR = path.join(TEST_DIR, 'fixtures');
const ORACLE_SCRIPT = path.join(TEST_DIR, 'run_disk_parse_oracle.py');

function defaultPython(): string {
  return process.env.PYTHON ?? 'python';
}

function mergePythonPath(): string {
  const existing = process.env.PYTHONPATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  return existing ? `${repoRoot}${sep}${existing}` : repoRoot;
}

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
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

function runOracle(op: string, fixture: string, arg?: string): OracleResult {
  const args = [ORACLE_SCRIPT, op, path.join(FIXTURE_DIR, fixture)];
  if (arg !== undefined) {
    args.push(arg);
  }
  const result = spawnSync(defaultPython(), args, {
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
      `python disk oracle exited with status ${result.status}\nstderr:\n${result.stderr ?? ''}`,
    );
  }
  const lastLine = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    throw new Error('python disk oracle produced no JSON output');
  }
  return JSON.parse(lastLine) as OracleResult;
}

/** `snake_case` -> `camelCase` (digits kept: `vd_id` -> `vdId`). */
function camelize(key: string): string {
  return key.replace(/_([0-9a-zA-Z])/g, (_match, ch: string) => ch.toUpperCase());
}

/**
 * Canonicalise any parsed value for cross-language comparison: camelise
 * snake_case keys, unify numbers with `toFixed(6)`, sort object keys. Arrays
 * keep their parser-defined order (the Python functions append in input order).
 */
function normalizeParsed(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [key, item] of value.entries()) {
      obj[String(key)] = normalizeParsed(item);
    }
    return obj;
  }
  if (value === null || value === undefined) {
    return null;
  }
  const kind = typeof value;
  if (kind === 'boolean') {
    return value;
  }
  if (kind === 'number') {
    return Number.isFinite(value as number) ? (value as number).toFixed(6) : String(value);
  }
  if (kind === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParsed(item));
  }
  if (kind === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[camelize(key)] = normalizeParsed(source[key]);
    }
    return out;
  }
  return value;
}

function assertNoDiffs(nodeValue: unknown, pythonValue: unknown, at: string): void {
  const nodeNorm = normalizeParsed(nodeValue);
  const pythonNorm = normalizeParsed(pythonValue);
  const diffs: Diff[] = [];
  diffValues(nodeNorm, pythonNorm, at, diffs);
  if (diffs.length > 0) {
    const detail = diffs
      .map((d) => `  ${d.path}: node=${JSON.stringify(d.node)} python=${JSON.stringify(d.python)}`)
      .join('\n');
    console.error(`[disk-parse] ${at}: ${diffs.length} difference(s)\n${detail}`);
  }
  expect(diffs).toEqual([]);
}

interface ValueCase {
  name: string;
  op: string;
  fixture: string;
  arg?: string;
  node: () => unknown;
}

const VALUE_CASES: ValueCase[] = [
  {
    name: 'multi-controller controllers JSON',
    op: 'controllers',
    fixture: 'controllers_4090_multi.json',
    node: () => parseControllers(readFixture('controllers_4090_multi.json')),
  },
  {
    name: 'object-top-level controllers JSON with BBU state',
    op: 'controllers',
    fixture: 'controllers_top_level_object.json',
    node: () => parseControllers(readFixture('controllers_top_level_object.json')),
  },
  {
    name: 'virtual drives (RAID1 x2)',
    op: 'virtual',
    fixture: 'virtual_a100_c0.json',
    arg: '0',
    node: () => parseVirtualDrives(readFixture('virtual_a100_c0.json'), 0),
  },
  {
    name: 'controller with no virtual drives',
    op: 'virtual',
    fixture: 'virtual_none.json',
    arg: '0',
    node: () => parseVirtualDrives(readFixture('virtual_none.json'), 0),
  },
  {
    name: 'physical drives JSON (a100, 6 drives)',
    op: 'physical',
    fixture: 'physical_a100_c0.json',
    node: () => parsePhysicalDrives(readFixture('physical_a100_c0.json')),
  },
  {
    name: 'physical drives JSON (4090 controller 0)',
    op: 'physical',
    fixture: 'physical_4090_c0.json',
    node: () => parsePhysicalDrives(readFixture('physical_4090_c0.json')),
  },
  {
    name: 'physical drives JSON (4090 controller 1)',
    op: 'physical',
    fixture: 'physical_4090_c1.json',
    node: () => parsePhysicalDrives(readFixture('physical_4090_c1.json')),
  },
  {
    name: 'physical drives text (SAS/SATA mixed)',
    op: 'physical_text',
    fixture: 'physical_text_sas_sata.txt',
    node: () => parsePhysicalDrivesText(readFixture('physical_text_sas_sata.txt')),
  },
  {
    name: 'physical drives text (abnormal / malformed lines)',
    op: 'physical_text',
    fixture: 'physical_text_abnormal.txt',
    node: () => parsePhysicalDrivesText(readFixture('physical_text_abnormal.txt')),
  },
];

interface ErrorCase {
  name: string;
  op: string;
  fixture: string;
  arg?: string;
  run: () => unknown;
}

const ERROR_CASES: ErrorCase[] = [
  {
    name: 'permission-error transcript rejected by both stacks',
    op: 'physical',
    fixture: 'permission_error.txt',
    run: () => parsePhysicalDrives(readFixture('permission_error.txt')),
  },
  {
    name: 'top-level JSON array rejected by both stacks',
    op: 'controllers',
    fixture: 'controllers_top_level_array.json',
    run: () => parseControllers(readFixture('controllers_top_level_array.json')),
  },
];

const fixtureNames = readdirSync(FIXTURE_DIR).sort();

describe('disk/parse fixtures', () => {
  it('provides at least six fixture groups including the required edge cases', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(6);
    expect(fixtureNames).toEqual(
      expect.arrayContaining([
        'controllers_4090_multi.json',
        'virtual_none.json',
        'physical_text_sas_sata.txt',
        'physical_text_abnormal.txt',
        'permission_error.txt',
        'controllers_top_level_object.json',
      ]),
    );
  });
});

describe('disk/parse: Node port vs Python oracle', () => {
  for (const testCase of VALUE_CASES) {
    itPython(`${testCase.name} parses identically in both stacks`, () => {
      const python = runOracle(testCase.op, testCase.fixture, testCase.arg);
      expect(python.ok, python.message).toBe(true);
      assertNoDiffs(testCase.node(), python.value, testCase.fixture);
    });
  }

  for (const testCase of ERROR_CASES) {
    itPython(`${testCase.name}`, () => {
      expect(() => testCase.run()).toThrow(StorcliParseError);
      const python = runOracle(testCase.op, testCase.fixture, testCase.arg);
      expect(python.ok).toBe(false);
      expect(python.error).toBe('StorcliParseError');
    });
  }

  itPython('parseTemperature matches the oracle across variants', () => {
    const inputs: unknown[] = [' 27C (80.60 F)', 'N/A', null, 31, '-5C', 'unknown', '', '0C'];
    const nodeValues = inputs.map((value) => parseTemperature(value));
    // The fixture path is only opened to satisfy the oracle CLI; op=temperature
    // ignores its contents.
    const python = runOracle('temperature', 'virtual_none.json', JSON.stringify(inputs));
    expect(python.ok, python.message).toBe(true);
    assertNoDiffs(nodeValues, python.value, 'parseTemperature');
  });
});

describe('disk/parse Node-only sanity (mirrors tests/test_disk_parse.py)', () => {
  it('parses the a100 six-drive fixture as healthy Onln drives', () => {
    const drives = parsePhysicalDrives(readFixture('physical_a100_c0.json'));
    expect(drives).toHaveLength(6);
    for (const drive of drives) {
      expect(drive.state).toContain('Onln');
      expect(drive.mediaErrors).toBe(0);
      expect(drive.temperatureC).not.toBeNull();
      expect(drive.temperatureC as number).toBeGreaterThanOrEqual(20);
      expect(drive.temperatureC as number).toBeLessThanOrEqual(45);
    }
  });

  it('parses both 4090 controllers into 8 drives spanning controllers 0 and 1', () => {
    const drives = [
      ...parsePhysicalDrives(readFixture('physical_4090_c0.json')),
      ...parsePhysicalDrives(readFixture('physical_4090_c1.json')),
    ];
    expect(drives).toHaveLength(8);
    expect(new Set(drives.map((drive) => drive.controller))).toEqual(new Set([0, 1]));
  });

  it('extracts every detailed field from the first a100 drive', () => {
    const drive = parsePhysicalDrives(readFixture('physical_a100_c0.json'))[0];
    expect([drive.controller, drive.enclosure, drive.slot, drive.did]).toEqual([0, 252, 0, 9]);
    expect(drive.model).toBe('Samsung SSD 870 EVO 1TB');
    expect(drive.serial).toBe('S6PVNX0T205787W');
    expect(drive.smartAlert).toBe(false);
    expect(drive.shieldCounter).toBe(0);
    expect(drive.predictiveFailures).toBe(0);
  });

  it('parses the SAS/SATA mixed text fallback', () => {
    const drives = parsePhysicalDrivesText(readFixture('physical_text_sas_sata.txt'));
    expect(drives).toHaveLength(2);
    expect([drives[0].controller, drives[0].enclosure, drives[0].slot]).toEqual([0, 252, 3]);
    expect(drives[0].model).toBe('Samsung SSD 870 EVO 1TB');
    expect(drives[0].temperatureC).toBe(41);
    expect(drives[0].smartAlert).toBe(false);
    expect(drives[1].otherErrors).toBe(2);
    expect(drives[1].model).toBe('ST1200MM0088');
  });

  it('survives abnormal text lines and still reports the drives', () => {
    const drives = parsePhysicalDrivesText(readFixture('physical_text_abnormal.txt'));
    expect(drives).toHaveLength(2);
    expect(drives[0].mediaErrors).toBe(2);
    expect(drives[0].smartAlert).toBe(true);
    expect(drives[1].shieldCounter).toBe(4);
    expect(drives[1].model).toBe('HGST HUH721010AL');
    expect(drives[1].serial).toBe('7LGCXXXX');
  });

  it('returns [] from the text parser and throws from parsePhysicalDrives on a permission error', () => {
    expect(parsePhysicalDrivesText(readFixture('permission_error.txt'))).toEqual([]);
    expect(() => parsePhysicalDrives(readFixture('permission_error.txt'))).toThrow(StorcliParseError);
  });

  it('resolves BBU state from Cachevault_Info/State and from BBU_Info/Type', () => {
    const controllers = parseControllers(readFixture('controllers_top_level_object.json'));
    expect(controllers.map((controller) => controller.controller)).toEqual([0, 1]);
    expect(controllers[0].model).toBe('PERC H730 Mini');
    expect(controllers[0].firmware).toBe('25.5.6.0001');
    expect(controllers[0].bbuState).toBe('Optimal');
    expect(controllers[1].bbuState).toBe('iBBU');
  });

  it('parses a100 virtual drives with ids, raid level, state and size', () => {
    const vds = parseVirtualDrives(readFixture('virtual_a100_c0.json'), 0);
    expect(vds.map((vd) => vd.vdId)).toEqual([0, 1]);
    expect(vds[0].raidLevel).toBe('RAID1');
    expect(vds[0].state).toBe('Optl');
    expect(vds[1].size).toBe('21.830 TB');
  });

  it('returns [] when the controller reports no virtual drives', () => {
    expect(parseVirtualDrives(readFixture('virtual_none.json'), 0)).toEqual([]);
  });

  it('exports camelCase -> Python snake_case field maps that round-trip', () => {
    expect(CONTROLLER_FIELD_MAP).toEqual({
      controller: 'controller',
      model: 'model',
      firmware: 'firmware',
      bbuState: 'bbu_state',
      health: 'health',
      reasons: 'reasons',
    });
    expect(VIRTUAL_DRIVE_FIELD_MAP.vdId).toBe('vd_id');
    expect(VIRTUAL_DRIVE_FIELD_MAP.raidLevel).toBe('raid_level');
    expect(PHYSICAL_DRIVE_FIELD_MAP.mediaErrors).toBe('media_errors');
    expect(PHYSICAL_DRIVE_FIELD_MAP.otherErrors).toBe('other_errors');
    expect(PHYSICAL_DRIVE_FIELD_MAP.predictiveFailures).toBe('predictive_failures');
    expect(PHYSICAL_DRIVE_FIELD_MAP.smartAlert).toBe('smart_alert');
    expect(PHYSICAL_DRIVE_FIELD_MAP.temperatureC).toBe('temperature_c');
    expect(PHYSICAL_DRIVE_FIELD_MAP.shieldCounter).toBe('shield_counter');
    for (const map of [CONTROLLER_FIELD_MAP, VIRTUAL_DRIVE_FIELD_MAP, PHYSICAL_DRIVE_FIELD_MAP]) {
      for (const [camel, pythonName] of Object.entries(map)) {
        expect(camelize(pythonName)).toBe(camel);
      }
    }
  });
});
