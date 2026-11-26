/**
 * P1-1: host detail `stage_timings` slice.
 *
 * `buildHostDetail` must surface the Node-only `stageTimings` extension that
 * lives in the stored snapshot's raw JSON. `decodeSnapshot` intentionally drops
 * unknown keys, so the builder reads `host_latest_snapshot.raw_json` directly.
 * Legacy snapshots (no key) and malformed payloads must degrade to `[]`.
 *
 * The final block renders `host.html` to smoke-test the new 「采集耗时」 section
 * in both its populated and empty states.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/storage/dpapi', () => ({
  dpapiAvailable: () => true,
  protect: (buffer: Buffer) => Buffer.from(buffer),
  unprotect: (buffer: Buffer) => Buffer.from(buffer),
  DpapiUnavailableError: class DpapiUnavailableError extends Error {},
}));

import { buildHostDetail } from '../../src/web/routes/overview';
import { createTemplating, defaultTemplatesDir } from '../../src/web/templating';
import type { AppConfig, HostConfig } from '../../src/config/config';
import { getHostSnapshot, saveHostSnapshot } from '../../src/storage/hosts';
import { nowIsoUtc } from '../../src/storage/time';
import { cleanupStorageTests, freshDb, type FreshDb } from '../storage-helpers';

type Obj = Record<string, unknown>;

afterEach(() => {
  cleanupStorageTests();
});

function makeServer(overrides: Partial<HostConfig> & { name: string; host: string }): HostConfig {
  return {
    name: overrides.name,
    host: overrides.host,
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/', '/data'],
    group: 'Web',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

function makeConfig(servers: HostConfig[]): AppConfig {
  return {
    dbPath: '/tmp/host-stage-timings-test.db',
    host: '127.0.0.1',
    port: 0,
    dataDir: '',
    logDir: '',
    servers,
    appVersion: 'test',
  };
}

function baseMetrics(collectedAt: string) {
  return {
    collected_at: collectedAt,
    cpu_usage_percent: 20,
    cpu_core_count: 4,
    uptime: '3 days',
    memory: { total_mb: 1000, used_mb: 500 },
    load_average: { load_1: 1.2, load_5: 1.0, load_15: 0.8 },
    disk_usage: [
      { filesystem: '/dev/sda1', mountpoint: '/', used: '10G', size: '20G', percent: '50%' },
    ],
    gpu_summary: [],
    logged_in_users: [],
    thermal_zones: [],
    net_rx_bytes: 0,
    net_tx_bytes: 0,
    containers: [],
  };
}

interface Fixture {
  fresh: FreshDb;
  config: AppConfig;
  now: Date;
}

/** Seeds a stored snapshot for `alpha`. The raw JSON is rewritten by callers. */
function seedHost(): Fixture {
  const fresh = freshDb();
  const config = makeConfig([makeServer({ name: 'alpha', host: '10.0.0.1' })]);
  const now = new Date('2026-01-02T03:04:05.000Z');
  const collectedAt = nowIsoUtc(now);

  saveHostSnapshot(fresh.db, {
    host_name: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: baseMetrics(collectedAt) as never,
  });

  return { fresh, config, now };
}

/** Overwrites the stored snapshot's raw JSON with an exact fixture payload. */
function writeRawJson(fixture: Fixture, value: string): void {
  fixture.fresh.db
    .prepare('UPDATE host_latest_snapshot SET raw_json = ? WHERE host_name = ?')
    .run(value, 'alpha');
}

function buildDetail(fixture: Fixture) {
  return buildHostDetail(
    'alpha',
    fixture.config,
    fixture.fresh.db,
    getHostSnapshot(fixture.fresh.db, 'alpha'),
    undefined,
    [],
    [],
    'Asia/Shanghai',
    600,
    {},
    fixture.now,
  );
}

describe('buildHostDetail — stage_timings (P1-1)', () => {
  it('reads and normalises stage timings from the stored raw_json report', () => {
    const fixture = seedHost();
    writeRawJson(
      fixture,
      JSON.stringify({
        host_name: 'alpha',
        host: '10.0.0.1',
        success: true,
        metrics: {},
        stageTimings: [
          { stage: 'hostname', ms: 12, ok: true },
          { stage: 'kernel', ms: 8, ok: false, error: 'command exited 2' },
          { stage: '', ms: 5, ok: true }, // dropped: empty stage
          { stage: 'disk', ms: 'oops', ok: true }, // dropped: non-numeric ms
          { stage: 'uptime', ms: 3, ok: false, error: '' }, // error omitted when empty
        ],
      }),
    );

    const detail = buildDetail(fixture);

    expect(detail.stage_timings).toEqual([
      { stage: 'hostname', ms: 12, ok: true },
      { stage: 'kernel', ms: 8, ok: false, error: 'command exited 2' },
      { stage: 'uptime', ms: 3, ok: false },
    ]);
  });

  it('also accepts the snake_case stage_timings storage spelling', () => {
    const fixture = seedHost();
    writeRawJson(
      fixture,
      JSON.stringify({
        host_name: 'alpha',
        host: '10.0.0.1',
        success: true,
        metrics: {},
        stage_timings: [{ stage: 'hostname', ms: 7, ok: true }],
      }),
    );

    const detail = buildDetail(fixture);

    expect(detail.stage_timings).toEqual([{ stage: 'hostname', ms: 7, ok: true }]);
  });

  it('returns an empty array for a legacy snapshot without stageTimings', () => {
    const fixture = seedHost();

    const detail = buildDetail(fixture);

    expect(detail.stage_timings).toEqual([]);
  });

  it('returns an empty array when stageTimings is not an array', () => {
    const fixture = seedHost();
    writeRawJson(
      fixture,
      JSON.stringify({ host_name: 'alpha', host: '10.0.0.1', success: true, metrics: {}, stageTimings: 'oops' }),
    );

    const detail = buildDetail(fixture);

    expect(detail.stage_timings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Render smoke: host.html 「采集耗时」 section
// ---------------------------------------------------------------------------

const renderer = createTemplating({ templatesDir: defaultTemplatesDir(), appVersion: 'test' });

const sessionStub = {
  get: (key: string, fallback?: unknown): unknown => {
    if (key === 'logged_in') return true;
    if (key === 'username') return 'admin';
    return fallback === undefined ? '' : fallback;
  },
};

/** A minimal but complete host.html fixture (proven shape from template-adapter). */
function hostFixture(stageTimings: Obj[] | undefined): Record<string, unknown> {
  const metrics = {
    memory: { used_mb: 4000, total_mb: 8000 },
    disk_usage: [
      { filesystem: '/dev/sda1', mountpoint: '/', size: '100G', used: '37G', available: '63G', percent: 37 },
    ],
    gpu_summary: [],
    gpu_processes: [],
    thermal_zones: [],
    logged_in_users: [],
    containers: [],
    cpu_core_count: 16,
    cpu_usage_percent: 12.5,
    kernel_version: '6.1.0',
    load_average: [0.1, 0.2, 0.3],
    os_pretty_name: 'Ubuntu 22.04',
    uptime: '3 days',
  };
  const detail: Obj = {
    name: 'alpha',
    host: '10.0.0.1',
    group: 'Web',
    owner: 'alice',
    collected_at: '2026-01-02T03:04:05',
    success: true,
    errors: [],
    metrics,
    checks: [],
    check_history: {},
    alerts: [],
    alert_days: [],
    network: {},
    uptime_strip: [],
    diagnostics: null,
    diagnostics_summary: null,
    disk: null,
  };
  if (stageTimings !== undefined) {
    detail.stage_timings = stageTimings;
  }
  return {
    active_page: 'hosts',
    view_mode: 'admin',
    app_version: 'test',
    session: sessionStub,
    name: 'alpha',
    detail,
  };
}

describe('render: host.html — 采集耗时', () => {
  it('renders a row per stage with status and error columns', () => {
    const html = renderer.render('host.html', hostFixture([
      { stage: 'hostname', ms: 12, ok: true },
      { stage: 'kernel', ms: 8, ok: false, error: 'command exited 2' },
    ]));

    expect(html).toContain('采集耗时');
    expect(html).toContain('2 个阶段');
    expect(html).toContain('hostname');
    expect(html).toContain('12 ms');
    expect(html).toContain('status-ok');
    expect(html).toContain('status-failed');
    expect(html).toContain('command exited 2');
  });

  it('renders the muted empty line when there are no timings', () => {
    const html = renderer.render('host.html', hostFixture([]));

    expect(html).toContain('采集耗时');
    expect(html).toContain('暂无采集耗时数据。');
  });

  it('tolerates a detail object without a stage_timings key', () => {
    const html = renderer.render('host.html', hostFixture(undefined));

    expect(html).toContain('采集耗时');
    expect(html).toContain('暂无采集耗时数据。');
  });
});
