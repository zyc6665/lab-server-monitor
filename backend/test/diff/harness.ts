/**
 * Differential-testing harness for the storage read paths.
 *
 * Given a seeded SQLite database and a set of *named queries*, each query is
 * executed twice — once through the production Node/TypeScript storage
 * functions and once through the Python oracle (`servermanage.storage`, invoked
 * in a read-only subprocess) — and the two results are normalised per plan
 * §9.1 before being compared. {@link runDiff} returns the list of differences;
 * an empty list means the two stacks are observationally identical.
 *
 * Normalisation (§9.1)
 * ---------------------
 * - ISO-8601 timestamps are parsed back to absolute UTC instants (µs precision)
 *   so `+00:00` vs `Z` vs `+08:00` renderings of the same moment compare equal.
 * - Floats are unified with `toFixed(6)` (relative error well below 1e-6).
 * - Object keys are compared as sets (insertion order is irrelevant).
 * - Ordering of sets is deterministic because every covered query carries an
 *   explicit `ORDER BY` on both sides; a caller may pass a per-query
 *   `normalize` override when it needs a bespoke sort key.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../../src/storage/db';

type SqliteDatabase = import('better-sqlite3').Database;

/** One difference between the Node and Python results at a JSON path. */
export interface Diff {
  path: string;
  node: unknown;
  python: unknown;
}

/** Describes how the Python oracle should answer a query. */
export interface PythonQuery {
  /** Registry key understood by `run_python_oracle.py` (`HANDLERS`). */
  op: string;
  args?: Record<string, unknown>;
}

/** A single named comparison case. */
export interface QueryCase {
  name: string;
  python: PythonQuery;
  /** Node implementation, evaluated against a read-only handle to the fixture. */
  node: (db: SqliteDatabase) => unknown;
  /** Optional override applied to BOTH sides before diffing (defaults to §9.1). */
  normalize?: (value: unknown) => unknown;
}

export interface RunDiffOptions {
  repoRoot?: string;
  python?: string;
  /**
   * Object keys whose values are volatile per §9.1 (dynamic ports, PIDs, …) and
   * must be masked before comparison. Applied recursively to both sides.
   */
  maskKeys?: string[];
}

/** ISO-8601 date-time with clock, optional fraction and offset/Z. */
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Parses an ISO date-time string to a canonical UTC instant measured in
 * microseconds (`@t:<micros>`); returns `null` when the string is not a
 * timestamp. Naive strings (no offset) are treated as UTC, matching the
 * storage modules.
 */
export function instantMicros(text: string): string | null {
  const match = ISO_DATETIME.exec(text);
  if (!match) {
    return null;
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const micro = frac ? Number((frac + '000000').slice(0, 6)) : 0;
  let epochMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(micro / 1000),
  );
  if (offset !== 'Z') {
    const sign = offset[0] === '-' ? -1 : 1;
    const [oh, om] = offset.slice(1).split(':').map(Number);
    epochMs -= sign * (oh * 60 + om) * 60000;
  }
  const totalMicros = epochMs * 1000 + (micro % 1000);
  return `@t:${totalMicros}`;
}

/** Normalises a single value per §9.1 (recursively). */
export function normalizeValue(value: unknown): unknown {
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
    return value.map((item) => normalizeValue(item));
  }
  if (kind === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = normalizeValue(source[key]);
    }
    return out;
  }
  return value;
}

/** Recursively replaces the values of `keys` with a fixed mask token (§9.1). */
export function applyMask(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => applyMask(item, keys));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = keys.includes(key) ? '<masked>' : applyMask(item, keys);
    }
    return out;
  }
  return value;
}

/** Recursively collects structural differences between two normalised values. */
export function diffValues(node: unknown, python: unknown, at: string, out: Diff[]): void {
  if (node === python) {
    return;
  }
  const nodeIsObject = typeof node === 'object' && node !== null;
  const pythonIsObject = typeof python === 'object' && python !== null;
  if (!nodeIsObject || !pythonIsObject) {
    out.push({ path: at, node, python });
    return;
  }
  const nodeIsArray = Array.isArray(node);
  const pythonIsArray = Array.isArray(python);
  if (nodeIsArray || pythonIsArray) {
    if (!nodeIsArray || !pythonIsArray) {
      out.push({ path: at, node, python });
      return;
    }
    const nodeArr = node as unknown[];
    const pythonArr = python as unknown[];
    if (nodeArr.length !== pythonArr.length) {
      out.push({ path: `${at} (length)`, node: nodeArr.length, python: pythonArr.length });
    }
    const limit = Math.min(nodeArr.length, pythonArr.length);
    for (let i = 0; i < limit; i += 1) {
      diffValues(nodeArr[i], pythonArr[i], `${at}[${i}]`, out);
    }
    return;
  }
  const nodeObj = node as Record<string, unknown>;
  const pythonObj = python as Record<string, unknown>;
  const keys = new Set([...Object.keys(nodeObj), ...Object.keys(pythonObj)]);
  for (const key of [...keys].sort()) {
    const inNode = Object.prototype.hasOwnProperty.call(nodeObj, key);
    const inPython = Object.prototype.hasOwnProperty.call(pythonObj, key);
    if (!inNode) {
      out.push({ path: `${at}.${key}`, node: '<missing>', python: pythonObj[key] });
    } else if (!inPython) {
      out.push({ path: `${at}.${key}`, node: nodeObj[key], python: '<missing>' });
    } else {
      diffValues(nodeObj[key], pythonObj[key], `${at}.${key}`, out);
    }
  }
}

/** Walk up from the current directory to the repository root. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    const hasPython = existsSync(path.join(dir, 'servermanage', 'storage', '__init__.py'));
    const hasBackend = existsSync(path.join(dir, 'backend', 'src', 'storage'));
    if (hasPython && hasBackend) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(`could not locate repository root from ${start}`);
}

function defaultPython(): string {
  return process.env.PYTHON ?? 'python';
}

function mergePythonPath(repoRoot: string): string {
  const existing = process.env.PYTHONPATH;
  const sep = process.platform === 'win32' ? ';' : ':';
  return existing ? `${repoRoot}${sep}${existing}` : repoRoot;
}

interface OracleRecord {
  name: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

function runPythonOracle(
  repoRoot: string,
  python: string,
  dbPath: string,
  cases: QueryCase[],
): Map<string, OracleRecord> {
  const script = path.join(repoRoot, 'backend', 'test', 'diff', 'run_python_oracle.py');
  const plan = {
    queries: cases.map((c) => ({ name: c.name, op: c.python.op, args: c.python.args ?? {} })),
  };
  const result = spawnSync(python, [script, dbPath], {
    cwd: repoRoot,
    input: JSON.stringify(plan),
    encoding: 'utf-8',
    env: {
      ...process.env,
      PYTHONPATH: mergePythonPath(repoRoot),
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
      `python oracle exited with status ${result.status}\nstderr:\n${result.stderr ?? ''}\nstdout:\n${
        result.stdout ?? ''
      }`,
    );
  }
  const records = new Map<string, OracleRecord>();
  for (const rawLine of (result.stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as OracleRecord).name === 'string'
    ) {
      const record = parsed as OracleRecord;
      records.set(record.name, record);
    }
  }
  return records;
}

/**
 * Runs every case through both stacks and returns the normalised differences.
 * Throws if the Python oracle cannot be spawned or reports a per-query error.
 */
export async function runDiff(
  dbPath: string,
  cases: QueryCase[],
  opts: RunDiffOptions = {},
): Promise<Diff[]> {
  const repoRoot = opts.repoRoot ?? findRepoRoot();
  const python = opts.python ?? defaultPython();
  const oracle = runPythonOracle(repoRoot, python, dbPath, cases);

  const db = openDatabase(dbPath, { readonly: true });
  try {
    const diffs: Diff[] = [];
    for (const testCase of cases) {
      const record = oracle.get(testCase.name);
      if (!record) {
        diffs.push({
          path: testCase.name,
          node: '<node result produced>',
          python: '<no oracle result>',
        });
        continue;
      }
      if (!record.ok) {
        throw new Error(`python oracle failed for "${testCase.name}": ${record.error ?? 'unknown'}`);
      }
      const normalize = testCase.normalize ?? normalizeValue;
      const maskKeys = opts.maskKeys ?? [];
      const finish = (value: unknown): unknown =>
        maskKeys.length > 0 ? applyMask(value, maskKeys) : value;
      const nodeValue = finish(normalize(testCase.node(db)));
      const pythonValue = finish(normalize(record.value));
      diffValues(nodeValue, pythonValue, testCase.name, diffs);
    }
    return diffs;
  } finally {
    db.close();
  }
}

let pythonProbe: { ok: boolean; detail: string } | null = null;

/**
 * Probes whether the Python oracle can run in this environment (interpreter on
 * PATH and `servermanage.storage` importable from the repo root). Result cached.
 */
export function detectPython(opts: RunDiffOptions = {}): { ok: boolean; detail: string } {
  if (pythonProbe) {
    return pythonProbe;
  }
  try {
    const repoRoot = opts.repoRoot ?? findRepoRoot();
    const python = opts.python ?? defaultPython();
    const result = spawnSync(python, ['-c', 'import servermanage.storage'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env, PYTHONPATH: mergePythonPath(repoRoot), PYTHONWARNINGS: 'ignore' },
    });
    if (result.error) {
      pythonProbe = { ok: false, detail: String(result.error) };
    } else if (result.status !== 0) {
      pythonProbe = {
        ok: false,
        detail: `exit ${result.status}: ${(result.stderr ?? '').trim()}`,
      };
    } else {
      pythonProbe = { ok: true, detail: 'ok' };
    }
  } catch (err) {
    pythonProbe = { ok: false, detail: String(err) };
  }
  return pythonProbe;
}

/** Human-readable skip reason when {@link detectPython} fails. */
export function pythonSkipReason(): string {
  const probe = detectPython();
  return probe.ok ? '' : `Python oracle unavailable in this environment: ${probe.detail}`;
}
