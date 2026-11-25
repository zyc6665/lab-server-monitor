/**
 * Tests for the scheduler wiring (P4 Task 10).
 *
 * Everything runs against a fresh SQLite database and injected collaborators —
 * no SSH, no real 600 s waits, no filesystem side effects beyond temp dirs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig, HostConfig } from '../../src/config/config';
import type { HostReport } from '../../src/collect/types';
import { Scheduler } from '../../src/runtime/scheduler';
import {
  buildCollectorConfig,
  buildScheduledTasks,
  startSchedulerIfConfigured,
  toStorageReport,
  type SchedulerWiringDeps,
} from '../../src/runtime/wiring';
import {
  getHostCheckResults,
  type HostReportInput,
  type PersistHostReportsOptions,
} from '../../src/storage/hosts';
import { saveAppSettings } from '../../src/storage/settings';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

const tempDirs: string[] = [];

afterEach(() => {
  cleanupStorageTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeLogDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-wiring-logs-'));
  tempDirs.push(dir);
  return dir;
}

function makeHost(name = 'alpha'): HostConfig {
  return {
    name,
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { type: 'password', password: 'pw' },
    tags: [],
    disk_mounts: ['/', '/data'],
    group: 'group',
    owner: 'owner',
    location: 'lab',
    notes: '',
    checks: [{ name: 'ssh', type: 'tcp', target: '22', timeout_seconds: 5, enabled: true }],
    allow_user_write: false,
  };
}

function makeConfig(servers: HostConfig[] = []): AppConfig {
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
    dataDir: '/tmp/sm-data',
    logDir: makeLogDir(),
    servers,
    appVersion: 'test',
  };
}

/** Minimal camelCase HostReport returned by the stubbed collector. */
function hostReport(overrides: Partial<HostReport> = {}): HostReport {
  const report = {
    hostName: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: {
      hostname: 'alpha',
      osPrettyName: 'Linux',
      kernelVersion: '6.1',
      uptime: '1 day',
      collectedAt: '2026-01-09T09:00:00.000Z',
      loadAverage: { load1: 1, load5: 2, load15: 3 },
      cpuCoreCount: 8,
      cpuUsagePercent: 12.5,
      memory: {
        totalMb: 1000,
        usedMb: 400,
        freeMb: 600,
        sharedMb: 0,
        buffCacheMb: 0,
        availableMb: 600,
        swapTotalMb: 0,
        swapUsedMb: 0,
        swapFreeMb: 0,
      },
      diskUsage: [
        {
          filesystem: '/dev/sda1',
          size: '100G',
          used: '40G',
          available: '60G',
          percent: '40%',
          mountpoint: '/',
        },
      ],
      loggedInUsers: [],
      totalProcesses: 120,
      processCountsByUser: {},
      topCpuProcesses: [],
      topMemoryProcesses: [],
      gpuSummary: [],
      gpuProcesses: [],
      netRxBytes: 1,
      netTxBytes: 2,
      containers: [],
      thermalZones: [{ label: 'cpu', celsius: 45 }],
    },
    errors: [],
    checks: [
      {
        name: 'ssh',
        type: 'tcp',
        target: '22',
        status: 'ok',
        message: '',
        latencyMs: 12,
        checkedAt: '2026-01-09T09:00:00.000Z',
      },
    ],
    users: [],
  };
  return { ...report, ...overrides } as unknown as HostReport;
}

/** Stub deps that keep every task inert except the parts under test. */
function inertDeps(overrides: Partial<SchedulerWiringDeps> = {}): SchedulerWiringDeps {
  return {
    collectAllHosts: async () => [],
    persistReports: () => undefined,
    pruneRetention: () => ({}),
    cleanupLogs: () => ({ deleted: 0, bytes: 0 }),
    ...overrides,
  };
}

function taskNamed(tasks: ReturnType<typeof buildScheduledTasks>, name: string) {
  const task = tasks.find((candidate) => candidate.name === name);
  expect(task, `task ${name}`).toBeDefined();
  return task as NonNullable<typeof task>;
}

function wall(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
}

describe('buildScheduledTasks — task set and cadences', () => {
  it('registers collect, daily-report, weekly-report and prune with the expected specs', () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost()]);

    const tasks = buildScheduledTasks({ db, config, deps: inertDeps() });
    expect(tasks.map((task) => task.name)).toEqual([
      'collect',
      'daily-report',
      'weekly-report',
      'prune',
    ]);

    expect(taskNamed(tasks, 'collect').intervalSeconds).toBe(600);
    expect(taskNamed(tasks, 'collect').calendar).toBeUndefined();

    expect(taskNamed(tasks, 'daily-report').calendar).toEqual({ kind: 'daily', hhmm: '09:00' });
    expect(taskNamed(tasks, 'weekly-report').calendar).toEqual({
      kind: 'weekly',
      hhmm: '16:00',
      weekday: 4,
    });

    expect(taskNamed(tasks, 'prune').intervalSeconds).toBe(3600);
  });

  it('honours the daily/weekly enable switches', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'report', { daily_enabled: false, weekly: { enabled: false } });
    const tasks = buildScheduledTasks({ db, config: makeConfig(), deps: inertDeps() });
    expect(tasks.map((task) => task.name)).toEqual(['collect', 'prune']);
  });

  it('honours a custom poll interval, timezone-driven calendar times remain configurable', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'monitoring', { poll_interval_seconds: 120, timezone: 'UTC' });
    saveAppSettings(db, 'report', { daily_time: '07:30', weekly: { time: '18:15', weekday: 2 } });
    const tasks = buildScheduledTasks({ db, config: makeConfig(), deps: inertDeps() });
    expect(taskNamed(tasks, 'collect').intervalSeconds).toBe(120);
    expect(taskNamed(tasks, 'daily-report').calendar).toEqual({ kind: 'daily', hhmm: '07:30' });
    expect(taskNamed(tasks, 'weekly-report').calendar).toEqual({
      kind: 'weekly',
      hhmm: '18:15',
      weekday: 2,
    });
  });

  it('daily/weekly report placeholders report they are not migrated yet', async () => {
    const { db } = freshDb();
    const tasks = buildScheduledTasks({ db, config: makeConfig(), deps: inertDeps() });
    await expect(Promise.resolve(taskNamed(tasks, 'daily-report').run())).resolves.toBe('skipped: report not migrated');
    await expect(Promise.resolve(taskNamed(tasks, 'weekly-report').run())).resolves.toBe('skipped: report not migrated');
  });
});

describe('buildScheduledTasks — collect task', () => {
  it('feeds the collector config and persists snake_cased reports (latency preserved)', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'monitoring', { timezone: 'UTC', concurrency: 4 });
    const config = makeConfig([makeHost()]);

    const captured: Array<{ reports: readonly HostReportInput[]; options: PersistHostReportsOptions }> = [];
    let seenCollectorConfig: unknown;
    const deps = inertDeps({
      collectAllHosts: async (collectorConfig) => {
        seenCollectorConfig = collectorConfig;
        return [hostReport()];
      },
      persistReports: (_db, reports, options) => {
        captured.push({ reports, options });
      },
    });

    const collect = taskNamed(buildScheduledTasks({ db, config, deps }), 'collect');
    await expect(collect.run()).resolves.toBe('collected 1 host(s), 0 failed');

    // Collector config assembled from app config + settings.
    expect(seenCollectorConfig).toMatchObject({
      servers: config.servers,
      ssh: { connect_timeout: 10, command_timeout: 20 },
      app: { concurrency: 4 },
    });

    expect(captured).toHaveLength(1);
    const [first] = captured[0].reports;
    expect(first.host_name).toBe('alpha');
    expect(first.success).toBe(true);
    expect(first.metrics?.cpu_usage_percent).toBe(12.5);
    expect(first.metrics?.memory).toEqual({ used_mb: 400, total_mb: 1000 });
    expect(first.metrics?.load_average).toEqual({ load_1: 1, load_5: 2, load_15: 3 });
    // The camelCase -> snake_case adaptation must keep check latency.
    expect(first.checks?.[0]).toMatchObject({
      name: 'ssh',
      status: 'ok',
      latency_ms: 12,
      checked_at: '2026-01-09T09:00:00.000Z',
    });
    expect(captured[0].options.tz).toBe('UTC');
    expect(captured[0].options.diskMounts).toEqual({ alpha: ['/', '/data'] });
  });

  it('persists through the real storage layer by default', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'monitoring', { timezone: 'UTC' });
    const config = makeConfig([makeHost()]);

    const deps: SchedulerWiringDeps = {
      collectAllHosts: async () => [hostReport()],
    };
    const collect = taskNamed(buildScheduledTasks({ db, config, deps }), 'collect');
    await collect.run();

    const checks = getHostCheckResults(db, 'alpha');
    expect(checks).toHaveLength(1);
    expect(checks[0].latency_ms).toBe(12);

    const metricsCount = db
      .prepare('SELECT COUNT(*) AS c FROM host_metrics_history')
      .get() as { c: number };
    expect(metricsCount.c).toBe(1);
  });
});

describe('buildScheduledTasks — prune task', () => {
  it('calls pruneRetention with retention config and cleanupLogs with the log dir', async () => {
    const { db } = freshDb();
    const config = makeConfig();
    let prunedWith: unknown;
    let cleanedWith: unknown;
    const now = wall(2026, 11, 26, 9, 0);
    let clock = now;
    const deps = inertDeps({
      pruneRetention: (_db, retention, opts) => {
        prunedWith = { retention, opts };
        return { host_metrics: 2 };
      },
      cleanupLogs: (logDir, hours) => {
        cleanedWith = { logDir, hours };
        return { deleted: 1, bytes: 10 };
      },
      now: () => clock,
    });

    const prune = taskNamed(buildScheduledTasks({ db, config, deps }), 'prune');
    const result = await prune.run();
    expect(result).toContain('pruned');
    expect(prunedWith).toMatchObject({ opts: { now } });
    expect(cleanedWith).toMatchObject({ logDir: config.logDir, hours: 24 });
    expect(clock).toBe(now);
  });
});

describe('runPending catch-up semantics', () => {
  it('runs daily + weekly once at the first tick after their slot, then not again', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'monitoring', { timezone: 'UTC' });
    const config = makeConfig([makeHost()]);
    // Friday 2026-01-09 17:00 UTC — both the 09:00 daily slot and the Friday
    // 16:00 weekly slot are already in the past, so both catch up now.
    const now = wall(2026, 1, 9, 17, 0);
    const deps = inertDeps({ now: () => now });

    const tasks = buildScheduledTasks({ db, config, deps });
    const scheduler = new Scheduler(tasks, { db, tz: 'UTC', now: () => now });

    await expect(scheduler.runPending()).resolves.toEqual([
      'collect',
      'daily-report',
      'weekly-report',
      'prune',
    ]);
    // Nothing is due again at the same instant.
    await expect(scheduler.runPending()).resolves.toEqual([]);
  });
});

describe('startSchedulerIfConfigured', () => {
  it('returns null when db or config is missing', () => {
    expect(startSchedulerIfConfigured({})).toBeNull();
    const { db } = freshDb();
    expect(startSchedulerIfConfigured({ db })).toBeNull();
    expect(startSchedulerIfConfigured({ config: makeConfig() })).toBeNull();
  });

  it('starts a Scheduler and stop() is idempotent', () => {
    const { db } = freshDb();
    const handle = startSchedulerIfConfigured({
      db,
      config: makeConfig(),
      deps: inertDeps(),
    });
    expect(handle).not.toBeNull();
    expect(handle?.scheduler).toBeInstanceOf(Scheduler);

    handle?.stop();
    expect(() => handle?.stop()).not.toThrow();
  });
});

describe('toStorageReport / buildCollectorConfig', () => {
  it('maps thermal zones, gpu and net fields to the storage shape', () => {
    const input = toStorageReport(hostReport());
    expect(input.metrics?.thermal_zones).toEqual([{ celsius: 45 }]);
    expect(input.metrics?.hottest_temperature_c).toBe(45);
    expect(input.metrics?.net_rx_bytes).toBe(1);
    expect(input.metrics?.net_tx_bytes).toBe(2);
  });

  it('buildCollectorConfig defaults ssh timeouts and concurrency', () => {
    const config = buildCollectorConfig(makeConfig(), {});
    expect(config.ssh).toEqual({ connect_timeout: 10, command_timeout: 20 });
    expect(config.app).toEqual({ concurrency: null });
  });
});
