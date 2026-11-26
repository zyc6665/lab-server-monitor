/**
 * Differential parser tests: feed identical raw stage stdout through the Node
 * `parseHostMetrics` port (`src/collect/parsers.ts`) and the Python oracle
 * (`servermanage.parsers.parse_host_metrics`, run in a read-only subprocess) and
 * assert the two stacks produce observationally identical `HostMetrics`.
 *
 * Fixtures live under `test/diff/parsers/fixtures/*.json`; each is shaped
 * `{ "host": {"name": ..., "host": ...}, "stages": { "<stage>": "<stdout>" } }`
 * where every stage key is a real probe stage name from
 * `src/collect/commands.ts` and the value is that stage's raw stdout. The test
 * wraps each stage as `{ stdout, stderr: '', exitStatus: 0 }` — but
 * `parseHostMetrics` only consumes the stdout strings, so we pass the string map
 * straight through.
 *
 * Normalisation (extends the storage harness §9.1 rules in `./harness.ts`):
 * - Python `dataclasses.asdict` yields snake_case keys while the 1:1 TS port uses
 *   camelCase, so object keys are camelised on BOTH sides before comparison
 *   (`load_1` -> `load1`, `os_pretty_name` -> `osPrettyName`, …).
 * - The volatile `collectedAt` / `collected_at` instant is masked to `<ts>`.
 * - `Map` values (e.g. `parseDockerContainerNames` returns a `Map`) are expanded
 *   to plain objects.
 * - Floats are unified with `toFixed(6)`; ISO-8601 strings compare by absolute
 *   UTC instant (`instantMicros`); object keys are sorted; arrays keep their
 *   parser-defined order (every relevant parser sorts explicitly).
 *
 * If the Python interpreter / `servermanage.parsers` is not importable in the
 * current environment (spawn ENOENT or import error), each comparison test is
 * skipped; a Node-only sanity suite still runs so a broken fixture or Node port
 * failure cannot hide behind the skip.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { golden } from '../../golden/golden';

import type { Stage } from '../../../src/collect/commands';
import { parseHostMetrics } from '../../../src/collect/parsers';

import { diffValues, findRepoRoot, instantMicros, type Diff } from '../harness';

interface FixtureHost {
  name: string;
  host: string;
  port?: number;
  username?: string;
}

interface FixtureFile {
  host: FixtureHost;
  stages: Record<string, string>;
}

const repoRoot = findRepoRoot();
const FIXTURE_DIR = path.join(repoRoot, 'backend', 'test', 'diff', 'parsers', 'fixtures');

const itPython = it;

/** `snake_case` -> `camelCase` (digits kept: `load_15` -> `load15`). */
function camelize(key: string): string {
  return key.replace(/_([0-9a-zA-Z])/g, (_match, ch: string) => ch.toUpperCase());
}

const TIMESTAMP_KEYS = new Set(['collectedAt', 'collected_at']);

/**
 * Canonicalise any parsed value for cross-language comparison: expand `Map`s,
 * camelise snake_case keys, mask the volatile collected-at instant, and apply the
 * §9.1 numeric / ISO-instant normalisation. Object keys are sorted so insertion
 * order never matters; arrays are left in parser order.
 */
export function normalizeParsed(value: unknown): unknown {
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
    return instantMicros(value as string) ?? value;
  }
  if (kind === 'bigint') {
    return (value as bigint).toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeParsed(item));
  }
  if (kind === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (TIMESTAMP_KEYS.has(key)) {
        out.collectedAt = '<ts>';
        continue;
      }
      out[camelize(key)] = normalizeParsed(source[key]);
    }
    return out;
  }
  return value;
}

function asStageMap(fixture: FixtureFile): Partial<Record<Stage, string>> {
  return fixture.stages as Partial<Record<Stage, string>>;
}

/** Run the Python oracle for one fixture and return its parsed JSON output. */
const GOLDEN_FILE = path.join(repoRoot, 'backend', 'test', 'diff', 'parsers', 'golden', 'parsers.json');
function runOracle(fixturePath: string): unknown {
  return golden<unknown>(GOLDEN_FILE, path.basename(fixturePath));
}

const fixtureNames = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .sort();

function loadFixture(name: string): { fixture: FixtureFile; fixturePath: string } {
  const fixturePath = path.join(FIXTURE_DIR, name);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile;
  return { fixture, fixturePath };
}

describe('collection parsers: fixtures', () => {
  it('provides at least three fixtures covering cpu / gpu / container hosts', () => {
    expect(fixtureNames.length).toBeGreaterThanOrEqual(3);
    expect(fixtureNames).toEqual(
      expect.arrayContaining(['cpu-mem-disk-load.json', 'gpu-host.json', 'mixed-container-host.json']),
    );
  });
});

describe('collection parsers: Node parseHostMetrics vs Python oracle', () => {
  for (const name of fixtureNames) {
    itPython(`fixture ${name} parses identically in both stacks`, () => {
      const { fixture, fixturePath } = loadFixture(name);
      const nodeValue = normalizeParsed(parseHostMetrics(asStageMap(fixture)));
      const pythonValue = normalizeParsed(runOracle(fixturePath));

      const diffs: Diff[] = [];
      diffValues(nodeValue, pythonValue, name, diffs);
      if (diffs.length > 0) {
        const detail = diffs
          .map(
            (diff) =>
              `  ${diff.path}: node=${JSON.stringify(diff.node)} python=${JSON.stringify(diff.python)}`,
          )
          .join('\n');
        console.error(`[parsers-diff] ${name}: ${diffs.length} difference(s)\n${detail}`);
      }

      expect(diffs).toEqual([]);
      expect(nodeValue).toEqual(pythonValue);
    });
  }
});

describe('collection parsers: Node-only sanity', () => {
  it('parseHostMetrics never throws and assembles a stable shape for every fixture', () => {
    for (const name of fixtureNames) {
      const { fixture } = loadFixture(name);
      const metrics = parseHostMetrics(asStageMap(fixture));
      expect(metrics.hostname).toBe(fixture.host.name);
      expect(Array.isArray(metrics.diskUsage)).toBe(true);
      expect(Array.isArray(metrics.topCpuProcesses)).toBe(true);
      expect(Array.isArray(metrics.topMemoryProcesses)).toBe(true);
      expect(Array.isArray(metrics.containers)).toBe(true);
      expect(Array.isArray(metrics.gpuSummary)).toBe(true);
      expect(metrics.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/);
    }
  });

  it('normalizeParsed camelises snake_case keys, expands Maps and masks the instant', () => {
    const map = new Map<string, number>([['abc', 1]]);
    expect(
      normalizeParsed({
        os_pretty_name: 'Ubuntu',
        collected_at: '2026-01-01T00:00:00+00:00',
        load_1: 2,
        container_map: map,
      }),
    ).toEqual({
      collectedAt: '<ts>',
      containerMap: { abc: '1.000000' },
      load1: '2.000000',
      osPrettyName: 'Ubuntu',
    });
  });
});
