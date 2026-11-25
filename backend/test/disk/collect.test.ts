/**
 * Tests for `backend/src/disk/collect.ts` — the 1:1 TypeScript port of
 * `collect_disk_health` (`servermanage/disk_health.py:791`, P5 Task 5).
 *
 * A `FakeRunner` records every command (and whether it travelled the sudo path)
 * and answers from a per-command response table built from the real storcli
 * fixtures, so the tests pin **both**:
 *
 * - the exact command sequence (`probe → /cALL show J → per controller
 *   /c{cid}/vall show J then /c{cid}/eall/sall show all J`), and
 * - the resulting `DiskHealthReport` for every status branch
 *   (`ok` / `degraded` / `permission_denied` / `no_controller` / `no_storcli`),
 *   plus the sudo handling (`runSudo` vs the `sudo -n` fallback) and the
 *   previous-batch `error_increase` evaluation.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DISK_COMMAND_TIMEOUT_MS,
  DEFAULT_DISK_TEMPERATURE_THRESHOLD_C,
  DEFAULT_STORCLI_CANDIDATES,
  collectDiskHealth,
} from '../../src/disk/collect';
import type { DiskHealthHost, DiskHealthRunner } from '../../src/disk/collect';
import type { DiskHealthReport } from '../../src/disk/report';
import { SudoAuthError } from '../../src/collect/ssh-client';
import type { CommandResult } from '../../src/collect/types';

import { findRepoRoot } from '../diff/harness';

const repoRoot = findRepoRoot();
const FIXTURE_DIR = path.join(repoRoot, 'backend', 'test', 'disk', 'fixtures');

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

// --- Fake runner ----------------------------------------------------------

interface Call {
  command: string;
  sudo: boolean;
}

type Handler = (command: string, sudo: boolean) => CommandResult | Promise<CommandResult>;

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitStatus: 0 };
}

function fail(exitStatus: number, stderr: string, stdout = ''): CommandResult {
  return { stdout, stderr, exitStatus };
}

interface FakeRunnerOptions {
  /** When false the fake does not expose `runSudo` (legacy `sudo -n` path). */
  withSudo?: boolean;
}

function fakeRunner(handler: Handler, options: FakeRunnerOptions = {}): {
  runner: DiskHealthRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: DiskHealthRunner = {
    async run(command: string) {
      calls.push({ command, sudo: false });
      return handler(command, false);
    },
  };
  if (options.withSudo !== false) {
    runner.runSudo = async (command: string) => {
      calls.push({ command, sudo: true });
      return handler(command, true);
    };
  }
  return { runner, calls };
}

/** Handler that answers from a fixed command→result table (throws on a miss). */
function tableRunner(table: Record<string, CommandResult>, options: FakeRunnerOptions = {}) {
  return fakeRunner((command) => {
    const result = table[command];
    if (!result) {
      throw new Error(`unexpected command: ${command}`);
    }
    return result;
  }, options);
}

const HOST: DiskHealthHost = { name: 'gpu-test-01' };

const HAPPY_TABLE: Record<string, CommandResult> = {
  'storcli -v': ok('StorCLI version 007.1017.0000.0000'),
  'storcli /cALL show J': ok(fixture('controllers_4090_multi.json')),
  'storcli /c0/vall show J': ok(fixture('virtual_a100_c0.json')),
  'storcli /c1/vall show J': ok(fixture('virtual_none.json')),
  'storcli /c0/eall/sall show all J': ok(fixture('physical_4090_c0.json')),
  'storcli /c1/eall/sall show all J': ok(fixture('physical_4090_c1.json')),
};

const HAPPY_SEQUENCE = [
  'storcli -v',
  'storcli /cALL show J',
  'storcli /c0/vall show J',
  'storcli /c0/eall/sall show all J',
  'storcli /c1/vall show J',
  'storcli /c1/eall/sall show all J',
];

const BASE_CONFIG = {
  storcli_candidates: ['storcli'],
  use_sudo: true,
} as const;

// --- Tests ----------------------------------------------------------------

describe('disk/collect: constants', () => {
  it('exposes the Python defaults', () => {
    expect(DEFAULT_STORCLI_CANDIDATES).toEqual([
      'storcli',
      'storcli64',
      '/opt/MegaRAID/storcli/storcli64',
      '/opt/lsi/storcli/storcli64',
      '/usr/local/bin/storcli',
      '/usr/sbin/storcli',
    ]);
    expect(DEFAULT_DISK_COMMAND_TIMEOUT_MS).toBe(20000);
    expect(DEFAULT_DISK_TEMPERATURE_THRESHOLD_C).toBe(55);
  });
});

describe('disk/collect: happy path', () => {
  it('runs the exact command sequence and assembles a complete report', async () => {
    const { runner, calls } = tableRunner(HAPPY_TABLE);
    const report = await collectDiskHealth(HOST, runner, {
      config: BASE_CONFIG,
      now: new Date('2026-04-18T09:30:00.000Z'),
    });

    expect(calls.map((call) => call.command)).toEqual(HAPPY_SEQUENCE);
    expect(calls.every((call) => call.sudo)).toBe(true);

    expect(report.host_name).toBe('gpu-test-01');
    expect(report.collected_at).toBe('2026-04-18T09:30:00.000000+00:00');
    expect(report.status).toBe('ok');
    expect(report.message).toBeNull();
    expect(report.controllers).toHaveLength(2);
    expect(report.virtual_drives).toHaveLength(2);
    expect(report.physical_drives).toHaveLength(8);
    expect(new Set(report.physical_drives.map((drive) => drive.controller))).toEqual(new Set([0, 1]));
    // Virtual drives are evaluated (healthy state Optl) and labelled with cid.
    expect(report.virtual_drives.every((vd) => vd.controller === 0)).toBe(true);
    expect(report.virtual_drives[0].health).toBe('healthy');
    // Camel→snake conversion at the boundary: presence of every physical field.
    expect(Object.keys(report.physical_drives[0]).sort()).toEqual(
      [
        'controller',
        'enclosure',
        'slot',
        'did',
        'model',
        'serial',
        'state',
        'media_errors',
        'other_errors',
        'predictive_failures',
        'smart_alert',
        'temperature_c',
        'shield_counter',
        'health',
        'reasons',
      ].sort(),
    );
  });
});

describe('disk/collect: permission and availability branches', () => {
  it('maps SudoAuthError during the probe to permission_denied', async () => {
    const sudoError = new SudoAuthError('sudo password is required');
    const throwing = fakeRunner(() => {
      throw sudoError;
    });
    const report = await collectDiskHealth(HOST, throwing.runner, { config: BASE_CONFIG });
    expect(report.status).toBe('permission_denied');
    expect(report.message).toContain('请在主机编辑中配置 sudo 密码或免密 sudo 后重试');
    expect(throwing.calls).toHaveLength(1);
    expect(throwing.calls[0].command).toBe('storcli -v');
  });

  it('treats "No Controller found" with sudo as no_controller', async () => {
    const { runner, calls } = tableRunner({
      'storcli -v': ok('StorCLI 7.1017'),
      'storcli /cALL show J': ok('No Controller found'),
    });
    const report = await collectDiskHealth(HOST, runner, { config: BASE_CONFIG });
    expect(report.status).toBe('no_controller');
    expect(report.message).toBe('storcli 未发现任何控制器');
    expect(calls.map((call) => call.command)).toEqual(['storcli -v', 'storcli /cALL show J']);
  });

  it('treats empty output from a non-sudo run as permission_denied', async () => {
    const { runner, calls } = tableRunner(
      {
        'storcli -v': ok('StorCLI 7.1017'),
        'storcli /cALL show J': ok('   '),
      },
      { withSudo: false },
    );
    const report = await collectDiskHealth(HOST, runner, {
      config: { storcli_candidates: ['storcli'], use_sudo: false },
    });
    expect(report.status).toBe('permission_denied');
    expect(report.message).toContain('非 root');
    expect(calls.every((call) => call.sudo)).toBe(false);
  });

  it('reports no_storcli when every candidate probe fails', async () => {
    const { runner, calls } = tableRunner({
      'storcli -v': fail(127, 'storcli: command not found'),
      'storcli64 -v': fail(127, 'storcli64: command not found'),
    });
    const report = await collectDiskHealth(HOST, runner, {
      config: { storcli_candidates: ['storcli', 'storcli64'], use_sudo: true },
    });
    expect(report.status).toBe('no_storcli');
    expect(report.message).toContain('未找到可用的 storcli 可执行文件');
    expect(calls.map((call) => call.command)).toEqual(['storcli -v', 'storcli64 -v']);
  });

  it('reports permission_denied when probe failures mention a permission problem', async () => {
    const { runner } = tableRunner({
      'storcli -v': fail(1, 'sudo: a password is required'),
    });
    const report = await collectDiskHealth(HOST, runner, { config: BASE_CONFIG });
    expect(report.status).toBe('permission_denied');
    expect(report.message).toContain('sudo 权限不足');
  });
});

describe('disk/collect: degraded / partial collection', () => {
  it('keeps the collected drives and reports degraded when one controller fails', async () => {
    const { runner, calls } = tableRunner({
      'storcli -v': ok('StorCLI 7.1017'),
      'storcli /cALL show J': ok(fixture('controllers_4090_multi.json')),
      'storcli /c0/vall show J': ok(fixture('virtual_none.json')),
      'storcli /c0/eall/sall show all J': ok(fixture('physical_4090_c0.json')),
      'storcli /c1/vall show J': ok(fixture('virtual_none.json')),
      'storcli /c1/eall/sall show all J': fail(1, 'storcli: controller 1 offline'),
    });
    const report = await collectDiskHealth(HOST, runner, { config: BASE_CONFIG });
    expect(report.status).toBe('degraded');
    expect(report.message).toContain('控制器 1 物理盘查询失败');
    expect(report.physical_drives).toHaveLength(6);
    expect(report.virtual_drives).toHaveLength(0);
    expect(calls.map((call) => call.command)).toEqual(HAPPY_SEQUENCE);
  });

  it('reports error when every query warns and nothing usable comes back', async () => {
    const { runner } = tableRunner({
      'storcli -v': ok('StorCLI 7.1017'),
      'storcli /cALL show J': ok(fixture('controllers_4090_multi.json')),
      'storcli /c0/vall show J': fail(1, 'vd query failed'),
      'storcli /c0/eall/sall show all J': fail(1, 'pd query failed'),
      'storcli /c1/vall show J': fail(1, 'vd query failed'),
      'storcli /c1/eall/sall show all J': fail(1, 'pd query failed'),
    });
    const report = await collectDiskHealth(HOST, runner, { config: BASE_CONFIG });
    expect(report.status).toBe('error');
    expect(report.physical_drives).toHaveLength(0);
    expect(report.virtual_drives).toHaveLength(0);
    expect(report.message).toContain('控制器 0 虚拟盘查询失败');
  });
});

describe('disk/collect: runner / sudo wiring', () => {
  it('falls back to `sudo -n <cmd>` through run() when runSudo is absent', async () => {
    const table: Record<string, CommandResult> = {};
    for (const command of HAPPY_SEQUENCE) {
      table[`sudo -n ${command}`] = HAPPY_TABLE[command];
    }
    const { runner, calls } = tableRunner(table, { withSudo: false });
    const report = await collectDiskHealth(HOST, runner, { config: BASE_CONFIG });
    expect(report.status).toBe('ok');
    expect(report.physical_drives).toHaveLength(8);
    expect(calls[0].command).toBe('sudo -n storcli -v');
    expect(calls.every((call) => call.sudo === false)).toBe(true);
  });

  it('honours the per-host override (storcli_path + use_sudo=false)', async () => {
    const customTable: Record<string, CommandResult> = {
      '/opt/custom/storcli -v': ok('StorCLI 7.1017'),
      '/opt/custom/storcli /cALL show J': ok(fixture('controllers_4090_multi.json')),
      '/opt/custom/storcli /c0/vall show J': ok(fixture('virtual_none.json')),
      '/opt/custom/storcli /c0/eall/sall show all J': ok(fixture('physical_4090_c0.json')),
      '/opt/custom/storcli /c1/vall show J': ok(fixture('virtual_none.json')),
      '/opt/custom/storcli /c1/eall/sall show all J': ok(fixture('physical_4090_c1.json')),
    };
    const { runner, calls } = tableRunner(customTable, { withSudo: false });
    const report = await collectDiskHealth(
      { name: 'gpu-test-02', disk_health: { storcli_path: '/opt/custom/storcli', use_sudo: false } },
      runner,
      { config: BASE_CONFIG },
    );
    expect(report.status).toBe('ok');
    expect(calls.every((call) => call.sudo === false)).toBe(true);
    expect(calls[0].command).toBe('/opt/custom/storcli -v');
  });

  it('builds a runner from runnerFactory when none is passed', async () => {
    const factory = fakeRunner((command) => HAPPY_TABLE[command] as CommandResult);
    const report = await collectDiskHealth(HOST, undefined, {
      config: BASE_CONFIG,
      runnerFactory: (host) => {
        expect(host.name).toBe('gpu-test-01');
        return factory.runner;
      },
    });
    expect(report.status).toBe('ok');
    expect(factory.calls).toHaveLength(HAPPY_SEQUENCE.length);
  });

  it('throws only when no runner and no factory are provided', async () => {
    await expect(collectDiskHealth(HOST, undefined, { config: BASE_CONFIG })).rejects.toThrow(
      /requires a runner or a runnerFactory/,
    );
  });
});

describe('disk/collect: previous-batch error_increase', () => {
  it('flags a drive whose media errors increased since the previous batch', async () => {
    // Single-controller payload so the table only needs `/c0/...` commands (the
    // previous-batch logic is orthogonal to how many controllers exist).
    const payload = JSON.parse(fixture('controllers_4090_multi.json')) as {
      Controllers: Array<Record<string, unknown>>;
    };
    payload.Controllers = [payload.Controllers[0]];
    const table: Record<string, CommandResult> = {
      'storcli -v': ok('StorCLI 7.1017'),
      'storcli /cALL show J': ok(JSON.stringify(payload)),
      'storcli /c0/vall show J': ok(fixture('virtual_none.json')),
      'storcli /c0/eall/sall show all J': ok(fixture('physical_text_abnormal.txt')),
    };
    const config = { storcli_candidates: ['storcli'], use_sudo: false };

    const first = await collectDiskHealth(HOST, tableRunner(table, { withSudo: false }).runner, {
      config,
    });
    expect(first.status).toBe('ok');
    expect(first.physical_drives).toHaveLength(2);
    // Sanity: the abnormal fixture has media errors on the first drive.
    expect(first.physical_drives[0].media_errors).toBe(2);

    const previous: DiskHealthReport = {
      ...first,
      physical_drives: first.physical_drives.map((drive) => ({
        ...drive,
        media_errors: drive.media_errors === null ? 0 : Math.max(0, drive.media_errors - 1),
        other_errors: drive.other_errors === null ? 0 : Math.max(0, drive.other_errors - 1),
      })),
    };

    const second = await collectDiskHealth(HOST, tableRunner(table, { withSudo: false }).runner, {
      config,
      previous,
    });
    const increasedDrive = second.physical_drives.find((drive) =>
      drive.reasons.includes('error_increase'),
    );
    expect(increasedDrive).toBeDefined();
    expect(increasedDrive?.health).toBe('warning');
  });
});
