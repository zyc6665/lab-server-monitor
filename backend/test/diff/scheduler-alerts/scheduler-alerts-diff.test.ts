/**
 * P4 Task11 — differential / control tests for the schedule & alert subsystems.
 *
 * Two independent comparisons against the Python source-of-truth oracle
 * (`run_schedule_oracle.py`, run in a read-only subprocess):
 *
 *  1. Time semantics: the Node port `src/runtime/schedule-time.ts`
 *     (`shouldRun` / `computeDailyFire` / `computeWeeklyFire` /
 *     `currentPeriodTarget` / `isReportDue`) must match
 *     `servermanage/scheduler.py` (`should_run:135-152`,
 *     `compute_daily_fire:155-166`, `compute_weekly_fire:169-185`,
 *     `_current_period_target:188-223`, `is_report_due:226-253`) over every row
 *     in `fixtures/time_points.json`.
 *
 *  2. Alert engine: the Node port `src/alerts/engine.ts` (`AlertEngine`) driven
 *     with a real temp SQLite database + a fake clock + a recording notifier
 *     must match the REAL `servermanage.alerts.AlertEngine` (silence/cooldown/
 *     ack/error-increase/retry/recovery/aggregate rules, see the oracle's module
 *     docstring for the exact `servermanage/alerts.py` line map) over every
 *     scenario in `fixtures/scenarios.json`.
 *
 * The comparison records, after every scenario step, the engine's returned
 * `notified` events plus the notifier dispatch log (`{events, channels}`), then
 * diffs the whole structure with `diffValues` and asserts `diff == []`.
 *
 * Consecutive-period ("streak") gating is intentionally NOT part of the engine
 * comparison: Python keeps it in `servermanage/app.py` while the Node port folds
 * it into `AlertEngine.process` (`engine.ts:34-37`).  Every fixture sets
 * `consecutive_periods = 1` so the folded gate is a pass-through and the shared
 * engine logic is compared 1:1; streak > 1 is covered by the dedicated
 * `backend/test/alerts/streak.ts` unit tests instead.
 *
 * When the Python interpreter / `servermanage` package is unavailable, the diff
 * tests are skipped and a Node-only sanity suite still runs so a broken fixture
 * or Node port cannot hide behind the skip.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AlertEngine,
  type AlertsConfig,
  type NotifierProtocol,
} from '../../../src/alerts/engine';
import type { AlertEvent } from '../../../src/alerts/rules';
import { SilenceRegistry } from '../../../src/alerts/silence';
import {
  computeDailyFire,
  computeWeeklyFire,
  currentPeriodTarget,
  isReportDue,
  shouldRun,
  toLocalWall,
} from '../../../src/runtime/schedule-time';
import {
  insertSilence,
  listOpenAlertsForHost,
  updateAlert,
} from '../../../src/storage/alerts';
import { cleanupStorageTests, freshDb } from '../../storage-helpers';

import { diffValues, findRepoRoot, type Diff } from '../harness';

afterEach(cleanupStorageTests);

// ---------------------------------------------------------------------------
// Fixtures / paths
// ---------------------------------------------------------------------------
const repoRoot = findRepoRoot();
const DIR = path.join(repoRoot, 'backend', 'test', 'diff', 'scheduler-alerts');
const FIXTURE_DIR = path.join(DIR, 'fixtures');
const ORACLE_SCRIPT = path.join(DIR, 'run_schedule_oracle.py');

interface TimePointFixture {
  id: string;
  tz: string;
  nowUtc: string;
  intervalSeconds: number;
  lastRunLocal: string | null;
  dailyHhmm: string;
  weeklyWeekday: number;
  weeklyHhmm: string;
  reportSpacingDays: number;
  reportHhmm: string;
  reportWeekday: number | null;
  reportLastRunLocal: string | null;
}

interface RawEvent {
  host_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  reasons?: string[];
}

interface SilenceSpec {
  scopeType: string;
  scope: string | null;
  reason: string;
  startsAt: string;
  endsAt: string;
}

interface StepSpec {
  at: string;
  action: 'process' | 'ack' | 'resolve' | 'resolve_missing';
  accept?: string[];
  events?: RawEvent[];
  host?: string;
  category?: string | null;
  notify?: boolean;
  active_fingerprints?: string[];
  skip_prefixes?: string[];
}

interface ScenarioSpec {
  id: string;
  config: {
    enabled: boolean;
    cooldown_minutes: number;
    repeat_while_active: boolean;
    aggregate_by_host: boolean;
    notify_on_recovery: boolean;
    consecutive_periods: number;
  };
  hostGroups?: Record<string, string[]>;
  silences?: SilenceSpec[];
  steps: StepSpec[];
}

interface NormEvent {
  host_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  reasons: string[];
}

interface DispatchEntry {
  events: NormEvent[];
  channels: string[];
}

interface OraclePayload {
  pythonVersion: string;
  timePoints: Array<Record<string, unknown>>;
  scenarios: Array<Record<string, unknown>>;
}

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf-8')) as T;
}

// ---------------------------------------------------------------------------
// Python oracle invocation
// ---------------------------------------------------------------------------
function defaultPython(): string {
  return process.env.PYTHON ?? 'python';
}

function mergePythonPath(): string {
  const existing = process.env.PYTHONPATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  return existing ? `${repoRoot}${sep}${existing}` : repoRoot;
}

function detectPython(): { ok: boolean; detail: string } {
  const result = spawnSync(
    defaultPython(),
    ['-c', 'import servermanage.alerts, servermanage.scheduler'],
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
    return {
      ok: false,
      detail: `exit ${result.status}: ${(result.stderr ?? '').trim()}`,
    };
  }
  return { ok: true, detail: 'ok' };
}

const pythonProbe = detectPython();
const itPython = pythonProbe.ok ? it : it.skip;
if (!pythonProbe.ok) {
  console.warn(
    `Python scheduler/alerts oracle unavailable; skipping diff groups: ${pythonProbe.detail}`,
  );
}

let oracleCache: OraclePayload | null = null;

function runOracle(): OraclePayload {
  if (oracleCache !== null) {
    return oracleCache;
  }
  const result = spawnSync(defaultPython(), [ORACLE_SCRIPT], {
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
      `python scheduler-alerts oracle exited with status ${result.status}\nstderr:\n${
        result.stderr ?? ''
      }`,
    );
  }
  const lastLine = (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .pop();
  if (!lastLine) {
    throw new Error('python scheduler-alerts oracle produced no JSON output');
  }
  oracleCache = JSON.parse(lastLine) as OraclePayload;
  return oracleCache;
}

// ---------------------------------------------------------------------------
// Civil (wall-clock) date helpers — UTC getters represent the local wall clock.
// ---------------------------------------------------------------------------
function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function fmtWall(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

function parseWall(value: string | null): Date | null {
  if (value === null) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`unexpected wall-clock value: ${value}`);
  }
  const [, y, mo, d, h, mi, s] = match;
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  );
}

// ---------------------------------------------------------------------------
// Time-semantics comparison
// ---------------------------------------------------------------------------
function buildNodeTimePoint(tp: TimePointFixture): Record<string, unknown> {
  const nowLocal = toLocalWall(new Date(tp.nowUtc), tp.tz);
  const dailyFire = computeDailyFire(nowLocal, tp.dailyHhmm);
  const weeklyFire = computeWeeklyFire(nowLocal, tp.weeklyWeekday, tp.weeklyHhmm);
  const periodTarget = currentPeriodTarget(
    nowLocal,
    tp.reportSpacingDays,
    tp.reportHhmm,
    tp.reportWeekday === null ? undefined : tp.reportWeekday,
  );
  return {
    id: tp.id,
    tz: tp.tz,
    nowUtc: tp.nowUtc,
    nowLocal: fmtWall(nowLocal),
    dailyFire: fmtWall(dailyFire),
    weeklyFire: fmtWall(weeklyFire),
    periodTarget: fmtWall(periodTarget),
    shouldRun: shouldRun(parseWall(tp.lastRunLocal), nowLocal, tp.intervalSeconds),
    reportDue: isReportDue(nowLocal, parseWall(tp.reportLastRunLocal), periodTarget),
  };
}

// ---------------------------------------------------------------------------
// Alert-engine comparison helpers
// ---------------------------------------------------------------------------
function normEvent(event: AlertEvent): NormEvent {
  return {
    host_name: event.host_name,
    category: event.category,
    severity: event.severity,
    title: event.title,
    message: event.message,
    fingerprint: event.fingerprint,
    reasons: [...(event.reasons ?? [])],
  };
}

function makeEvent(raw: RawEvent): AlertEvent {
  return {
    host_name: raw.host_name,
    category: raw.category,
    severity: raw.severity,
    title: raw.title,
    message: raw.message,
    fingerprint: raw.fingerprint,
    reasons: [...(raw.reasons ?? [])],
  };
}

function buildConfig(raw: ScenarioSpec['config']): AlertsConfig {
  return {
    enabled: raw.enabled,
    desktop_notification: true,
    email: true,
    cooldown_minutes: raw.cooldown_minutes,
    repeat_while_active: raw.repeat_while_active,
    aggregate_by_host: raw.aggregate_by_host,
    notify_on_recovery: raw.notify_on_recovery,
    consecutive_periods: raw.consecutive_periods,
    webhook: null,
  };
}

interface RecordingNotifier extends NotifierProtocol {
  reset(channels: string[]): void;
  take(): DispatchEntry[];
}

/** Notifier that records `{events, channels}` exactly like the Python oracle's. */
function makeRecordingNotifier(): RecordingNotifier {
  let accept: string[] = [];
  let log: DispatchEntry[] = [];
  return {
    reset(channels: string[]): void {
      accept = [...channels];
      log = [];
    },
    take(): DispatchEntry[] {
      return log;
    },
    dispatch(event: AlertEvent): string[] {
      const channels = [...accept];
      log.push({ events: [normEvent(event)], channels });
      return channels;
    },
    dispatchBatch(events: AlertEvent[]): string[] {
      const channels = [...accept];
      log.push({ events: events.map(normEvent), channels });
      return channels;
    },
  };
}

async function runNodeScenario(sc: ScenarioSpec): Promise<Record<string, unknown>> {
  const { db } = freshDb();
  let clockNow = new Date(sc.steps[0]?.at ?? '2026-01-01T00:00:00Z');

  for (const silence of sc.silences ?? []) {
    insertSilence(
      db,
      silence.scopeType,
      silence.scope,
      silence.reason,
      silence.startsAt,
      silence.endsAt,
      null,
    );
  }

  const notifier = makeRecordingNotifier();
  const engine = new AlertEngine({
    db,
    config: buildConfig(sc.config),
    notifier,
    silences: new SilenceRegistry(db),
    now: () => clockNow,
    hostGroups: sc.hostGroups ?? null,
  });

  const steps: Array<Record<string, unknown>> = [];
  for (const step of sc.steps) {
    clockNow = new Date(step.at);
    const channels = step.accept !== undefined ? [...step.accept] : ['desktop'];
    notifier.reset(channels);
    let notified: NormEvent[] = [];

    switch (step.action) {
      case 'process': {
        const result = await engine.process((step.events ?? []).map(makeEvent));
        notified = result.map(normEvent);
        break;
      }
      case 'ack': {
        const rows = listOpenAlertsForHost(
          db,
          step.host as string,
          step.category !== undefined && step.category !== null
            ? { category: step.category }
            : {},
        );
        for (const row of rows) {
          updateAlert(db, row.id, {
            status: 'acknowledged',
            ackAt: clockNow.toISOString(),
          });
        }
        break;
      }
      case 'resolve': {
        const result = await engine.resolve(step.host as string, step.category as string, {
          notify: step.notify ?? true,
        });
        notified = result.map(normEvent);
        break;
      }
      case 'resolve_missing': {
        const result = await engine.resolve_missing(
          step.host as string,
          step.active_fingerprints ?? [],
          {
            category: step.category ?? undefined,
            skip_prefixes: step.skip_prefixes ?? [],
            notify: step.notify ?? true,
          },
        );
        notified = result.map(normEvent);
        break;
      }
      default:
        throw new Error(`unknown step action: ${String(step.action)}`);
    }

    steps.push({
      action: step.action,
      at: step.at,
      notified,
      dispatched: notifier.take(),
    });
  }

  return { id: sc.id, steps };
}

function reportDiffs(label: string, diffs: Diff[]): void {
  if (diffs.length > 0) {
    const lines = diffs
      .slice(0, 50)
      .map(
        (d) =>
          `  - ${d.path}: node=${JSON.stringify(d.node)} python=${JSON.stringify(d.python)}`,
      );
    console.error(
      `[scheduler-alerts-diff] ${label}: ${diffs.length} difference(s)\n${lines.join('\n')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('P4 Task11 scheduler-alerts differential', () => {
  itPython('time semantics match the Python scheduler oracle', () => {
    const oracle = runOracle();
    const fixture = loadJson<{ timePoints: TimePointFixture[] }>('time_points.json');
    const nodePoints = fixture.timePoints.map(buildNodeTimePoint);

    const diffs: Diff[] = [];
    diffValues(nodePoints, oracle.timePoints, 'timePoints', diffs);
    reportDiffs('time points', diffs);
    expect(diffs).toEqual([]);
    expect(nodePoints).toHaveLength(oracle.timePoints.length);
  });

  itPython('alert engine matches the Python AlertEngine over all scenarios', async () => {
    const oracle = runOracle();
    const fixture = loadJson<{ scenarios: ScenarioSpec[] }>('scenarios.json');

    const nodeScenarios: Array<Record<string, unknown>> = [];
    for (const scenario of fixture.scenarios) {
      nodeScenarios.push(await runNodeScenario(scenario));
    }

    const diffs: Diff[] = [];
    diffValues(nodeScenarios, oracle.scenarios, 'scenarios', diffs);
    reportDiffs('alert scenarios', diffs);
    expect(diffs).toEqual([]);
    expect(nodeScenarios).toHaveLength(oracle.scenarios.length);
  });

  // Node-only guard: fails fast if fixtures are broken even when Python is
  // unavailable, and proves the ports are wired together.
  it('Node-only sanity: fixtures are well-formed and the ports run', () => {
    const timeFixture = loadJson<{ timePoints: TimePointFixture[] }>('time_points.json');
    const scenarioFixture = loadJson<{ scenarios: ScenarioSpec[] }>('scenarios.json');

    expect(timeFixture.timePoints.length).toBeGreaterThanOrEqual(20);
    expect(scenarioFixture.scenarios).toHaveLength(12);

    const point = buildNodeTimePoint(timeFixture.timePoints[0]!);
    expect(typeof point.nowLocal).toBe('string');
    expect(point.nowLocal).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);

    const actions = new Set<string>();
    for (const scenario of scenarioFixture.scenarios) {
      expect(scenario.steps.length).toBeGreaterThan(0);
      for (const step of scenario.steps) {
        actions.add(step.action);
      }
    }
    expect(actions).toEqual(
      new Set(['process', 'ack', 'resolve', 'resolve_missing']),
    );
  });
});
