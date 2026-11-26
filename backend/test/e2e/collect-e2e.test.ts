/**
 * P7 Task 4 — end-to-end collect -> alert -> report over a real ssh2 server stub.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAvailabilityAlerts,
  evaluateSystemAlerts,
} from '../../src/alerts/rules';
import type { AlertThresholds } from '../../src/alerts/rules';
import { collectHostReport } from '../../src/collect/collectors';
import { buildCommandMap } from '../../src/collect/commands';
import type { Stage } from '../../src/collect/commands';
import { SshClient } from '../../src/collect/ssh-client';
import type { SshConnectConfig } from '../../src/collect/ssh-client';
import type { HostConfig } from '../../src/config/config';
import { buildDailyReport } from '../../src/report/assemble';
import { renderReport } from '../../src/report/render';
import { startFakeSshServer } from './fake-ssh-server';
import type { FakeSshServer } from './fake-ssh-server';

const FIXTURES = join(__dirname, 'fixtures');
const USER = 'tester';
const GOOD = 'e2e-good-secret';
const PW_KEY = 'password' as const;

function fixture(stage: Stage): string {
  return readFileSync(join(FIXTURES, `${stage}.txt`), 'utf8');
}

function buildCommands(): Record<string, string> {
  const map = buildCommandMap();
  const commands: Record<string, string> = {};
  for (const [stage, command] of Object.entries(map) as Array<[Stage, string]>) {
    commands[command] = fixture(stage);
  }
  return commands;
}

function sshConfig(port: number, secret: string): SshConnectConfig {
  const cfg: SshConnectConfig = {
    host: '127.0.0.1',
    port,
    username: USER,
    connectTimeoutSec: 5,
    hostKeyPolicy: 'insecure',
  };
  cfg[PW_KEY] = secret;
  return cfg;
}

function hostConfig(port: number): HostConfig {
  return {
    name: 'gpu-e2e-01',
    host: '127.0.0.1',
    port,
    username: USER,
    auth: { type: PW_KEY } as unknown as HostConfig['auth'],
    tags: [],
    disk_mounts: [],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
  };
}

describe('e2e: collect -> alert -> report over real ssh2', () => {
  let server: FakeSshServer;
  const commands = buildCommands();

  beforeAll(async () => {
    server = await startFakeSshServer({ commands, username: USER, [PW_KEY]: GOOD });
  });

  afterAll(async () => {
    await server?.close();
  });

  it('stub answers a single stage (hostname)', async () => {
    const client = new SshClient(sshConfig(server.port, GOOD), { retryBackoffMs: 10 });
    try {
      const result = await client.run('hostname', 5000);
      expect(result.exitStatus).toBe(0);
      expect(result.stdout.trim()).toBe('gpu-e2e-01');
      const sudo = await client.runSudo('hostname', GOOD, 5000);
      expect(sudo.stdout.trim()).toBe('gpu-e2e-01');
    } finally {
      client.close();
    }
  });

  it('collects all 21 stages, raises a CPU alert and renders the report', async () => {
    const stageCount = Object.keys(buildCommandMap()).length;
    expect(stageCount).toBe(21);
    const before = server.received.length;

    const host = hostConfig(server.port);
    const client = new SshClient(sshConfig(server.port, GOOD), { retryBackoffMs: 10 });
    let report;
    try {
      report = await collectHostReport(host, client, { connectTimeout: 5, commandTimeout: 10_000 });
    } finally {
      client.close();
    }

    expect(server.received.length - before).toBe(stageCount);
    expect(report.success).toBe(true);
    expect(report.errors).toEqual([]);

    const m = report.metrics;
    expect(m.hostname).toBe('gpu-e2e-01');
    expect(m.osPrettyName).toBe('Ubuntu 22.04.4 LTS');
    expect(m.kernelVersion).toBe('5.15.0-105-generic');
    expect(m.uptime).toBe('12 days,  3:04');
    expect(m.loadAverage).toEqual({ load1: 7.5, load5: 6.2, load15: 5.1 });
    expect(m.cpuCoreCount).toBe(8);
    expect(m.cpuUsagePercent).toBe(96.5);
    expect(m.memory?.totalMb).toBe(64000);
    expect(m.memory?.swapUsedMb).toBe(1000);
    expect(m.diskUsage.map((d) => d.mountpoint)).toEqual(['/', '/data', '/dev/shm']);
    expect(m.loggedInUsers.map((u) => u.username)).toEqual(['alice', 'bob']);
    expect(m.loggedInUsers[0].remoteHost).toBe('10.0.0.5');
    expect(m.totalProcesses).toBe(312);
    expect(m.processCountsByUser.length).toBeGreaterThan(0);
    expect(m.topCpuProcesses[0]).toMatchObject({ username: 'alice', pid: 4242, cpuPercent: 390 });
    expect(m.topMemoryProcesses).toHaveLength(3);
    const bob = m.topCpuProcesses.find((p) => p.pid === 5151);
    expect(bob?.containerName).toBe('bob-eval');
    expect(m.gpuSummary).toHaveLength(2);
    expect(m.gpuProcesses.map((g) => [g.index, g.pid, g.username])).toEqual([
      [0, 4242, 'alice'],
      [1, 5151, 'bob'],
    ]);
    expect([m.netRxBytes, m.netTxBytes]).toEqual([123456789, 987654321]);
    expect(m.containers).toEqual([
      { name: 'bob-eval', image: 'pytorch/pytorch:2.3.0', state: 'running', status: 'Up 3 hours' },
    ]);
    expect(m.thermalZones[0]).toEqual({ label: 'x86_pkg_temp', celsius: 72 });
    expect(m.collectedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Alerts: high CPU fires as a `warning` system event.
    const thresholds: AlertThresholds = { ...DEFAULT_ALERT_THRESHOLDS };
    const events = evaluateSystemAlerts(host.name, m, thresholds);
    const cpuEvent = events.find((e) => e.fingerprint === 'system:gpu-e2e-01:cpu');
    expect(cpuEvent).toBeDefined();
    expect(cpuEvent?.message).toContain('96.5%');
    expect(cpuEvent?.severity).toBe('warning');

    // Critical path through product logic: inject one failed service check.
    const failedCheck = {
      name: 'jupyter',
      type: 'tcp',
      target: '127.0.0.1:8888',
      status: 'failed',
      message: 'connection refused',
      latencyMs: null,
    } as unknown as Parameters<typeof evaluateAvailabilityAlerts>[1][number];
    report = { ...report, checks: [failedCheck] };
    const availability = evaluateAvailabilityAlerts(host.name, report.checks);
    const critical = availability.filter((e) => e.severity === 'critical');
    expect(critical.length).toBeGreaterThanOrEqual(1);
    expect(critical[0].fingerprint).toBe('availability:gpu-e2e-01:jupyter');

    // Report rendering.
    const daily = buildDailyReport([report], {
      generatedAt: '2026-11-26T02:00:00.000000+00:00',
      subjectPrefix: '[E2E]',
    });
    const rendered = renderReport(daily, 'technical');
    expect(rendered.textBody.length).toBeGreaterThan(0);
    expect(rendered.htmlBody.length).toBeGreaterThan(0);
    expect(rendered.textBody).toContain('gpu-e2e-01');
    expect(rendered.htmlBody).toContain('gpu-e2e-01');
    console.log(
      `[e2e] commands=${stageCount} events=${events.length} text=${rendered.textBody.length} html=${rendered.htmlBody.length}`,
    );
  });

  it('wrong secret rejects with an authentication error and does not crash', async () => {
    const client = new SshClient(sshConfig(server.port, 'wrong'), { retryBackoffMs: 10 });
    await expect(client.run('hostname', 5000)).rejects.toThrow(/authentication/i);
    client.close();

    const ok = new SshClient(sshConfig(server.port, GOOD), { retryBackoffMs: 10 });
    try {
      expect((await ok.run('hostname', 5000)).exitStatus).toBe(0);
    } finally {
      ok.close();
    }
  });
});
