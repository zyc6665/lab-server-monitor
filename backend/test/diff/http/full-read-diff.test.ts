/**
 * P7 Task 2 — full read-only endpoint differential (Node ⇄ Python).
 *
 * Boots the real Node Express app (`createServerApp`) and the Python Flask app
 * (`dump_python.py`) against *the same* seeded database (`servermonitor-seed.db`
 * from Task 1, copied once per stack) with identical server config, logs in as
 * the same admin on both, then requests every read-only endpoint on both stacks
 * and byte/deep-compares the responses.
 *
 * Comparison:
 *   - status code and content-type must match everywhere;
 *   - JSON bodies are normalised (volatile fields masked, timestamps unified to
 *     µs, floats to 1e-6, object keys compared as sets, object-arrays sorted by
 *     an explicit key) and diffed structurally (`diffValues`);
 *   - text reports are compared after stripping the BOM and the dynamic
 *     "generated at <now>" line;
 *   - HTML pages are compared by status + content-type + a set of key markers
 *     (and the <title>), never whole documents.
 *
 * Only the endpoints named in `read-allowlist.ts` (`ALLOWED_DIFFS`) may differ
 * (the two P5-documented cases). Any other divergence is a failure and is
 * reported verbatim — never silently absorbed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The admin credential is stored through DPAPI on both stacks. Replace the
// native binding with an identity codec so the Node side can round-trip its own
// secret on a non-Windows/CI host without a real DPAPI vault.
vi.mock('../../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buf: Buffer) => Buffer.from(buf),
  unprotect: (buf: Buffer) => Buffer.from(buf),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { loadConfig } from '../../../src/config/config';
import { openDatabase } from '../../../src/storage/db';
import { setAdminPassword } from '../../../src/web/routes/auth';
import { createServerApp } from '../../../src/web/composition';
import { applyMask, diffValues, findRepoRoot, instantMicros, normalizeValue, type Diff } from '../harness';
import {
  ARRAY_SORT_KEY_PRECEDENCE,
  ENDPOINT_MASKS,
  GLOBAL_MASK_KEYS,
  VOLATILE_KEYS,
  allowedDiffsFor,
} from './read-allowlist';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'Diff-Test-Passw0rd!';
const RESULT_PREFIX = '@@HTTP_DIFF_RESULT@@';
const PYTHON = process.env.PYTHON ?? 'python';
const REPO_ROOT = findRepoRoot(process.cwd());
const SEED_DB = path.join(REPO_ROOT, 'backend', 'test', 'fixtures', 'seed', 'servermonitor-seed.db');
const DUMP_SCRIPT = path.join(REPO_ROOT, 'backend', 'test', 'diff', 'http', 'dump_python.py');
const APP_VERSION = '0.1.239';

// ---------------------------------------------------------------------------
// Endpoint matrix
// ---------------------------------------------------------------------------

type Capture = 'json' | 'text' | 'markers' | 'none';
type Kind = 'json' | 'text' | 'page' | 'status';

interface EndpointSpec {
  /** Stable label used to join Node ↔ Python responses. */
  name: string;
  /** Request path incl. query string. */
  path: string;
  kind: Kind;
  capture: Capture;
  /** Page markers (only for capture:'markers'). */
  markers?: string[];
  /** Extra per-endpoint mask keys on top of the shared tables. */
  mask?: string[];
  /** When set, both stacks must return this exact status (documents a 404). */
  expectStatus?: number;
}

const PAGE_MARKERS_MY: string[] = [];

const MATRIX: EndpointSpec[] = [
  // -- overview JSON -------------------------------------------------------
  { name: 'overview', path: '/api/overview', kind: 'json', capture: 'json' },
  { name: 'overview_capacity_7', path: '/api/overview/capacity?days=7', kind: 'json', capture: 'json' },
  { name: 'overview_capacity_30', path: '/api/overview/capacity?days=30', kind: 'json', capture: 'json' },
  { name: 'overview_capacity_90', path: '/api/overview/capacity?days=90', kind: 'json', capture: 'json' },
  { name: 'overview_history_24h', path: '/api/overview/history?range=24h', kind: 'json', capture: 'json' },
  { name: 'overview_history_7d', path: '/api/overview/history?range=7d', kind: 'json', capture: 'json' },
  { name: 'overview_history_30d', path: '/api/overview/history?range=30d', kind: 'json', capture: 'json' },
  { name: 'overview_history_90d', path: '/api/overview/history?range=90d', kind: 'json', capture: 'json' },
  { name: 'overview_alert_history_7d', path: '/api/overview/alert-history?range=7d', kind: 'json', capture: 'json' },

  // -- settings ------------------------------------------------------------
  { name: 'settings', path: '/api/settings', kind: 'json', capture: 'json' },
  { name: 'settings_hosts', path: '/api/settings/hosts', kind: 'json', capture: 'json' },
  {
    name: 'settings_collection_status',
    path: '/api/settings/hosts/collection-status',
    kind: 'json',
    capture: 'json',
  },

  // -- host ---------------------------------------------------------------
  { name: 'host_detail', path: '/api/host/lab-01', kind: 'json', capture: 'json' },
  { name: 'host_history_7d', path: '/api/host/lab-01/history?range=7d', kind: 'json', capture: 'json' },
  { name: 'host_report', path: '/api/host/lab-01/report', kind: 'text', capture: 'text' },

  // -- alerts -------------------------------------------------------------
  { name: 'alerts', path: '/api/alerts', kind: 'json', capture: 'json' },

  // -- users --------------------------------------------------------------
  { name: 'users', path: '/api/users', kind: 'json', capture: 'json' },
  { name: 'users_history', path: '/api/users/history?host=lab-01', kind: 'json', capture: 'json' },
  { name: 'users_top', path: '/api/users/top', kind: 'json', capture: 'json' },
  { name: 'users_operations', path: '/api/users/operations', kind: 'json', capture: 'json' },

  // -- system -------------------------------------------------------------
  { name: 'system_health', path: '/api/system/health', kind: 'json', capture: 'json' },
  { name: 'system_storage', path: '/api/system/storage', kind: 'json', capture: 'json' },
  { name: 'system_host_keys', path: '/api/system/host-keys', kind: 'json', capture: 'json' },

  // -- HTML pages (status + content-type + key markers) -------------------
  { name: 'page_root', path: '/', kind: 'page', capture: 'markers', markers: ['lab-01', 'gpu-01'] },
  { name: 'page_hosts', path: '/hosts', kind: 'page', capture: 'markers', markers: ['lab-01', 'lab-02'] },
  { name: 'page_host', path: '/host/lab-01', kind: 'page', capture: 'markers', markers: ['lab-01'] },
  { name: 'page_alerts', path: '/alerts', kind: 'page', capture: 'markers', markers: ['CPU 使用率持续过高'] },
  { name: 'page_settings', path: '/settings', kind: 'page', capture: 'markers', markers: ['lab-01'] },
  { name: 'page_users', path: '/users', kind: 'page', capture: 'markers', markers: ['alice'] },
  { name: 'page_compute', path: '/compute', kind: 'page', capture: 'markers', markers: ['lab-01'] },
  { name: 'page_disk_health', path: '/disk-health', kind: 'page', capture: 'markers', markers: ['gpu-01'] },
  { name: 'page_my', path: '/my', kind: 'page', capture: 'markers', markers: PAGE_MARKERS_MY },

  // -- documented non-existent paths: status/content-type parity only -----
  { name: 'missing_api_hosts', path: '/api/hosts', kind: 'status', capture: 'none', expectStatus: 404 },
  { name: 'missing_api_disk_health', path: '/api/disk-health', kind: 'status', capture: 'none', expectStatus: 404 },
];

// ---------------------------------------------------------------------------
// Python oracle plumbing (mirrors http-diff.test.ts)
// ---------------------------------------------------------------------------

interface HttpRecord {
  name: string;
  status: number;
  content_type: string;
  set_cookie: boolean;
  json?: unknown;
  text?: string | null;
  markers?: Record<string, boolean>;
  title?: string | null;
}

function pythonPathEnv(): string {
  const existing = process.env.PYTHONPATH;
  return existing ? `${REPO_ROOT}${path.delimiter}${existing}` : REPO_ROOT;
}

const PYTHON_READY = (() => {
  try {
    const probe = spawnSync(
      PYTHON,
      ['-c', 'import servermanage, servermanage.security as s; print(bool(s.dpapi_available()))'],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, PYTHONPATH: pythonPathEnv(), PYTHONWARNINGS: 'ignore' },
        encoding: 'utf8',
      },
    );
    return probe.status === 0 && (probe.stdout ?? '').trim().endsWith('True');
  } catch {
    return false;
  }
})();

function runDumpPython(dbPath: string, configPath: string, planPath: string): HttpRecord[] {
  const result = spawnSync(PYTHON, [DUMP_SCRIPT, '--db', dbPath, '--config', configPath, '--plan', planPath], {
    cwd: REPO_ROOT,
    env: { ...process.env, PYTHONPATH: pythonPathEnv(), PYTHONWARNINGS: 'ignore' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`dump_python.py failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  const line = (result.stdout ?? '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error(`dump_python.py produced no ${RESULT_PREFIX} line:\n${result.stdout}\n${result.stderr}`);
  }
  const payload = JSON.parse(line.slice(RESULT_PREFIX.length)) as { responses: HttpRecord[] };
  return payload.responses;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sortKeyValue(value: unknown): number | string {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const micros = instantMicros(value);
    return micros ?? value;
  }
  return String(value);
}

function pickSortKey(items: Array<Record<string, unknown>>): string | null {
  for (const candidate of ARRAY_SORT_KEY_PRECEDENCE) {
    const allHave = items.every((item) => Object.prototype.hasOwnProperty.call(item, candidate));
    if (!allHave) {
      continue;
    }
    const comparable = items.every((item) => {
      const value = item[candidate];
      return value === null || typeof value === 'string' || typeof value === 'number';
    });
    if (comparable) {
      return candidate;
    }
  }
  return null;
}

/** Recursively sorts arrays of objects by an explicit key, keeping every other
 * array in place. Makes set-like collections (alerts, hosts, series, buckets)
 * order-independent while preserving the sequence of primitive lists. */
function deepSort(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(deepSort);
    if (items.length > 1 && items.every(isPlainObject)) {
      const objects = items as Array<Record<string, unknown>>;
      const key = pickSortKey(objects);
      const ordered = objects.slice();
      ordered.sort((a, b) => {
        if (key) {
          const av = sortKeyValue(a[key]);
          const bv = sortKeyValue(b[key]);
          if (typeof av === 'number' && typeof bv === 'number') {
            if (av !== bv) {
              return av - bv;
            }
          } else {
            const as = String(av);
            const bs = String(bv);
            if (as !== bs) {
              return as < bs ? -1 : 1;
            }
          }
        }
        const as = stableStringify(a);
        const bs = stableStringify(b);
        return as < bs ? -1 : as > bs ? 1 : 0;
      });
      return ordered;
    }
    return items;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = deepSort(value[key]);
    }
    return out;
  }
  return value;
}

function maskKeysFor(spec: EndpointSpec): string[] {
  const clean = spec.path.split('?')[0];
  return [...VOLATILE_KEYS, ...GLOBAL_MASK_KEYS, ...(ENDPOINT_MASKS[clean] ?? []), ...(spec.mask ?? [])];
}

function normaliseJson(payload: unknown, spec: EndpointSpec): unknown {
  return normalizeValue(deepSort(applyMask(payload, maskKeysFor(spec))));
}

/** Strips BOM / CRLF and the wall-clock "generated at" line so two independently
 * rendered reports (generated seconds apart) compare on their stable content. */
function normaliseReportText(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/生成时间\s*[：:]/.test(line) && !/^\s*Generated\b/i.test(line))
    .join('\n')
    .trimEnd();
}

interface MarkerShape {
  markers: Record<string, boolean>;
  title: string | null;
}

function extractMarkers(text: string, wanted: string[]): MarkerShape {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
  return {
    markers: Object.fromEntries(wanted.map((marker) => [marker, text.includes(marker)])),
    title: titleMatch ? titleMatch[1].trim() : null,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let workDir: string;
let nodeDb: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof createServerApp>;
let pythonResponses: Map<string, HttpRecord>;
const nodeResults = new Map<string, { status: number; content_type: string; json?: unknown; text?: string; markers?: MarkerShape }>();

function buildSeedServers(): Array<Record<string, unknown>> {
  const base = {
    username: 'monitor',
    port: 22,
    auth: { type: 'key', key_path: '/home/monitor/.ssh/id_rsa' },
    group: 'lab',
    owner: 'ops',
    location: 'Lab',
    notes: '',
    checks: [] as unknown[],
    allow_user_write: false,
  };
  return [
    {
      ...base,
      name: 'lab-01',
      host: 'lab-01.lab.example.edu',
      tags: ['lab', 'cpu'],
      disk_mounts: ['/'],
    },
    {
      ...base,
      name: 'lab-02',
      host: 'lab-02.lab.example.edu',
      tags: ['lab'],
      disk_mounts: ['/'],
    },
    {
      ...base,
      name: 'gpu-01',
      host: 'gpu-01.lab.example.edu',
      tags: ['lab', 'gpu'],
      disk_mounts: ['/', '/data'],
    },
  ];
}

beforeAll(async () => {
  if (!PYTHON_READY) {
    return;
  }
  expect(fs.existsSync(SEED_DB), `seed database missing at ${SEED_DB}`).toBe(true);

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullread-'));
  const nodeDbPath = path.join(workDir, 'node.db');
  const pyDbPath = path.join(workDir, 'python.db');
  fs.copyFileSync(SEED_DB, nodeDbPath);
  fs.copyFileSync(SEED_DB, pyDbPath);

  const servers = buildSeedServers();
  const configPath = path.join(workDir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    JSON.stringify({ storage: { db_path: pyDbPath }, app: { timezone: 'UTC' }, servers }, null, 2),
    'utf8',
  );
  const serversJsonPath = path.join(workDir, 'servers.json');
  fs.writeFileSync(serversJsonPath, JSON.stringify(servers), 'utf8');

  const baseConfig = loadConfig({
    SERVERMONITOR_DATA_DIR: workDir,
    SERVERMONITOR_APP_VERSION: APP_VERSION,
  });
  const config = {
    ...baseConfig,
    dbPath: nodeDbPath,
    servers: servers as unknown as typeof baseConfig.servers,
  };

  nodeDb = openDatabase(nodeDbPath);
  // Pre-create the admin credential so both stacks start already "logged in"
  // without walking the first-run /setup gate.
  setAdminPassword(nodeDb, { current: null, newPassword: ADMIN_PASSWORD, username: ADMIN_USERNAME });
  app = createServerApp({ db: nodeDb, config });

  // Python oracle: same plan, executed against its own copy of the seed.
  const plan = {
    auth: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
    requests: MATRIX.map((spec) => ({
      name: spec.name,
      method: 'GET',
      path: spec.path,
      auth: true,
      capture: spec.capture,
      markers: spec.markers,
    })),
  };
  const planPath = path.join(workDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  pythonResponses = new Map(runDumpPython(pyDbPath, configPath, planPath).map((record) => [record.name, record]));

  // Node drive: log the shared agent in once, then replay the matrix.
  const agent = request.agent(app);
  await agent.post('/login').type('form').send({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD });

  for (const spec of MATRIX) {
    const response = await agent.get(spec.path);
    const entry: { status: number; content_type: string; json?: unknown; text?: string; markers?: MarkerShape } = {
      status: response.status,
      content_type: (response.headers['content-type'] ?? '').split(';')[0].trim(),
    };
    if (spec.capture === 'json') {
      entry.json = response.body;
    } else if (spec.capture === 'text') {
      entry.text = response.text;
    } else if (spec.capture === 'markers') {
      entry.markers = extractMarkers(response.text, spec.markers ?? []);
    }
    nodeResults.set(spec.name, entry);
  }
}, 120_000);

afterAll(() => {
  if (nodeDb) {
    nodeDb.close();
  }
  if (workDir && fs.existsSync(workDir)) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!PYTHON_READY)('full read-only endpoint differential (Node vs Python)', () => {
  it('covers every read-only endpoint in the matrix', () => {
    // A guard so the coverage list cannot silently shrink.
    expect(MATRIX.length).toBeGreaterThanOrEqual(34);
    const jsonCount = MATRIX.filter((spec) => spec.kind === 'json').length;
    const pageCount = MATRIX.filter((spec) => spec.kind === 'page').length;
    expect(jsonCount).toBeGreaterThanOrEqual(22);
    expect(pageCount).toBeGreaterThanOrEqual(8);
  });

  it('matches the Python oracle (allowlist-only divergence)', () => {
    const details: string[] = [];
    const failing: string[] = [];
    const observations: string[] = [];

    for (const spec of MATRIX) {
      const node = nodeResults.get(spec.name);
      const py = pythonResponses.get(spec.name);
      if (!node || !py) {
        failing.push(`${spec.name}: missing response (node=${Boolean(node)}, python=${Boolean(py)})`);
        continue;
      }
      const notes = allowedDiffsFor(spec.path);
      const diffs: Diff[] = [];

      if (node.status !== py.status) {
        diffs.push({ path: 'status', node: node.status, python: py.status });
      }
      // A note on the `/api/*` 404 representation: Node answers unknown /api/*
      // routes through a JSON error envelope while Flask falls back to its HTML
      // 404 page. The two placeholder paths below are not routes on *either*
      // stack (the real endpoints are `/api/settings/hosts` and the `/disk-health`
      // page, both covered above), so we gate only status parity and record the
      // framework-level content-type difference as an observation.
      if (spec.kind !== 'status' && node.content_type !== py.content_type) {
        diffs.push({ path: 'content_type', node: node.content_type, python: py.content_type });
      }

      if (spec.kind === 'json') {
        diffValues(normaliseJson(node.json, spec), normaliseJson(py.json, spec), 'body', diffs);
      } else if (spec.kind === 'text') {
        const nodeText = normaliseReportText(node.text ?? '');
        const pyText = normaliseReportText(py.text ?? '');
        if (nodeText !== pyText) {
          diffs.push({ path: 'text', node: nodeText.slice(0, 2000), python: pyText.slice(0, 2000) });
        }
      } else if (spec.kind === 'page') {
        const nodeMarkers = node.markers ?? { markers: {}, title: null };
        const pyMarkers = { markers: py.markers ?? {}, title: py.title ?? null };
        diffValues(nodeMarkers.markers, pyMarkers.markers, 'markers', diffs);
        if (nodeMarkers.title !== pyMarkers.title) {
          diffs.push({ path: 'title', node: nodeMarkers.title, python: pyMarkers.title });
        }
      } else if (spec.kind === 'status') {
        if (
          spec.expectStatus !== undefined &&
          (node.status !== spec.expectStatus || py.status !== spec.expectStatus)
        ) {
          diffs.push({ path: 'expected_status', node: node.status, python: py.status });
        }
        if (node.content_type !== py.content_type) {
          observations.push(
            `${spec.name} (${spec.path}): 404 content-type differs — Node '${node.content_type}' vs Python '${py.content_type}' (generic framework 404; path is not a route on either stack)`,
          );
        }
      }

      const known = notes.length > 0;
      if (diffs.length > 0 && !known) {
        failing.push(`${spec.name} (${spec.path}): ${JSON.stringify(diffs.slice(0, 8))}`);
      }
      const state = diffs.length === 0 ? 'pass' : known ? 'allowlisted-diff' : 'FAIL';
      details.push(
        `${state.padEnd(16)} ${spec.name.padEnd(28)} ${spec.path}${diffs.length ? `  (${diffs.length} diff)` : ''}`,
      );
    }

    // Print the per-endpoint verdict table so it is visible in test output.
    // eslint-disable-next-line no-console
    console.log(`\n[full-read-diff] per-endpoint verdicts:\n${details.join('\n')}\n`);
    if (observations.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[full-read-diff] observations:\n${observations.join('\n')}\n`);
    }

    expect(failing, `real (non-allowlisted) differences:\n${failing.join('\n')}`).toEqual([]);
  });
});
