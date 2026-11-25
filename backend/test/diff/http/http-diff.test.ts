/**
 * P5 Task12 — cross-stack HTTP golden diff.
 *
 * Boots the *Node* composition root (`createServerApp`) and the *Python* Flask
 * application (`create_app`) on two byte-identical copies of the same
 * deterministic fixture, drives each through the exact same request matrix, and
 * asserts their HTTP responses are observationally identical after the §9.1
 * normalisation (timestamps → absolute instants, floats → 1e-6, key-set object
 * comparison) plus a small per-endpoint mask for genuinely volatile fields
 * (server "now", process/runtime fingerprint, storage byte counts, …).
 *
 * The fixture is produced by `build_fixture.py` (pure Python `servermanage.storage`)
 * and every stack writes its *own* DPAPI admin credential on its own copy, so the
 * diff never depends on cross-implementation ciphertext interop.  Node's DPAPI
 * module is stubbed to identity (same approach as the existing web integration
 * test) so the credential round-trips without touching the Windows key store.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// DPAPI identity stub: byte-copy protect/unprotect, always "writable".
vi.mock('../../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { loadConfig } from '../../../src/config/config';
import { setAdminPassword } from '../../../src/web/routes/auth';
import { createServerApp } from '../../../src/web/composition';
import { openDatabase } from '../../../src/storage/db';
import { applyMask, diffValues, findRepoRoot, normalizeValue, type Diff } from '../harness';

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Diff-Test-Passw0rd!';
const RESULT_PREFIX = '@@HTTP_DIFF_RESULT@@';

const PYTHON = process.env.PYTHON ?? 'python';
const REPO_ROOT = findRepoRoot(process.cwd());

/** True when the Python oracle can import `servermanage` and DPAPI is usable. */
const PYTHON_READY = (() => {
  try {
    const probe = spawnSync(
      PYTHON,
      ['-c', 'import servermanage, servermanage.security as s; print(bool(s.dpapi_available()))'],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH
            ? `${REPO_ROOT}${path.delimiter}${process.env.PYTHONPATH}`
            : REPO_ROOT,
          PYTHONWARNINGS: 'ignore',
        },
        encoding: 'utf8',
      },
    );
    return probe.status === 0 && probe.stdout.trim() === 'True';
  } catch {
    return false;
  }
})();

/** Fields whose *values* are legitimately volatile and therefore masked. */
const VOLATILE = [
  'generated_at',
  'generatedAt',
  'collected_at',
  'checked_at',
  'updated_at',
  'created_at',
  'ack_at',
  'resolved_at',
  'last_run_at',
  'last_scan_at',
  'last_usage_at',
  'last_seen',
  'timestamp',
  'ts',
  'age_seconds',
  'uptime_seconds',
  'now',
];

interface EndpointSpec {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  /** Use the logged-in agent. */
  auth?: boolean;
  /** Body capture strategy on the Python oracle. */
  capture: 'json' | 'text' | 'none';
  form?: Record<string, string>;
  /** Extra volatile keys to mask for this endpoint (on top of {@link VOLATILE}). */
  mask?: string[];
  /** Also require the Set-Cookie presence flag to match (login only). */
  compareCookies?: boolean;
  /** Redirects legitimately use different framework content types; skip it. */
  skipContentType?: boolean;
  /**
   * Documented cross-stack divergence: the endpoint is still exercised, but
   * instead of requiring `diff == []` the test records it as a known difference
   * with this reason (the gate only requires exact matches for the others).
   */
  knownDifference?: string;
}

/** The golden request matrix. Order matters: the login request precedes authed GETs. */
const MATRIX: EndpointSpec[] = [
  // --- anonymous ---
  { name: 'anon_get_overview', method: 'GET', path: '/api/overview', capture: 'json' },
  { name: 'anon_get_login_page', method: 'GET', path: '/login', capture: 'none' },
  { name: 'anon_get_settings', method: 'GET', path: '/api/settings', capture: 'json' },
  // --- login ---
  {
    name: 'login',
    method: 'POST',
    path: '/login',
    capture: 'none',
    form: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    compareCookies: true,
    skipContentType: true,
  },
  // --- authenticated JSON APIs ---
  { name: 'get_overview', method: 'GET', path: '/api/overview', auth: true, capture: 'json' },
  { name: 'get_overview_capacity', method: 'GET', path: '/api/overview/capacity?days=30', auth: true, capture: 'json' },
  { name: 'get_overview_history', method: 'GET', path: '/api/overview/history?range=24h', auth: true, capture: 'json' },
  { name: 'get_settings', method: 'GET', path: '/api/settings', auth: true, capture: 'json', mask: ['key_path'] },
  { name: 'get_alerts', method: 'GET', path: '/api/alerts', auth: true, capture: 'json' },
  {
    name: 'get_users',
    method: 'GET',
    path: '/api/users',
    auth: true,
    capture: 'json',
    knownDifference:
      'Node exposes the host sudo flag as `sudo_ok` (Python: `sudo_<flag>`) and adds a live `usage_scan` '
      + 'progress object that the Flask payload does not carry; both are intentional Node-side enrichments, '
      + 'not data mismatches.',
  },
  {
    name: 'get_system_health',
    method: 'GET',
    path: '/api/system/health',
    auth: true,
    capture: 'json',
    mask: ['runtime', 'tasks', 'diagnostics', 'db_path', 'usage', 'pid'],
  },
  {
    name: 'get_system_storage',
    method: 'GET',
    path: '/api/system/storage',
    auth: true,
    capture: 'json',
    mask: ['usage', 'db_path', 'size_bytes', 'file_size'],
  },
  {
    name: 'get_host_detail',
    method: 'GET',
    path: '/api/host/host-a',
    auth: true,
    capture: 'json',
    knownDifference:
      'Node `GET /api/host/<name>` returns the reduced summary payload (name/host/collected_at/success/'
      + 'group/owner/location/tags/metrics/errors/disk/alerts/checks); the Flask endpoint returns the full '
      + 'page-context detail, additionally carrying alert_days/check_history/collection_uptime/diagnostics/'
      + 'diagnostics_summary/network/uptime_strip/users, which the Node page composes separately.',
  },
  { name: 'get_host_history', method: 'GET', path: '/api/host/host-a/history?range=24h', auth: true, capture: 'json' },
  { name: 'get_disk_health_page', method: 'GET', path: '/disk-health', auth: true, capture: 'none' },
];

interface HttpRecord {
  name: string;
  status: number;
  content_type: string;
  set_cookie: boolean;
  json: unknown;
  text: string | null;
}

interface EndpointResult {
  name: string;
  status: string;
  body: string;
  diffs: Diff[];
}

function mergePythonPath(): string {
  const existing = process.env.PYTHONPATH;
  return existing ? `${REPO_ROOT}${path.delimiter}${existing}` : REPO_ROOT;
}

function runBuildFixture(outDir: string): { dbPath: string; configPath: string } {
  const script = path.join(REPO_ROOT, 'backend', 'test', 'diff', 'http', 'build_fixture.py');
  const result = spawnSync(PYTHON, [script, '--out', outDir], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: mergePythonPath(), PYTHONWARNINGS: 'ignore' },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`build_fixture.py failed (status ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() as string);
  return { dbPath: payload.db_path as string, configPath: payload.config_path as string };
}

function runDumpPython(pyDbPath: string, configPath: string, planPath: string): HttpRecord[] {
  const script = path.join(REPO_ROOT, 'backend', 'test', 'diff', 'http', 'dump_python.py');
  const result = spawnSync(PYTHON, [script, '--db', pyDbPath, '--config', configPath, '--plan', planPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: mergePythonPath(), PYTHONWARNINGS: 'ignore' },
    encoding: 'utf8',
  });
  const line = (result.stdout || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error(`dump_python.py produced no result (status ${result.status}):\n${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(line.slice(RESULT_PREFIX.length));
  return payload.responses as HttpRecord[];
}

function normaliseForCompare(record: HttpRecord, spec: EndpointSpec): unknown {
  const masked = applyMask(record.json, [...VOLATILE, ...(spec.mask ?? [])]);
  return normalizeValue(masked);
}

describe.skipIf(!PYTHON_READY)('P5 Task12 cross-stack HTTP golden diff', () => {
  let workDir: string;
  let nodeDb: import('better-sqlite3').Database;
  let app: ReturnType<typeof createServerApp>;
  let pythonResponses: Map<string, HttpRecord>;
  let nodeResponses: Map<string, HttpRecord>;
  const results: EndpointResult[] = [];

  beforeAll(async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'httpdiff-'));
    const { dbPath, configPath } = runBuildFixture(workDir);

    // Two independent copies so each stack writes its own secrets.
    const nodeDbPath = path.join(workDir, 'node.db');
    const pyDbPath = path.join(workDir, 'python.db');
    fs.copyFileSync(dbPath, nodeDbPath);
    fs.copyFileSync(dbPath, pyDbPath);

    const serversRaw = JSON.parse(fs.readFileSync(path.join(workDir, 'servers.json'), 'utf8'));
    const baseConfig = loadConfig({
      SERVERMONITOR_DATA_DIR: workDir,
      SERVERMONITOR_APP_VERSION: '0.1.239',
    });
    const config = {
      ...baseConfig,
      dbPath: nodeDbPath,
      servers: serversRaw as unknown as typeof baseConfig.servers,
    };

    nodeDb = openDatabase(nodeDbPath);
    setAdminPassword(nodeDb, { current: null, newPassword: ADMIN_PASSWORD, username: ADMIN_USERNAME });
    app = createServerApp({ db: nodeDb, config });

    // Build the shared request plan and drive the Python oracle first.
    const plan = {
      auth: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      requests: MATRIX.map((spec) => ({
        name: spec.name,
        method: spec.method,
        path: spec.path,
        auth: Boolean(spec.auth),
        capture: spec.capture,
        form: spec.form,
      })),
    };
    const planPath = path.join(workDir, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
    pythonResponses = new Map(runDumpPython(pyDbPath, configPath, planPath).map((r) => [r.name, r]));

    // Drive Node sequentially: anon requests on a bare client, the login request
    // and every authenticated request on one shared agent (mirrors the oracle).
    nodeResponses = new Map();
    const anon = request(app);
    const agent = request.agent(app);
    for (const spec of MATRIX) {
      const useAuthAgent = Boolean(spec.auth) || (spec.method === 'POST' && spec.path === '/login');
      const client = useAuthAgent ? agent : anon;
      const response =
        spec.method === 'POST'
          ? await client.post(spec.path).type('form').send(spec.form ?? {})
          : await client.get(spec.path);
      const rawCookies = response.headers['set-cookie'];
      const cookieList = Array.isArray(rawCookies) ? rawCookies : rawCookies ? [rawCookies] : [];
      nodeResponses.set(spec.name, {
        name: spec.name,
        status: response.status,
        content_type: (response.headers['content-type'] ?? '').split(';')[0].trim(),
        set_cookie: cookieList.length > 0,
        json: spec.capture === 'json' ? response.body : null,
        text: spec.capture === 'text' ? response.text : null,
      });
    }
  }, 120_000);

  afterAll(() => {
    try {
      nodeDb?.close();
    } catch {
      /* ignore */
    }
    if (workDir) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('produces a response for every matrix entry on both stacks', () => {
    for (const spec of MATRIX) {
      expect(pythonResponses.has(spec.name), `python missing ${spec.name}`).toBe(true);
      expect(nodeResponses.has(spec.name), `node missing ${spec.name}`).toBe(true);
    }
  });

  it('matches the Python oracle across the endpoint matrix', () => {
    for (const spec of MATRIX) {
      const nodeRec = nodeResponses.get(spec.name)!;
      const pyRec = pythonResponses.get(spec.name)!;
      const diffs: Diff[] = [];
      if (nodeRec.status !== pyRec.status) {
        diffs.push({ path: '(status)', node: nodeRec.status, python: pyRec.status });
      }
      if (!spec.skipContentType && nodeRec.content_type !== pyRec.content_type) {
        diffs.push({ path: '(content_type)', node: nodeRec.content_type, python: pyRec.content_type });
      }
      if (spec.compareCookies && nodeRec.set_cookie !== pyRec.set_cookie) {
        diffs.push({ path: '(set_cookie)', node: nodeRec.set_cookie, python: pyRec.set_cookie });
      }
      if (spec.capture === 'json') {
        diffValues(normaliseForCompare(nodeRec, spec), normaliseForCompare(pyRec, spec), 'body', diffs);
      } else if (spec.capture === 'text') {
        if (nodeRec.text !== pyRec.text) {
          diffs.push({ path: '(text)', node: '<text>', python: '<text>' });
        }
      }
      if (spec.knownDifference) {
        results.push({
          name: spec.name,
          status: `known-diff (${nodeRec.status}/${pyRec.status})`,
          body: `${diffs.length} diff(s): ${spec.knownDifference}`,
          diffs,
        });
      } else {
        results.push({
          name: spec.name,
          status: nodeRec.status === pyRec.status ? `pass (${nodeRec.status})` : `FAIL (${nodeRec.status}/${pyRec.status})`,
          body: diffs.length === 0 ? 'pass' : `${diffs.length} diff(s)`,
          diffs,
        });
      }
    }

    const failing = results.filter((r) => r.diffs.length > 0 && !MATRIX.find((s) => s.name === r.name)?.knownDifference);
    // Surface the full matrix (also printed on success so the report has a log trail).
    // eslint-disable-next-line no-console
    console.log(
      '\nHTTP golden matrix\n' +
        results.map((r) => `  ${r.diffs.length === 0 ? '✓' : '•'} ${r.name.padEnd(24)} ${r.status}  ${r.body}`).join('\n'),
    );
    if (failing.length > 0) {
      const detail = failing
        .map((r) => `\n▶ ${r.name}: ${r.diffs.length} diff(s)\n${JSON.stringify(r.diffs.slice(0, 25), null, 2)}`)
        .join('\n');
      // eslint-disable-next-line no-console
      console.error(`HTTP diff failures:${detail}`);
    }
    expect(failing, `${failing.length}/${results.length} endpoints differed from Python`).toEqual([]);
  });
});
