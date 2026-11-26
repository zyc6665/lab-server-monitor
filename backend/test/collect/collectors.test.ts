/**
 * Unit tests for `backend/src/collect/collectors.ts` — the collection
 * orchestration ported from the Python oracle `servermanage/collectors.py`.
 *
 * Nothing here opens a real SSH connection: every test injects a fake
 * `CollectorRunner` (and a fake `buildRunner` for `collectAllHosts`). The fake
 * runners record the exact command order and timeout they were called with so
 * the tests can pin the Python semantics:
 * - every stage runs in `buildCommandMap()` order;
 * - a non-zero stage is recorded as an error but does not fail the report;
 * - a runner exception (ssh) aborts the host and yields `success: false`;
 * - a parser exception yields a `parse` error and `success: false`;
 * - an absent `hostname` falls back to `host.name`;
 * - checks are injected and their failures are isolated;
 * - `collectAllHosts` preserves host order under concurrency and closes runners.
 */
import { describe, expect, it } from 'vitest';

import { buildCommandMap } from '../../src/collect/commands';
import type { Stage } from '../../src/collect/commands';
import {
  collectAllHosts,
  collectHostReport,
  hostToSshConnectConfig,
  mapWithConcurrency,
} from '../../src/collect/collectors';
import type { CollectorConfig, CollectorRunner } from '../../src/collect/collectors';
import { emptyHostMetrics } from '../../src/collect/types';
import type { CommandResult, HostCheckResult, HostMetrics } from '../../src/collect/types';
import type { HostConfig } from '../../src/config/config';

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ok(stdout = ''): CommandResult {
  return { stdout, stderr: '', exitStatus: 0 };
}

function bad(exitStatus: number, stderr = ''): CommandResult {
  return { stdout: '', stderr, exitStatus };
}

type RunHandler = (command: string, timeoutMs: number) => CommandResult | Promise<CommandResult>;

interface FakeRunner extends CollectorRunner {
  calls: Array<{ command: string; timeoutMs: number }>;
  closeCalls: number[];
}

/** A fake `CollectorRunner` that never touches the network. */
function makeRunner(handler: RunHandler, extra: { connectTimeout?: number } = {}): FakeRunner {
  const calls: Array<{ command: string; timeoutMs: number }> = [];
  const closeCalls: number[] = [];
  const runner: FakeRunner = {
    calls,
    closeCalls,
    async run(command: string, timeoutMs: number): Promise<CommandResult> {
      calls.push({ command, timeoutMs });
      return handler(command, timeoutMs);
    },
    close(): void {
      closeCalls.push(1);
    },
  };
  if ('connectTimeout' in extra) {
    runner.connectTimeout = extra.connectTimeout;
  }
  return runner;
}

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name: 'web-1',
    host: '10.0.0.1',
    port: 22,
    username: 'ops',
    auth: { type: 'password', password: 'secret' },
    tags: [],
    disk_mounts: ['/', '/data'],
    group: 'g',
    owner: 'o',
    location: 'l',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

/**
 * A minimal command map for tests that only care about a couple of stages.
 * The cast is deliberate: `buildCommandMap` is typed as the full record but
 * only the supplied keys are iterated at runtime (Python's dict semantics).
 */
function onlyStages(commands: Partial<Record<Stage, string>>): Record<Stage, string> {
  return commands as Record<Stage, string>;
}

function makeConfig(
  servers: HostConfig[],
  opts: { concurrency?: number; connectTimeout?: number; commandTimeout?: number } = {},
): CollectorConfig {
  return {
    servers,
    ssh: {
      connect_timeout: opts.connectTimeout ?? 10,
      command_timeout: opts.commandTimeout ?? 20,
      host_key_policy: 'tofu',
    },
    app: { concurrency: opts.concurrency ?? 1 },
  };
}

// ---------------------------------------------------------------------------
// collectHostReport
// ---------------------------------------------------------------------------

describe('collectHostReport', () => {
  it('runs every stage of the default command map in order and parses the metrics', async () => {
    const host = makeHost({ name: 'node-a' });
    const expectedCommands = Object.values(buildCommandMap());

    const runner = makeRunner((command) => (command === 'hostname' ? ok('node-a\n') : ok('')));

    const report = await collectHostReport(host, runner, { connectTimeout: 5, commandTimeout: 7000 });

    expect(report.success).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.hostName).toBe('node-a');
    expect(report.host).toBe('10.0.0.1');
    expect(report.metrics.hostname).toBe('node-a');
    expect(report.metrics.collectedAt).not.toBeNull();
    // Every stage ran exactly once, in command-map order.
    expect(runner.calls.map((c) => c.command)).toEqual(expectedCommands);
    // The caller-supplied command timeout is forwarded verbatim to `run`.
    expect(runner.calls.every((c) => c.timeoutMs === 7000)).toBe(true);
    // `collectHostReport` never closes the runner (ownership stays with the caller).
    expect(runner.closeCalls).toHaveLength(0);
    // No `runHostChecks` injected -> empty checks.
    expect(report.checks).toEqual([]);
  });

  it('records a non-zero stage as an error but keeps success true, excluding its stdout from parsing', async () => {
    const map = buildCommandMap();
    const runner = makeRunner((command) => {
      if (command === map.hostname) return ok('node-b');
      if (command === map.kernel) return bad(1, 'kernel boom');
      if (command === map.uptime) return bad(2, '');
      return ok('');
    });

    const report = await collectHostReport(makeHost({ name: 'node-b' }), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
    });

    expect(report.success).toBe(true);
    expect(report.errors).toEqual([
      { stage: 'kernel', message: 'kernel boom' },
      { stage: 'uptime', message: 'command exited 2' },
    ]);
    // The successful stage parsed; the two failed stages contributed nothing.
    expect(report.metrics.hostname).toBe('node-b');
    expect(report.metrics.kernelVersion).toBeNull();
    expect(report.metrics.uptime).toBeNull();
  });

  it('treats an undefined exitStatus as a failure (Python exit_status != 0 semantics)', async () => {
    const map = buildCommandMap();
    const runner = makeRunner((command) =>
      command === map.cpu_cores
        ? ({ stdout: '', stderr: '', exitStatus: undefined } as unknown as CommandResult)
        : ok(''),
    );

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
    });

    expect(report.success).toBe(true);
    expect(report.errors).toEqual([{ stage: 'cpu_cores', message: 'command exited undefined' }]);
  });

  it('aborts with a stage "ssh" error and success false when the runner throws', async () => {
    const map = buildCommandMap();
    const runner = makeRunner((command) => {
      if (command === map.kernel) throw new Error('connect refused');
      return ok('');
    });

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
    });

    expect(report.success).toBe(false);
    expect(report.errors).toEqual([{ stage: 'ssh', message: 'connect refused' }]);
    // hostname, os_release, kernel -> stopped right after the throwing stage.
    expect(runner.calls).toHaveLength(3);
    expect(report.metrics).toEqual(emptyHostMetrics());
  });

  it('aborts with a stage "parse" error and success false when parsing throws', async () => {
    const runner = makeRunner(() => ok(''));

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
      parseResults: () => {
        throw new Error('bad parse');
      },
    });

    expect(report.success).toBe(false);
    expect(report.errors).toEqual([{ stage: 'parse', message: 'bad parse' }]);
    expect(report.metrics).toEqual(emptyHostMetrics());
  });

  it('falls back to host.name when the parser yields no hostname, and stamps collectedAt', async () => {
    const host = makeHost({ name: 'fallback-host' });
    const runner = makeRunner(() => ok(''));

    // A parser that deliberately leaves both hostname and collectedAt empty.
    const parser = (): HostMetrics => emptyHostMetrics();

    const report = await collectHostReport(host, runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
      parseResults: parser,
    });

    expect(report.metrics.hostname).toBe('fallback-host');
    expect(report.metrics.collectedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/,
    );
  });

  it('preserves a collectedAt value supplied by the parser', async () => {
    const stamped = '2020-01-01T00:00:00.000000+00:00';
    const runner = makeRunner(() => ok(''));

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
      parseResults: () => ({ ...emptyHostMetrics(), hostname: 'x', collectedAt: stamped }),
    });

    expect(report.metrics.collectedAt).toBe(stamped);
  });

  it('assigns connectTimeout onto a runner that exposes the property', async () => {
    const runner = makeRunner(() => ok(''), { connectTimeout: 1 });

    await collectHostReport(makeHost(), runner, { connectTimeout: 9, commandTimeout: 1000 });

    expect(runner.connectTimeout).toBe(9);
  });

  it('does not invent a connectTimeout property on a runner that has none', async () => {
    const runner = makeRunner(() => ok(''));

    await collectHostReport(makeHost(), runner, { connectTimeout: 9, commandTimeout: 1000 });

    expect('connectTimeout' in runner).toBe(false);
  });

  it('invokes injected runHostChecks with (host, runner, host.checks, commandTimeout)', async () => {
    const check: HostCheckResult = {
      name: 'tcp-80',
      type: 'tcp',
      target: '80',
      status: 'ok',
      message: '',
      latencyMs: 3,
      checkedAt: '2020-01-01T00:00:00.000000+00:00',
    };
    const host = makeHost({
      checks: [{ name: 'tcp-80', type: 'tcp', target: '80', timeout_seconds: 1, enabled: true }],
    });
    const runner = makeRunner(() => ok(''));

    const seen: Array<[HostConfig, CollectorRunner, HostConfig['checks'], number]> = [];
    const report = await collectHostReport(host, runner, {
      connectTimeout: 1,
      commandTimeout: 4500,
      runHostChecks: async (h, r, checks, timeoutMs) => {
        seen.push([h, r, checks, timeoutMs]);
        return [check];
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe(host);
    expect(seen[0][1]).toBe(runner);
    expect(seen[0][2]).toBe(host.checks);
    expect(seen[0][3]).toBe(4500);
    expect(report.checks).toEqual([check]);
    expect(report.success).toBe(true);
  });

  it('isolates a throwing runHostChecks as a non-fatal stage "checks" error', async () => {
    const runner = makeRunner(() => ok(''));

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 1,
      commandTimeout: 1000,
      runHostChecks: async () => {
        throw new Error('probe down');
      },
    });

    expect(report.success).toBe(true);
    expect(report.checks).toEqual([]);
    expect(report.errors).toEqual([{ stage: 'checks', message: 'probe down' }]);
  });
});

// ---------------------------------------------------------------------------
// collectAllHosts
// ---------------------------------------------------------------------------

describe('collectAllHosts', () => {
  it('returns [] for an empty servers list without building a runner', async () => {
    let built = 0;
    const reports = await collectAllHosts(
      { servers: [] },
      {
        buildRunner: () => {
          built += 1;
          return makeRunner(() => ok(''));
        },
      },
    );

    expect(reports).toEqual([]);
    expect(built).toBe(0);
  });

  it('preserves input order even when hosts finish out of order under concurrency', async () => {
    const hosts = [makeHost({ name: 'h1' }), makeHost({ name: 'h2' }), makeHost({ name: 'h3' })];
    const delays: Record<string, number> = { h1: 15, h2: 2, h3: 8 };
    const built: Array<{ host: HostConfig; connectTimeout: number; runner: FakeRunner }> = [];

    const buildRunner = (host: HostConfig, connectTimeout: number): CollectorRunner => {
      const runner = makeRunner(async (command) => {
        await sleep(delays[host.name]);
        return command === 'hostname' ? ok(host.name) : ok('');
      });
      built.push({ host, connectTimeout, runner });
      return runner;
    };

    const reports = await collectAllHosts(makeConfig(hosts, { concurrency: 3, connectTimeout: 8, commandTimeout: 5 }), {
      buildRunner,
      buildCommandMap: () => onlyStages({ hostname: 'hostname', kernel: 'uname -r' }),
    });

    expect(reports.map((r) => r.hostName)).toEqual(['h1', 'h2', 'h3']);
    expect(reports.map((r) => r.metrics.hostname)).toEqual(['h1', 'h2', 'h3']);
    expect(reports.every((r) => r.success)).toBe(true);
    // The runner factory received the config's connect timeout (seconds) ...
    expect(built.map((b) => b.connectTimeout)).toEqual([8, 8, 8]);
    // ... and commands received the config's command timeout converted to ms.
    expect(built.every((b) => b.runner.calls.every((c) => c.timeoutMs === 5000))).toBe(true);
    // Every runner was closed exactly once in `finally`.
    expect(built.map((b) => b.runner.closeCalls.length)).toEqual([1, 1, 1]);
  });

  it('caps in-flight hosts at the configured concurrency', async () => {
    const hosts = [makeHost({ name: 'a' }), makeHost({ name: 'b' }), makeHost({ name: 'c' })];
    let active = 0;
    let maxActive = 0;

    const buildRunner = (host: HostConfig): CollectorRunner =>
      makeRunner(async (command) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(10);
        active -= 1;
        return command === 'hostname' ? ok(host.name) : ok('');
      });

    const reports = await collectAllHosts(makeConfig(hosts, { concurrency: 2 }), {
      buildRunner,
      buildCommandMap: () => onlyStages({ hostname: 'hostname' }),
    });

    expect(reports.map((r) => r.hostName)).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(2);
  });

  it('runs a single host sequentially regardless of configured concurrency', async () => {
    const host = makeHost({ name: 'solo' });
    let active = 0;
    let maxActive = 0;

    const buildRunner = (h: HostConfig): CollectorRunner =>
      makeRunner(async (command) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
        return command === 'hostname' ? ok(h.name) : ok('');
      });

    const reports = await collectAllHosts(makeConfig([host], { concurrency: 4 }), {
      buildRunner,
      buildCommandMap: () => onlyStages({ hostname: 'hostname' }),
    });

    expect(reports).toHaveLength(1);
    expect(reports[0].success).toBe(true);
    expect(maxActive).toBe(1);
  });

  it('turns a throwing buildRunner into a per-host ssh failure without affecting others', async () => {
    const hosts = [makeHost({ name: 'good' }), makeHost({ name: 'bad' })];
    const goodRunner = makeRunner((command) => (command === 'hostname' ? ok('good') : ok('')));
    const builtFor: string[] = [];

    const buildRunner = (host: HostConfig): CollectorRunner => {
      builtFor.push(host.name);
      if (host.name === 'bad') {
        throw new Error('no route');
      }
      return goodRunner;
    };

    const reports = await collectAllHosts(makeConfig(hosts, { concurrency: 2 }), {
      buildRunner,
      buildCommandMap: () => onlyStages({ hostname: 'hostname' }),
    });

    expect(builtFor).toEqual(['good', 'bad']);
    expect(reports).toHaveLength(2);
    expect(reports[0].success).toBe(true);
    expect(reports[1].success).toBe(false);
    expect(reports[1].errors).toEqual([{ stage: 'ssh', message: 'no route' }]);
    expect(reports[1].metrics).toEqual(emptyHostMetrics());
    expect(goodRunner.closeCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe('mapWithConcurrency', () => {
  it('preserves order, never exceeds the limit, and handles limits above length', async () => {
    const items = [40, 5, 20, 1, 10];
    let active = 0;
    let maxActive = 0;

    const results = await mapWithConcurrency(items, 2, async (ms, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(ms);
      active -= 1;
      return index * 10;
    });

    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(maxActive).toBe(2);

    // Limit larger than the input still returns every element in order.
    const wide = await mapWithConcurrency([1, 2, 3], 16, async (value) => value * 2);
    expect(wide).toEqual([2, 4, 6]);
  });
});

// ---------------------------------------------------------------------------
// hostToSshConnectConfig
// ---------------------------------------------------------------------------

describe('hostToSshConnectConfig', () => {
  it('maps password auth and the connect timeout', () => {
    const host = makeHost({
      host: 'example.test',
      port: 2222,
      username: 'alice',
      auth: { type: 'password', password: 's3cr3t' },
    });

    const cfg = hostToSshConnectConfig(host, 7, 'tofu');

    expect(cfg).toMatchObject({
      host: 'example.test',
      port: 2222,
      username: 'alice',
      password: 's3cr3t',
      connectTimeoutSec: 7,
      hostKeyPolicy: 'tofu',
    });
  });

  it('maps inline key data with its passphrase', () => {
    const host = makeHost({
      auth: { type: 'key', key_data: '-----BEGIN KEY-----', passphrase: 'pp' },
    });

    const cfg = hostToSshConnectConfig(host, 3, 'strict');

    expect(cfg.privateKey).toBe('-----BEGIN KEY-----');
    expect(cfg.keyPassphrase).toBe('pp');
    expect(cfg.privateKeyPath).toBeUndefined();
    expect(cfg.hostKeyPolicy).toBe('strict');
  });

  it('maps a key path with its passphrase', () => {
    const host = makeHost({ auth: { type: 'key', key_path: '/home/ops/.ssh/id_ed25519' } });

    const cfg = hostToSshConnectConfig(host, 3, 'insecure');

    expect(cfg.privateKeyPath).toBe('/home/ops/.ssh/id_ed25519');
    expect(cfg.hostKeyPolicy).toBe('insecure');
  });

  it('rejects a key auth entry with neither key_data nor key_path', () => {
    const host = makeHost({ auth: { type: 'key' } });

    expect(() => hostToSshConnectConfig(host, 3, 'tofu')).toThrow('SSH key is not configured');
  });

  it('falls back to the tofu policy for an unknown policy value', () => {
    const host = makeHost();

    expect(hostToSshConnectConfig(host, 1, 'weird').hostKeyPolicy).toBe('tofu');
    expect(hostToSshConnectConfig(host, 1, undefined).hostKeyPolicy).toBe('tofu');
  });
});

// ---------------------------------------------------------------------------
// P1-1: per-stage timings and bounded retries
// ---------------------------------------------------------------------------

/** A manually advanced clock so tests can pin the elapsed time per stage. */
class ManualClock {
  private current = 0;

  readonly now = (): number => this.current;

  advance(ms: number): void {
    this.current += ms;
  }
}

describe('collectHostReport — stage timings (P1-1)', () => {
  it('records one ok timing per stage in command-map order', async () => {
    const clock = new ManualClock();
    const report = await collectHostReport(
      makeHost(),
      makeRunner((command) => {
        clock.advance(5);
        return command === 'hostname' ? ok('web-1') : ok('');
      }),
      {
        connectTimeout: 5,
        commandTimeout: 10,
        buildCommandMap: () => onlyStages({ hostname: 'hostname', kernel: 'uname -r' }),
        now: clock.now,
      },
    );

    expect(report.stageTimings).toEqual([
      { stage: 'hostname', ms: 5, ok: true },
      { stage: 'kernel', ms: 5, ok: true },
    ]);
  });

  it('retries a failed stage once by default and sums both attempts into ms', async () => {
    const clock = new ManualClock();
    let kernelCalls = 0;
    const report = await collectHostReport(
      makeHost(),
      makeRunner((command) => {
        clock.advance(5);
        if (command === 'uname -r') {
          kernelCalls += 1;
          return bad(2, 'kernel boom');
        }
        return ok('');
      }),
      {
        connectTimeout: 5,
        commandTimeout: 10,
        buildCommandMap: () => onlyStages({ kernel: 'uname -r' }),
        now: clock.now,
      },
    );

    expect(kernelCalls).toBe(2);
    expect(report.errors).toEqual([{ stage: 'kernel', message: 'kernel boom' }]);
    expect(report.stageTimings).toEqual([
      { stage: 'kernel', ms: 10, ok: false, error: 'kernel boom' },
    ]);
  });

  it('treats a retry that succeeds as ok without an error entry', async () => {
    const clock = new ManualClock();
    let calls = 0;
    const report = await collectHostReport(
      makeHost(),
      makeRunner((command) => {
        clock.advance(5);
        if (command === 'uptime -p') {
          calls += 1;
          return calls === 1 ? bad(1, 'transient') : ok('up 1 day');
        }
        return ok('');
      }),
      {
        connectTimeout: 5,
        commandTimeout: 10,
        buildCommandMap: () => onlyStages({ uptime: 'uptime -p' }),
        now: clock.now,
      },
    );

    expect(calls).toBe(2);
    expect(report.errors).toEqual([]);
    expect(report.stageTimings).toEqual([{ stage: 'uptime', ms: 10, ok: true }]);
  });

  it('does not retry when stageRetries is 0', async () => {
    let calls = 0;
    const report = await collectHostReport(
      makeHost(),
      makeRunner(() => {
        calls += 1;
        return bad(2, 'nope');
      }),
      {
        connectTimeout: 5,
        commandTimeout: 10,
        buildCommandMap: () => onlyStages({ kernel: 'uname -r' }),
        stageRetries: 0,
      },
    );

    expect(calls).toBe(1);
    expect(report.errors).toEqual([{ stage: 'kernel', message: 'nope' }]);
    expect(report.stageTimings).toHaveLength(1);
    expect(report.stageTimings?.[0]).toMatchObject({ stage: 'kernel', ok: false, error: 'nope' });
  });

  it('records an ssh exception as a failed timing and still aborts immediately', async () => {
    const clock = new ManualClock();
    const runner = makeRunner((command) => {
      clock.advance(5);
      if (command === 'uname -r') {
        throw new Error('connect refused');
      }
      return ok('');
    });

    const report = await collectHostReport(makeHost(), runner, {
      connectTimeout: 5,
      commandTimeout: 10,
      buildCommandMap: () => onlyStages({ hostname: 'hostname', kernel: 'uname -r' }),
      now: clock.now,
    });

    expect(runner.calls).toHaveLength(2);
    expect(report.success).toBe(false);
    expect(report.errors).toEqual([{ stage: 'ssh', message: 'connect refused' }]);
    expect(report.stageTimings).toEqual([
      { stage: 'hostname', ms: 5, ok: true },
      { stage: 'ssh', ms: 5, ok: false, error: 'connect refused' },
    ]);
  });
});

describe('collectAllHosts — stage_retries resolution (P1-1)', () => {
  it('honours monitoring.stage_retries from the collector config', async () => {
    const config = makeConfig([makeHost()]);
    config.monitoring = { stage_retries: 0 };
    let kernelCalls = 0;

    const reports = await collectAllHosts(config, {
      buildRunner: () =>
        makeRunner((command) => {
          if (command === 'uname -r') {
            kernelCalls += 1;
            return bad(3, 'boom');
          }
          return ok('');
        }),
      buildCommandMap: () => onlyStages({ hostname: 'hostname', kernel: 'uname -r' }),
    });

    expect(kernelCalls).toBe(1);
    expect(reports[0].errors).toEqual([{ stage: 'kernel', message: 'boom' }]);
    expect(reports[0].stageTimings).toEqual([
      { stage: 'hostname', ms: expect.any(Number), ok: true },
      { stage: 'kernel', ms: expect.any(Number), ok: false, error: 'boom' },
    ]);
  });

  it('lets CollectAllOptions.stageRetries override the config value', async () => {
    const config = makeConfig([makeHost()]);
    config.monitoring = { stage_retries: 0 };
    let kernelCalls = 0;

    const reports = await collectAllHosts(config, {
      stageRetries: 1,
      buildRunner: () =>
        makeRunner((command) => {
          if (command === 'uname -r') {
            kernelCalls += 1;
            return bad(3, 'boom');
          }
          return ok('');
        }),
      buildCommandMap: () => onlyStages({ kernel: 'uname -r' }),
    });

    expect(kernelCalls).toBe(2);
    expect(reports[0].errors).toEqual([{ stage: 'kernel', message: 'boom' }]);
  });
});
