/**
 * Tests for `backend/src/disk/evaluate.ts` — the 1:1 TypeScript port of the
 * disk-health evaluation helpers in `servermanage/disk_health.py`
 * (lines 529-653), plus the `AlertEvent` shape (`disk_health.py:102-127`).
 *
 * Three layers:
 *
 * 1. **Unit edge cases** mirroring the Python oracle: `_state_word` /
 *    `_increased` boundaries, the 54/55/56 °C threshold, error counters,
 *    predictive/SMART flags, rule toggles, state-word mapping, and the virtual-
 *    drive / controller-BBU state tables.
 * 2. **Python-oracle differential tests.** Each fixture scenario is evaluated
 *    by the Node port and by the real Python module
 *    (`servermanage.disk_health.evaluate_drive_health` etc., invoked in a
 *    read-only subprocess by `run_evaluate_oracle.py`). We compare the
 *    `{health, reasons}` result *and* the derived `AlertEvent` list
 *    (`servermanage.alerts.evaluate_disk_alerts`) so the localized title /
 *    message / fingerprint are covered too. An empty diff means the two stacks
 *    are observationally identical.
 * 3. **Immutability**: the evaluators return fresh copies and never mutate input.
 *
 * The oracle output is snake_case (`dataclasses.asdict`); the Node parse/evaluate
 * types are camelCase (`backend/src/disk/parse.ts`, P5 Task 3). For the
 * `{health, reasons}` comparison only those two keys are read, so no key
 * translation is needed. For `AlertEvent`s both sides already use snake_case
 * (`backend/src/alerts/rules.ts` mirrors the Python `AlertEvent`).
 *
 * If the Python interpreter / `servermanage.disk_health` is not importable the
 * differential suite is skipped; the Node-only suites still run.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { evaluateDiskAlerts } from '../../src/alerts/rules';
import {
  evaluateControllerHealth,
  evaluateDriveHealth,
  evaluateVirtualDriveHealth,
  increased,
  stateWord,
  type DiskHealthRuleConfig,
  type EvaluateDriveOptions,
} from '../../src/disk/evaluate';
import type {
  DiskControllerInfo,
  PhysicalDriveInfo,
  VirtualDriveInfo,
} from '../../src/disk/parse';
import { diffValues, findRepoRoot, normalizeValue, type Diff } from '../diff/harness';

// ---------------------------------------------------------------------------
// Fixture / oracle plumbing
// ---------------------------------------------------------------------------

const repoRoot = findRepoRoot();
const TEST_DIR = path.join(repoRoot, 'backend', 'test', 'disk');
const FIXTURE_PATH = path.join(TEST_DIR, 'fixtures', 'evaluate-scenarios.json');
const ORACLE_SCRIPT = path.join(TEST_DIR, 'run_evaluate_oracle.py');

function defaultPython(): string {
  return process.env.PYTHON ?? 'python';
}

function mergePythonPath(): string {
  const existing = process.env.PYTHONPATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  return existing ? `${repoRoot}${sep}${existing}` : repoRoot;
}

/** Probe once whether the Python disk_health + alerts oracles can run here. */
function detectOracle(): { ok: boolean; detail: string } {
  const result = spawnSync(
    defaultPython(),
    ['-c', 'import servermanage.disk_health, servermanage.alerts'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: mergePythonPath(), PYTHONWARNINGS: 'ignore' },
    },
  );
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
  console.warn(`Python disk-evaluate oracle unavailable; skipping diff groups: ${oracleProbe.detail}`);
}

interface OracleDriveEntry {
  name: string;
  result: { health: string; reasons: string[] };
  events: Array<Record<string, unknown>>;
}
interface OracleVdEntry {
  name: string;
  result: { health: string; reasons: string[] };
  events: Array<Record<string, unknown>>;
}
interface OracleControllerEntry {
  name: string;
  result: { health: string; reasons: string[] };
}
interface OracleOutput {
  drives: OracleDriveEntry[];
  virtual_drives: OracleVdEntry[];
  controllers: OracleControllerEntry[];
}

function runOracle(): OracleOutput {
  const result = spawnSync(defaultPython(), [ORACLE_SCRIPT, FIXTURE_PATH], {
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
      `python disk-evaluate oracle exited with status ${result.status}\nstderr:\n${result.stderr ?? ''}`,
    );
  }
  const lastLine = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    throw new Error('python disk-evaluate oracle produced no JSON output');
  }
  return JSON.parse(lastLine) as OracleOutput;
}

/** Read the fixture JSON once (drives + virtual_drives + controllers groups). */
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) as {
  drives: Array<Record<string, any>>;
  virtual_drives: Array<Record<string, any>>;
  controllers: Array<Record<string, any>>;
};

/** `snake_case` -> `camelCase` (`media_errors` -> `mediaErrors`). */
function camelize(key: string): string {
  return key.replace(/_([0-9a-zA-Z])/g, (_match, ch: string) => ch.toUpperCase());
}

function camelizeDeep<T = any>(value: unknown): T {
  if (Array.isArray(value)) {
    return value.map((item) => camelizeDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[camelize(key)] = camelizeDeep(item);
    }
    return out as T;
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Builders (camelCase Node inputs / snake_case alert inputs)
// ---------------------------------------------------------------------------

function makeDrive(overrides: Partial<PhysicalDriveInfo> = {}): PhysicalDriveInfo {
  return {
    controller: 0,
    enclosure: null,
    slot: null,
    did: null,
    model: null,
    serial: null,
    state: null,
    mediaErrors: null,
    otherErrors: null,
    predictiveFailures: null,
    smartAlert: null,
    temperatureC: null,
    shieldCounter: null,
    health: 'unknown',
    reasons: [],
    ...overrides,
  };
}

function makeVd(overrides: Partial<VirtualDriveInfo> = {}): VirtualDriveInfo {
  return {
    controller: 0,
    vdId: 0,
    raidLevel: null,
    state: null,
    size: null,
    health: 'unknown',
    reasons: [],
    ...overrides,
  };
}

function makeController(overrides: Partial<DiskControllerInfo> = {}): DiskControllerInfo {
  return {
    controller: 0,
    model: null,
    firmware: null,
    bbuState: null,
    health: 'unknown',
    reasons: [],
    ...overrides,
  };
}

function buildDrive(raw: Record<string, any>): PhysicalDriveInfo {
  const c = camelizeDeep<Record<string, any>>(raw);
  return makeDrive({
    controller: c.controller,
    enclosure: c.enclosure ?? null,
    slot: c.slot ?? null,
    did: c.did ?? null,
    model: c.model ?? null,
    serial: c.serial ?? null,
    state: c.state ?? null,
    mediaErrors: c.mediaErrors ?? null,
    otherErrors: c.otherErrors ?? null,
    predictiveFailures: c.predictiveFailures ?? null,
    smartAlert: c.smartAlert ?? null,
    temperatureC: c.temperatureC ?? null,
    shieldCounter: c.shieldCounter ?? null,
    health: c.health ?? 'unknown',
    reasons: c.reasons ?? [],
  });
}

function buildVd(raw: Record<string, any>): VirtualDriveInfo {
  const c = camelizeDeep<Record<string, any>>(raw);
  return makeVd({
    controller: c.controller,
    vdId: c.vdId,
    raidLevel: c.raidLevel ?? null,
    state: c.state ?? null,
    size: c.size ?? null,
    health: c.health ?? 'unknown',
    reasons: c.reasons ?? [],
  });
}

function buildController(raw: Record<string, any>): DiskControllerInfo {
  const c = camelizeDeep<Record<string, any>>(raw);
  return makeController({
    controller: c.controller,
    model: c.model ?? null,
    firmware: c.firmware ?? null,
    bbuState: c.bbuState ?? null,
    health: c.health ?? 'unknown',
    reasons: c.reasons ?? [],
  });
}

function driveOptions(scenario: Record<string, any>): EvaluateDriveOptions {
  const opts: EvaluateDriveOptions = {
    previous: scenario.previous ? buildDrive(scenario.previous) : null,
  };
  if (scenario.rules) {
    opts.rules = scenario.rules as DiskHealthRuleConfig;
  }
  if (scenario.temperature_threshold_c !== undefined) {
    opts.temperatureThresholdC = scenario.temperature_threshold_c as number;
  }
  return opts;
}

function assertNoDiffs(nodeValue: unknown, pythonValue: unknown, at: string): void {
  const diffs: Diff[] = [];
  diffValues(normalizeValue(nodeValue), normalizeValue(pythonValue), at, diffs);
  if (diffs.length > 0) {
    const detail = diffs
      .map((d) => `  ${d.path}: node=${JSON.stringify(d.node)} python=${JSON.stringify(d.python)}`)
      .join('\n');
    console.error(`[disk-evaluate] ${at}: ${diffs.length} difference(s)\n${detail}`);
  }
  expect(diffs).toEqual([]);
}

// ---------------------------------------------------------------------------
// 1. `_state_word`
// ---------------------------------------------------------------------------

describe('stateWord (_state_word)', () => {
  it('maps null/undefined to the empty string', () => {
    expect(stateWord(null)).toBe('');
    expect(stateWord(undefined)).toBe('');
  });

  it('trims, lowercases and collapses whitespace runs', () => {
    expect(stateWord('  Optimal  ')).toBe('optimal');
    expect(stateWord('FAILED')).toBe('failed');
    expect(stateWord('Partially   Degraded')).toBe('partially degraded');
    expect(stateWord('  Rebuild\t')).toBe('rebuild');
    expect(stateWord('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. `_increased`
// ---------------------------------------------------------------------------

describe('increased (_increased)', () => {
  it('is false when either side is missing', () => {
    expect(increased(null, null)).toBe(false);
    expect(increased(null, 5)).toBe(false);
    expect(increased(5, null)).toBe(false);
    expect(increased(undefined, 0)).toBe(false);
  });

  it('is false when the counter is unchanged or decreased', () => {
    expect(increased(0, 0)).toBe(false);
    expect(increased(0, 1)).toBe(false);
    expect(increased(5, 4)).toBe(true); // current 5 > previous 4
    expect(increased(4, 5)).toBe(false);
    expect(increased(1, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Physical drive evaluation — unit edges
// ---------------------------------------------------------------------------

describe('evaluateDriveHealth', () => {
  it('reports a failed state as critical and only state_failed', () => {
    const result = evaluateDriveHealth(makeDrive({ state: 'Failed' }));
    expect(result.health).toBe('critical');
    expect(result.reasons).toEqual(['state_failed']);
  });

  it('reports offline/missing/offln as critical too', () => {
    for (const state of ['Offline', 'Missing', 'Offln']) {
      expect(evaluateDriveHealth(makeDrive({ state })).reasons).toEqual(['state_failed']);
    }
  });

  it('reports a degraded/rebuild state as a warning', () => {
    expect(evaluateDriveHealth(makeDrive({ state: 'Degraded' }))).toMatchObject({
      health: 'warning',
      reasons: ['state_degraded'],
    });
    expect(evaluateDriveHealth(makeDrive({ state: 'Rebuild' }))).toMatchObject({
      health: 'warning',
      reasons: ['state_degraded'],
    });
  });

  it('leaves a healthy optimal drive without reasons', () => {
    expect(evaluateDriveHealth(makeDrive({ state: 'Optimal', temperatureC: 40 }))).toMatchObject({
      health: 'healthy',
      reasons: [],
    });
  });

  it('threshold is strict: 54 and 55 are healthy, 56 alerts', () => {
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 54 })).reasons).toEqual([]);
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 55 })).reasons).toEqual([]);
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 56 }))).toMatchObject({
      health: 'warning',
      reasons: ['temperature'],
    });
  });

  it('honours a custom temperature threshold', () => {
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 56 }), {
      temperatureThresholdC: 60,
    }).reasons).toEqual([]);
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 61 }), {
      temperatureThresholdC: 60,
    }).reasons).toEqual(['temperature']);
  });

  it('a null threshold disables the temperature check', () => {
    expect(evaluateDriveHealth(makeDrive({ temperatureC: 90 }), {
      temperatureThresholdC: null,
    }).reasons).toEqual([]);
  });

  it('media/other error counters > 0 warn (Python, not critical)', () => {
    expect(evaluateDriveHealth(makeDrive({ mediaErrors: 3 }))).toMatchObject({
      health: 'warning',
      reasons: ['media_errors'],
    });
    expect(evaluateDriveHealth(makeDrive({ otherErrors: 5 }))).toMatchObject({
      health: 'warning',
      reasons: ['other_errors'],
    });
  });

  it('predictive failures and SMART flags warn', () => {
    expect(evaluateDriveHealth(makeDrive({ predictiveFailures: 2 })).reasons).toEqual([
      'predictive_failure',
    ]);
    expect(evaluateDriveHealth(makeDrive({ smartAlert: true })).reasons).toEqual(['smart_flag']);
    // falsy values stay quiet
    expect(evaluateDriveHealth(makeDrive({ smartAlert: false, predictiveFailures: 0 })).reasons)
      .toEqual([]);
  });

  it('error-count growth (with a known previous) warns with error_increase', () => {
    const prev = makeDrive({ mediaErrors: 0, otherErrors: 0 });
    expect(evaluateDriveHealth(makeDrive({ mediaErrors: 1 }), { previous: prev }).reasons).toEqual([
      'media_errors',
      'error_increase',
    ]);
    const prevOther = makeDrive({ otherErrors: 1 });
    expect(evaluateDriveHealth(makeDrive({ otherErrors: 2 }), { previous: prevOther }).reasons)
      .toEqual(['other_errors', 'error_increase']);
  });

  it('unchanged counters never alert; a null previous cannot prove growth', () => {
    const same = makeDrive({ mediaErrors: 0, otherErrors: 0 });
    expect(evaluateDriveHealth(makeDrive({ mediaErrors: 0, otherErrors: 0 }), {
      previous: same,
    }).reasons).toEqual([]);
    expect(evaluateDriveHealth(makeDrive({ mediaErrors: 0, otherErrors: 0 }), {
      previous: null,
    }).reasons).toEqual([]);
  });

  it('respects rule toggles (media off, state off)', () => {
    expect(evaluateDriveHealth(makeDrive({ mediaErrors: 3 }), {
      rules: { alert_on_media_errors: false },
    }).reasons).toEqual([]);
    expect(evaluateDriveHealth(makeDrive({ state: 'Failed' }), {
      rules: { alert_on_state_not_optimal: false },
    })).toMatchObject({ health: 'healthy', reasons: [] });
  });

  it('never mutates the input drive', () => {
    const drive = makeDrive({ state: 'Failed', mediaErrors: 4 });
    const snapshot = JSON.parse(JSON.stringify(drive));
    evaluateDriveHealth(drive, { previous: makeDrive({ mediaErrors: 1 }) });
    expect(drive).toEqual(snapshot);
  });

  it('appends reasons in the fixed oracle order', () => {
    const drive = makeDrive({
      state: 'Degraded',
      predictiveFailures: 1,
      smartAlert: true,
      mediaErrors: 2,
      otherErrors: 3,
      temperatureC: 60,
    });
    expect(evaluateDriveHealth(drive, { previous: makeDrive({ mediaErrors: 1 }) }).reasons).toEqual([
      'state_degraded',
      'predictive_failure',
      'smart_flag',
      'media_errors',
      'other_errors',
      'error_increase',
      'temperature',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Virtual-drive evaluation
// ---------------------------------------------------------------------------

describe('evaluateVirtualDriveHealth', () => {
  it('maps each state word to the oracle health/reason', () => {
    const cases: Array<[string | null, string, string[]]> = [
      ['Optimal', 'healthy', []],
      ['Optl', 'healthy', []],
      ['Online', 'healthy', []],
      ['Onln', 'healthy', []],
      ['Degraded', 'warning', ['state_degraded']],
      ['Partially   Degraded', 'warning', ['state_degraded']],
      ['Rebuild', 'warning', ['state_degraded']],
      ['Init', 'warning', ['state_degraded']],
      ['Failed', 'critical', ['state_failed']],
      ['Offline', 'critical', ['state_failed']],
      ['Missing', 'critical', ['state_failed']],
      ['Weird', 'warning', ['state_degraded']],
      [null, 'unknown', []],
      ['', 'unknown', []],
    ];
    for (const [state, health, reasons] of cases) {
      expect(evaluateVirtualDriveHealth(makeVd({ state }))).toMatchObject({ health, reasons });
    }
  });

  it('never mutates the input virtual drive', () => {
    const vd = makeVd({ state: 'Failed' });
    const snapshot = JSON.parse(JSON.stringify(vd));
    evaluateVirtualDriveHealth(vd);
    expect(vd).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// 5. Controller (BBU) evaluation
// ---------------------------------------------------------------------------

describe('evaluateControllerHealth', () => {
  it('leaves health untouched (unknown) when the BBU state is missing', () => {
    expect(evaluateControllerHealth(makeController({ bbuState: null }))).toMatchObject({
      health: 'unknown',
      reasons: [],
    });
    expect(evaluateControllerHealth(makeController({ bbuState: '' }))).toMatchObject({
      health: 'unknown',
      reasons: [],
    });
  });

  it('warns when the BBU state contains a failure word (substring match)', () => {
    for (const bbu of ['Failed', 'Fault', 'Degraded', 'Offline', 'Replace']) {
      expect(evaluateControllerHealth(makeController({ bbuState: bbu }))).toMatchObject({
        health: 'warning',
        reasons: ['bbu_not_optimal'],
      });
    }
  });

  it('is healthy for a healthy BBU state', () => {
    expect(evaluateControllerHealth(makeController({ bbuState: 'Optimal' }))).toMatchObject({
      health: 'healthy',
      reasons: [],
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Python-oracle differential tests
// ---------------------------------------------------------------------------

describe('differential: evaluate_drive_health', () => {
  itPython('Node {health,reasons} matches the Python oracle for every drive scenario', () => {
    const oracle = runOracle();
    const byName = new Map(oracle.drives.map((entry) => [entry.name, entry]));
    expect(byName.size).toBe(fixture.drives.length);
    for (const scenario of fixture.drives) {
      const entry = byName.get(scenario.name);
      expect(entry, `missing oracle drive scenario ${scenario.name}`).toBeDefined();
      const result = evaluateDriveHealth(buildDrive(scenario.drive), driveOptions(scenario));
      assertNoDiffs(
        { health: result.health, reasons: result.reasons },
        entry!.result,
        `drive[${scenario.name}]`,
      );
    }
  });

  itPython('derived physical-drive AlertEvents match the Python oracle', () => {
    const oracle = runOracle();
    const byName = new Map(oracle.drives.map((entry) => [entry.name, entry]));
    for (const scenario of fixture.drives) {
      const entry = byName.get(scenario.name)!;
      const result = evaluateDriveHealth(buildDrive(scenario.drive), driveOptions(scenario));
      const events = evaluateDiskAlerts({
        host_name: 'oracle-host',
        status: 'ok',
        physical_drives: [
          { ...(scenario.drive as Record<string, unknown>), health: result.health, reasons: result.reasons },
        ],
      });
      assertNoDiffs(events, entry.events, `drive-events[${scenario.name}]`);
    }
  });
});

describe('differential: evaluate_virtual_drive_health', () => {
  itPython('Node {health,reasons} matches the Python oracle for every VD scenario', () => {
    const oracle = runOracle();
    const byName = new Map(oracle.virtual_drives.map((entry) => [entry.name, entry]));
    expect(byName.size).toBe(fixture.virtual_drives.length);
    for (const scenario of fixture.virtual_drives) {
      const entry = byName.get(scenario.name);
      expect(entry, `missing oracle VD scenario ${scenario.name}`).toBeDefined();
      const result = evaluateVirtualDriveHealth(buildVd(scenario.vd));
      assertNoDiffs(
        { health: result.health, reasons: result.reasons },
        entry!.result,
        `vd[${scenario.name}]`,
      );
    }
  });

  itPython('derived virtual-drive AlertEvents match the Python oracle', () => {
    const oracle = runOracle();
    const byName = new Map(oracle.virtual_drives.map((entry) => [entry.name, entry]));
    for (const scenario of fixture.virtual_drives) {
      const entry = byName.get(scenario.name)!;
      const result = evaluateVirtualDriveHealth(buildVd(scenario.vd));
      const events = evaluateDiskAlerts({
        host_name: 'oracle-host',
        status: 'ok',
        virtual_drives: [
          { ...(scenario.vd as Record<string, unknown>), health: result.health, reasons: result.reasons },
        ],
      });
      assertNoDiffs(events, entry.events, `vd-events[${scenario.name}]`);
    }
  });
});

describe('differential: _evaluate_controller_health', () => {
  itPython('Node {health,reasons} matches the Python oracle for every controller scenario', () => {
    const oracle = runOracle();
    const byName = new Map(oracle.controllers.map((entry) => [entry.name, entry]));
    expect(byName.size).toBe(fixture.controllers.length);
    for (const scenario of fixture.controllers) {
      const entry = byName.get(scenario.name);
      expect(entry, `missing oracle controller scenario ${scenario.name}`).toBeDefined();
      const result = evaluateControllerHealth(buildController(scenario.controller));
      assertNoDiffs(
        { health: result.health, reasons: result.reasons },
        entry!.result,
        `controller[${scenario.name}]`,
      );
    }
  });
});
