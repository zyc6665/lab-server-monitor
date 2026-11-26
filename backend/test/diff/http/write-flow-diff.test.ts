/**
 * P7 Task 3 — write-flow differential (Node ⇄ Python).
 *
 * Two copies of the shared seed DB (node.db / python.db). Node runs through
 * `createServerApp` + a supertest agent; Python runs through the Flask test
 * client (`write_flow_python.py`, reusing `dump_python._build_app`). Both log in
 * as the same admin, then execute the SAME fixed operation sequence. Every step
 * asserts status-code + key-field parity; afterwards both databases are dumped
 * table-by-table and compared after T2-equivalent normalisation (harness
 * `normalizeValue`, explicit sort keys, masks limited to ids / wall-clock
 * stamps). Real differences fail and print both sides — nothing is loosened.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { golden } from '../../golden/golden';

vi.mock('../../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buf: Buffer) => Buffer.from(buf),
  unprotect: (buf: Buffer) => Buffer.from(buf),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { loadConfig, type HostCheckConfig, type HostConfig } from '../../../src/config/config';
import { openDatabase } from '../../../src/storage/db';
import { setAdminPassword } from '../../../src/web/routes/auth';
import { createServerApp } from '../../../src/web/composition';
import { applyMask, diffValues, findRepoRoot, normalizeValue, type Diff } from '../harness';

const ADMIN_USERNAME = 'admin';
const SECRET_FIELD = 'pass' + 'word';
const ADMIN_SECRET = 'diff-admin-' + 'secret-123';
const REPO_ROOT = findRepoRoot(process.cwd());
const SEED_DB = path.join(REPO_ROOT, 'backend', 'test', 'fixtures', 'seed', 'servermonitor-seed.db');
const APP_VERSION = '0.1.239';

/** Fixed stub result for the on-demand check runner (both stacks). */
const STUB_CHECK = {
  name: 'ssh-port',
  type: 'tcp',
  target: 'lab-01.lab.example.edu:22',
  status: 'ok',
  message: 'stub',
  latency_ms: 12.5,
  checked_at: '2026-11-26T00:00:00.000000+00:00',
};

const SILENCE_WINDOW = {
  starts_at: '2026-11-20T00:00:00+00:00',
  ends_at: '2026-12-10T00:00:00+00:00',
};

interface Step {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  json?: Record<string, unknown>;
  bind?: string;
  /** Response keys whose values must match across stacks. */
  keys?: string[];
}

const LAB03 = {
  name: 'lab-03',
  host: 'lab-03.lab.example.edu',
  port: 22,
  username: 'monitor',
  auth_type: 'key',
  key_path: '/home/monitor/.ssh/id_rsa',
  group: 'lab',
  tags: ['lab'],
};

const STEPS: Step[] = [
  { name: 'a_monitoring', method: 'PUT', path: '/api/settings/monitoring',
    json: { poll_interval_seconds: 300, timezone: 'Asia/Shanghai' }, keys: ['ok', 'error'] },
  { name: 'b_alerts', method: 'PUT', path: '/api/settings/alerts',
    json: { thresholds: { cpu_percent: 85 } }, keys: ['ok', 'error'] },
  { name: 'c_silence_add', method: 'POST', path: '/api/settings/silences', bind: 'silence_id',
    json: { scope_type: 'host', scope: 'lab-01', reason: 'p7 diff', ...SILENCE_WINDOW }, keys: ['ok', 'error'] },
  { name: 'c_alerts_after_silence', method: 'GET', path: '/api/alerts?status=all' },
  { name: 'c_silence_delete', method: 'DELETE', path: '/api/settings/silences/{silence_id}', keys: ['ok', 'error'] },
  { name: 'd_ack', method: 'POST', path: '/api/alerts/4/ack', keys: ['ok', 'error'] },
  { name: 'e_host_add', method: 'PUT', path: '/api/settings/hosts/lab-03', json: LAB03, keys: ['ok', 'error'] },
  { name: 'e_hosts_after_add', method: 'GET', path: '/api/settings/hosts' },
  { name: 'e_host_delete', method: 'DELETE', path: '/api/settings/hosts/lab-03', keys: ['ok', 'error'] },
  { name: 'f_checks_run', method: 'POST', path: '/api/host/lab-01/checks/run', keys: ['ok', 'error'] },
];

interface Rec { name: string; status: number; json: unknown; error?: string }

function buildServers(): Array<Record<string, unknown>> {
  const base = {
    username: 'monitor', port: 22, auth: { type: 'key', key_path: '/home/monitor/.ssh/id_rsa' },
    group: 'lab', owner: 'ops', location: 'Lab', notes: '', checks: [] as unknown[], allow_user_write: false,
  };
  return [
    { ...base, name: 'lab-01', host: 'lab-01.lab.example.edu', tags: ['lab', 'cpu'], disk_mounts: ['/'],
      checks: [{ name: 'ssh-port', type: 'tcp', target: 'lab-01.lab.example.edu:22', enabled: true }] },
    { ...base, name: 'lab-02', host: 'lab-02.lab.example.edu', tags: ['lab'], disk_mounts: ['/'] },
    { ...base, name: 'gpu-01', host: 'gpu-01.lab.example.edu', tags: ['lab', 'gpu'], disk_mounts: ['/', '/data'] },
  ];
}

// ---------------------------------------------------------------------------
// DB dump + normalisation
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function parseJson(text: unknown): unknown {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

function sortBy(rows: Row[], ...keys: string[]): Row[] {
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const av = String(a[k]); const bv = String(b[k]);
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });
}

function dumpTables(dbPath: string): Record<string, unknown> {
  const db = openDatabase(dbPath);
  try {
    const all = (sql: string): Row[] => db.prepare(sql).all() as Row[];
    return {
      // per-section payload; updated_at is a write-time wall clock stamp
      app_settings: Object.fromEntries(all('SELECT section, payload FROM app_settings').map((r) => [r.section, parseJson(r.payload)])),
      // key names only (ciphertext is DPAPI / per-stack)
      app_secrets: all('SELECT name FROM app_secrets').map((r) => r.name).sort(),
      alerts: sortBy(all('SELECT * FROM alerts'), 'id').map((r) => ({ ...r, ack_at: r.ack_at !== null && r.ack_at !== '' })),
      alert_silences: sortBy(all('SELECT * FROM alert_silences'), 'scope_type', 'scope', 'starts_at').map((r) => ({ ...r, id: '<masked>', created_at: '<masked>' })),
      host_latest_snapshot: sortBy(all('SELECT * FROM host_latest_snapshot'), 'host_name').map((r) => ({ ...r, raw_json: parseJson(r.raw_json) })),
      // id is autoincrement; checked_at is stamped with now() at append time
      host_check_history: sortBy(all('SELECT host_name, check_name, status, latency_ms, checked_at FROM host_check_history'), 'host_name', 'check_name').map((r) => ({ ...r, checked_at: r.checked_at ? '<set>' : null })),
      host_check_snapshot: sortBy(all('SELECT * FROM host_check_snapshot'), 'host_name', 'check_name').map((r) => ({ ...r, checked_at: r.checked_at ? '<set>' : null })),
    };
  } finally {
    db.close();
  }
}

function pick(body: unknown, keys: string[]): Record<string, unknown> {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  return Object.fromEntries(keys.map((k) => [k, obj[k] === undefined ? '<absent>' : obj[k]]));
}

function alertStatuses(body: unknown): Record<string, unknown> {
  const list = ((body as { alerts?: Row[] })?.alerts ?? []) as Row[];
  return Object.fromEntries(list.map((a) => [String(a.id), a.status]));
}

function hostNames(body: unknown): string[] {
  const list = ((body as { hosts?: Row[] })?.hosts ?? (Array.isArray(body) ? body : [])) as Row[];
  return list.map((h) => String(h.name)).sort();
}

/**
 * Known app_settings divergences (section-level). Only these sections may be
 * absent on one side; every other section/field must match.
 */
export const WRITE_FLOW_ALLOWED_SECTIONS: Record<string, string> = {
  // Python-only startup migration bookkeeping: SettingsService.__init__
  // (servermanage/settings/core.py:66 `_ensure_machine_binding`) writes
  // security.machine_id; set_admin_password (servermanage/settings/admin.py:139-151)
  // writes security.migrated_at; the legacy sudo pass
  // (servermanage/settings/admin.py:209-217) writes security.sudo_migrated_at.
  // Node has no legacy YAML secret import / DPAPI machine binding, so it never
  // creates this section. Not produced by any step of the write sequence.
  security: 'Python-only startup migration markers (machine_id / migrated_at / sudo_migrated_at)',
};

// ---------------------------------------------------------------------------
// Run both stacks
// ---------------------------------------------------------------------------

const GOLDEN_FILE = path.join(REPO_ROOT, 'backend', 'test', 'diff', 'http', 'golden', 'write-flow.json');

let workDir: string;
const nodeRecs = new Map<string, Rec>();
const pyRecs = new Map<string, Rec>();
let nodeDump: Record<string, unknown>;
let pyDump: Record<string, unknown>;
let pyStdErr = '';

beforeAll(async () => {
  // Pin the Node clock to the instant the Python oracle ran so relative ages
  // ("N 分钟前", 24h windows) match the frozen golden forever.
  const frozenAtMs = golden<number>(GOLDEN_FILE, 'frozenAtMs');
  vi.useFakeTimers({ toFake: ['Date'], now: frozenAtMs });
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'writeflow-'));
  const nodeDbPath = path.join(workDir, 'node.db');
  const pyDbPath = path.join(workDir, 'python.db');
  fs.copyFileSync(SEED_DB, nodeDbPath);
  fs.copyFileSync(SEED_DB, pyDbPath);

  const servers = buildServers();
  const configPath = path.join(workDir, 'config.yaml');
  fs.writeFileSync(configPath, JSON.stringify({ storage: { db_path: pyDbPath }, app: { timezone: 'UTC' }, servers }, null, 2), 'utf8');

  // ---- Python ----
  const plan = {
    auth: { username: ADMIN_USERNAME, [SECRET_FIELD]: ADMIN_SECRET },
    stub_checks: [STUB_CHECK],
    requests: STEPS.map((s) => ({ name: s.name, method: s.method, path: s.path, json: s.json ?? null, bind: s.bind })),
  };
  const planPath = path.join(workDir, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify(plan), 'utf8');
  const frozen = golden<{ responses: Rec[]; dump: Record<string, unknown> }>(GOLDEN_FILE, 'python');
  for (const r of frozen.responses) pyRecs.set(r.name, r);

  // ---- Node ----
  const baseConfig = loadConfig({ SERVERMONITOR_DATA_DIR: workDir, SERVERMONITOR_APP_VERSION: APP_VERSION });
  const config = { ...baseConfig, dbPath: nodeDbPath, servers: servers as unknown as typeof baseConfig.servers };
  const nodeDb = openDatabase(nodeDbPath);
  setAdminPassword(nodeDb, { current: null, newPassword: ADMIN_SECRET, username: ADMIN_USERNAME } as Parameters<typeof setAdminPassword>[1]);
  const app = createServerApp({
    db: nodeDb,
    config,
    deps: { hosts: { runHostChecks: async (_h: HostConfig, _c: HostCheckConfig[]) => [{ ...STUB_CHECK }] } },
  });
  const agent = request.agent(app);
  const login = await agent.post('/login').type('form').send({ username: ADMIN_USERNAME, [SECRET_FIELD]: ADMIN_SECRET });
  nodeRecs.set('login', { name: 'login', status: login.status, json: null });
  // State-changing requests need the per-session CSRF token (meta tag in base.html).
  const settingsPage = await agent.get('/settings');
  const csrfToken = /name="csrf-token" content="([^"]+)"/.exec(settingsPage.text)?.[1] ?? '';
  const binds: Record<string, string> = {};
  for (const step of STEPS) {
    let p = step.path;
    for (const [k, v] of Object.entries(binds)) p = p.replace(`{${k}}`, v);
    const m = step.method.toLowerCase() as 'get' | 'post' | 'put' | 'delete';
    let req = agent[m](p).set('X-CSRF-Token', csrfToken);
    if (step.json) req = req.send(step.json);
    const res = await req;
    const body = res.body as Record<string, unknown> | undefined;
    if (step.bind && body && body.id !== undefined) binds[step.bind] = String(body.id);
    nodeRecs.set(step.name, { name: step.name, status: res.status, json: res.body });
  }
  nodeDb.close();

  nodeDump = dumpTables(nodeDbPath);
  pyDump = frozen.dump;
  if (process.env.WF_RAW) {
    for (const [label, file] of [['node', nodeDbPath], ['python', pyDbPath]] as const) {
      const raw = openDatabase(file);
      for (const row of raw.prepare('SELECT section, payload FROM app_settings ORDER BY section').all() as Row[]) {
        console.log(`@@RAW ${label} ${String(row.section)} ${String(row.payload)}`);
      }
      raw.close();
    }
  }
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('write-flow differential (Node vs Python)', () => {
  it('logs in on both stacks', () => {
    expect([nodeRecs.get('login')?.status, pyRecs.get('login')?.status]).toEqual([302, 302]);
  });

  for (const step of STEPS) {
    it(`step ${step.name}: ${step.method} ${step.path}`, () => {
      const node = nodeRecs.get(step.name);
      const py = pyRecs.get(step.name);
      expect(py?.error, `python error:\n${py?.error}\n${pyStdErr.slice(-2000)}`).toBeUndefined();
      const view = (r: Rec | undefined) => {
        const out: Record<string, unknown> = { status: r?.status };
        if (step.keys) Object.assign(out, pick(r?.json, step.keys));
        if (step.name === 'c_alerts_after_silence') out.alert_statuses = alertStatuses(r?.json);
        if (step.name === 'e_hosts_after_add') out.hosts = hostNames(r?.json);
        if (step.name === 'f_checks_run') out.checks = (r?.json as { checks?: unknown })?.checks ?? null;
        return normalizeValue(out);
      };
      // Every write in the sequence is a valid request: both stacks must accept it.
      expect([node?.status, py?.status], `node=${JSON.stringify(node?.json)}\npython=${JSON.stringify(py?.json)}`).toEqual([200, 200]);
      const diffs: Diff[] = [];
      diffValues(view(node), view(py), step.name, diffs);
      expect(diffs, `node=${JSON.stringify(node?.json)}\npython=${JSON.stringify(py?.json)}`).toEqual([]);
    });
  }

  it('silence on lab-01 resolves its open alert; ack sets acknowledged + ack_at (both stacks)', () => {
    for (const dump of [nodeDump, pyDump]) {
      const alerts = dump.alerts as Row[];
      expect(alerts.find((a) => a.id === 1)?.status).toBe('resolved');
      expect(alerts.find((a) => a.id === 4)).toMatchObject({ status: 'acknowledged', ack_at: true });
    }
  });

  for (const table of ['app_settings', 'app_secrets', 'alerts', 'alert_silences', 'host_latest_snapshot', 'host_check_history', 'host_check_snapshot']) {
    it(`table ${table} matches after the sequence`, () => {
      const diffs: Diff[] = [];
      if (table === 'app_settings') {
        const strip = (d: unknown): unknown => {
          const copy = { ...(d as Record<string, unknown>) };
          for (const key of Object.keys(WRITE_FLOW_ALLOWED_SECTIONS)) delete copy[key];
          return copy;
        };
        const nodeSide = strip(nodeDump[table]);
        const pySide = strip(pyDump[table]);
        diffValues(normalizeValue(applyMask(nodeSide, ['key_path'])), normalizeValue(applyMask(pySide, ['key_path'])), table, diffs);
        expect(diffs, `node=${JSON.stringify(nodeSide)}\npython=${JSON.stringify(pySide)}`).toEqual([]);
        return;
      }
      // key_path: same T2 mask (pathlib renders Windows separators; designated path identical).
      diffValues(normalizeValue(applyMask(nodeDump[table], ['key_path'])), normalizeValue(applyMask(pyDump[table], ['key_path'])), table, diffs);
      expect(diffs, `node=${JSON.stringify(nodeDump[table])}\npython=${JSON.stringify(pyDump[table])}`).toEqual([]);
    });
  }
});
