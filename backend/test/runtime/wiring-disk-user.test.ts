/**
 * Tests for the P5 Task 11b disk-poll / user-scan scheduler wiring and the
 * on-demand `collectHostsNow` helper (P5 Task 11b).
 *
 * Everything runs against a fresh SQLite database with injected collaborators —
 * no SSH, no real network, no filesystem side effects beyond temp dirs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig, HostConfig } from '../../src/config/config';
import type { HostReport } from '../../src/collect/types';
import type { AlertEvent } from '../../src/alerts/rules';
import type { DiskHealthReport } from '../../src/disk/report';
import { loadEffectiveSettings } from '../../src/config/service';
import {
  buildDiskPollTask,
  buildScheduledTasks,
  buildUserScanTask,
  collectHostsNow,
  type DiskPollAlertEngine,
  type SchedulerWiringDeps,
} from '../../src/runtime/wiring';
import { getCollectionStatusRegistry } from '../../src/runtime/collection-status';
import { saveDiskHealth, getDiskHealth } from '../../src/storage/disk';
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
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-wiring-du-'));
  tempDirs.push(dir);
  return dir;
}

function makeHost(name = 'alpha', overrides: Partial<HostConfig> = {}): HostConfig {
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
    checks: [],
    allow_user_write: false,
    ...overrides,
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

const fakeRunner = {
  run: async () => ({ stdout: '', stderr: '', exitStatus: 0 }),
  runSudo: async () => ({ stdout: '', stderr: '', exitStatus: 0 }),
  close: () => undefined,
};

function diskReport(hostName: string, status = 'ok'): DiskHealthReport {
  return {
    host_name: hostName,
    collected_at: '2026-01-09T09:00:00.000Z',
    status,
    message: '',
    controllers: [],
    virtual_drives: [],
    physical_drives: [],
  } as unknown as DiskHealthReport;
}

function alertEvent(hostName: string, fingerprint: string): AlertEvent {
  return {
    host_name: hostName,
    category: 'disk',
    severity: 'warning',
    title: 'disk',
    message: 'disk',
    fingerprint,
    reasons: [],
  };
}

function hostReport(name: string, success = true): HostReport {
  return {
    hostName: name,
    host: '10.0.0.1',
    success,
    metrics: null,
    errors: [],
    checks: [],
    users: [],
  } as unknown as HostReport;
}

function engineSpy(): {
  engine: DiskPollAlertEngine;
  processed: AlertEvent[][];
  resolved: Array<{ host: string; fps: readonly string[]; opts?: unknown }>;
} {
  const processed: AlertEvent[][] = [];
  const resolved: Array<{ host: string; fps: readonly string[]; opts?: unknown }> = [];
  return {
    engine: {
      process: async (events) => {
        processed.push(events);
        return events;
      },
      resolve_missing: (host, fps, opts) => {
        resolved.push({ host, fps, opts });
      },
    },
    processed,
    resolved,
  };
}

describe('buildDiskPollTask', () => {
  it('collects, saves, evaluates, processes and prunes disk health', async () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost('alpha')]);
    const saveCalls: Array<{ host: string }> = [];
    const pruneCalls: Array<{ days?: number; batches?: number }> = [];
    const spy = engineSpy();
    const deps: SchedulerWiringDeps = {
      createDiskRunner: () => fakeRunner,
      collectDisk: async (host) => diskReport(host.name),
      saveDisk: (_db, report) => {
        saveCalls.push({ host: report.host_name });
      },
      evaluateDisk: () => [alertEvent('alpha', 'fp-alpha')],
      pruneDisk: (_db, days, batches) => {
        pruneCalls.push({ days, batches });
        return {};
      },
      diskAlertEngine: spy.engine,
    };

    const settings = loadEffectiveSettings(db);
    const task = buildDiskPollTask(db, config, settings, deps);
    expect(task.name).toBe('disk-poll');
    expect(task.intervalSeconds).toBe(86_400);

    const result = await task.run();
    expect(result).toBe('disk poll: 1 host(s), 0 failed, 1 alert(s)');
    expect(saveCalls).toEqual([{ host: 'alpha' }]);
    expect(pruneCalls).toEqual([{ days: 7, batches: 100 }]);
    expect(spy.processed).toHaveLength(1);
    expect(spy.processed[0].map((event) => event.fingerprint)).toEqual(['fp-alpha']);
    expect(spy.resolved).toEqual([
      { host: 'alpha', fps: ['fp-alpha'], opts: { category: 'disk', notify: true } },
    ]);
  });

  it('isolates a single host failure from the remaining hosts', async () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost('bad'), makeHost('good')]);
    const saved: string[] = [];
    const spy = engineSpy();
    const deps: SchedulerWiringDeps = {
      createDiskRunner: () => fakeRunner,
      collectDisk: async (host) => {
        if (host.name === 'bad') {
          throw new Error('storcli failed');
        }
        return diskReport(host.name);
      },
      saveDisk: (_db, report) => {
        saved.push(report.host_name);
      },
      evaluateDisk: (report) => [alertEvent(report.host_name, `fp-${report.host_name}`)],
      pruneDisk: () => ({}),
      diskAlertEngine: spy.engine,
    };

    const task = buildDiskPollTask(db, config, loadEffectiveSettings(db), deps);
    const result = await task.run();
    expect(result).toBe('disk poll: 1 host(s), 1 failed, 1 alert(s)');
    expect(saved).toEqual(['good']);
    expect(spy.processed[0].map((event) => event.host_name)).toEqual(['good']);
  });

  it('skips entirely when disk_health.enabled is false', async () => {
    const { db } = freshDb();
    saveAppSettings(db, 'disk_health', { enabled: false });
    const config = makeConfig([makeHost('alpha')]);
    let collected = 0;
    const deps: SchedulerWiringDeps = {
      createDiskRunner: () => fakeRunner,
      collectDisk: async (host) => {
        collected += 1;
        return diskReport(host.name);
      },
      saveDisk: () => undefined,
      evaluateDisk: () => [],
      pruneDisk: () => ({}),
      diskAlertEngine: { process: async () => [] },
    };
    const task = buildDiskPollTask(db, config, loadEffectiveSettings(db), deps);
    await expect(task.run()).resolves.toBe('disk poll skipped (disk_health.enabled=false)');
    expect(collected).toBe(0);
  });

  it('skips hosts whose per-host disk_health.enabled is false', async () => {
    const { db } = freshDb();
    const config = makeConfig([
      makeHost('off', { disk_health: { enabled: false } }),
      makeHost('on'),
    ]);
    const seen: string[] = [];
    const deps: SchedulerWiringDeps = {
      createDiskRunner: () => fakeRunner,
      collectDisk: async (host) => {
        seen.push(host.name);
        return diskReport(host.name);
      },
      saveDisk: () => undefined,
      evaluateDisk: () => [],
      pruneDisk: () => ({}),
      diskAlertEngine: { process: async () => [] },
    };
    const task = buildDiskPollTask(db, config, loadEffectiveSettings(db), deps);
    await task.run();
    expect(seen).toEqual(['on']);
  });

  it('threads the previous report (from the stored snapshot) into collection', async () => {
    const { db } = freshDb();
    saveDiskHealth(db, diskReport('alpha', 'ok') as never);
    const config = makeConfig([makeHost('alpha')]);
    let previousHost: string | null = null;
    let hadPrevious = false;
    const deps: SchedulerWiringDeps = {
      createDiskRunner: () => fakeRunner,
      collectDisk: async (host, _runner, options) => {
        hadPrevious = options?.previous != null;
        previousHost = options?.previous?.host_name ?? null;
        return diskReport(host.name);
      },
      saveDisk: () => undefined,
      evaluateDisk: () => [],
      pruneDisk: () => ({}),
      diskAlertEngine: { process: async () => [] },
    };
    const task = buildDiskPollTask(db, config, loadEffectiveSettings(db), deps);
    await task.run();
    expect(getDiskHealth(db, 'alpha')).not.toBeNull();
    expect(hadPrevious).toBe(true);
    expect(previousHost).toBe('alpha');
  });
});

describe('buildUserScanTask', () => {
  it('returns a ScanSummary-derived summary string', async () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost('alpha')]);
    const deps: SchedulerWiringDeps = {
      runUserScan: async () => ({
        hosts_total: 3,
        hosts_done: 2,
        hosts_failed: 1,
        accounts: 7,
        errors: { gamma: 'ssh timeout' },
        started_at: '2026-01-09T09:00:00.000Z',
        finished_at: '2026-01-09T09:00:30.000Z',
        running: false,
        current_host: null,
        current_account: null,
        next_account: null,
        accounts_done: 7,
        accounts_total: 7,
      }),
    };
    const task = buildUserScanTask(db, config, loadEffectiveSettings(db), deps);
    expect(task.name).toBe('user-scan');
    expect(task.intervalSeconds).toBe(3600);
    await expect(task.run()).resolves.toBe(
      'user scan: 2/3 host(s), 7 account(s), 1 failed',
    );
  });

  it('is not registered when user monitoring is globally disabled', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'user_monitoring', { enabled: false });
    const config = makeConfig([makeHost('alpha')]);
    const names = buildScheduledTasks({ db, config, deps: {} }).map((task) => task.name);
    expect(names).not.toContain('user-scan');
    // disk-poll is still always registered.
    expect(names).toContain('disk-poll');
  });
});

describe('collectHostsNow', () => {
  it('records a done state in the shared collection-status registry', async () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost('alpha')]);
    const deps: SchedulerWiringDeps = {
      collectAllHosts: async () => [hostReport('alpha')],
      persistReports: () => undefined,
    };

    const summary = await collectHostsNow(db, config, ['alpha'], deps);
    expect(summary).toBe('collected 1 host(s), 0 failed');
    expect(getCollectionStatusRegistry(db).snapshot(['alpha'])).toMatchObject({
      alpha: { state: 'done', error: null },
    });
  });

  it('records an error state for a failed host', async () => {
    const { db } = freshDb();
    const config = makeConfig([makeHost('alpha')]);
    const deps: SchedulerWiringDeps = {
      collectAllHosts: async () => [hostReport('alpha', false)],
      persistReports: () => undefined,
    };

    const summary = await collectHostsNow(db, config, ['alpha'], deps);
    expect(summary).toBe('collected 1 host(s), 1 failed');
    expect(getCollectionStatusRegistry(db).snapshot(['alpha'])).toMatchObject({
      alpha: { state: 'error' },
    });
  });
});
