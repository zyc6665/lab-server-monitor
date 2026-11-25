import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TIMEOUT,
  AUTH_MESSAGE,
  TIMEOUT_MESSAGE,
  REFUSED_MESSAGE,
  HOST_KEY_MESSAGE,
  SUDO_WARNING,
  STORCLI_WARNING,
  defaultRunnerFactory,
  detectStorcli,
  mapProbeError,
  parseDf,
  parseInteger,
  parseMemoryTotal,
  parseOsRelease,
  probeHost,
  runProbe,
} from '../../src/collect/host-probe';
import type {
  ProbeCandidate,
  ProbeRunner,
  ProbeRunnerFactory,
} from '../../src/collect/host-probe';
import { HostKeyMismatch, SudoAuthError, SudoUnavailable } from '../../src/collect/ssh-client';
import type { CommandResult } from '../../src/collect/types';

// ---------------------------------------------------------------------------
// Fake runner — injects canned CommandResults. Mirrors the Python FakeRunner:
// behaviour is a map from command -> CommandResult (or a thrown value).
// ---------------------------------------------------------------------------

type Outcome = CommandResult | Error | (() => never);

function ok(stdout: string): CommandResult {
  return { stdout, stderr: '', exitStatus: 0 };
}

function fail(exitStatus = 1, stdout = '', stderr = ''): CommandResult {
  return { stdout, stderr, exitStatus };
}

class FakeRunner implements ProbeRunner {
  readonly runs: Array<{ command: string; timeoutMs: number }> = [];
  readonly sudoRuns: Array<{ command: string; timeoutMs: number }> = [];
  closed = false;
  readonly closeSpy = vi.fn();

  constructor(
    private readonly handler: (command: string) => Outcome,
    private readonly sudoHandler?: (command: string) => Outcome,
    private readonly options: { hasRunSudo?: boolean } = {},
  ) {}

  async run(command: string, timeoutMs: number): Promise<CommandResult> {
    this.runs.push({ command, timeoutMs });
    const outcome = this.handler(command);
    if (typeof outcome === 'function') {
      outcome();
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as CommandResult;
  }

  async runSudo(command: string, timeoutMs: number): Promise<CommandResult> {
    this.sudoRuns.push({ command, timeoutMs });
    const handler = this.sudoHandler;
    if (!handler) {
      throw new SudoUnavailable('sudo not available');
    }
    const outcome = handler(command);
    if (typeof outcome === 'function') {
      outcome();
    }
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as CommandResult;
  }

  close(): void {
    this.closed = true;
    this.closeSpy();
  }
}

// A runner that only implements run/close (no runSudo) — used to exercise the
// `sudo -n {path} -v` fallback.
class RunOnlyRunner implements ProbeRunner {
  readonly runs: Array<{ command: string; timeoutMs: number }> = [];
  closed = false;
  constructor(private readonly handler: (command: string) => Outcome) {}
  async run(command: string, timeoutMs: number): Promise<CommandResult> {
    this.runs.push({ command, timeoutMs });
    const outcome = this.handler(command);
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as CommandResult;
  }
  close(): void {
    this.closed = true;
  }
}

const HAPPY_OUTPUT: Record<string, Outcome> = {
  hostname: ok('gpu-01\n'),
  'cat /etc/os-release': ok('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.3 LTS"\nVERSION_ID="22.04"\n'),
  'uname -r': ok('5.15.0-91-generic\n'),
  nproc: ok('64\n'),
  'free -m': ok('              total        used        free      shared  buff/cache   available\nMem:         257000       12345      100000         512       144655      240000\nSwap:          8191           0        8191\n'),
  'df -hP': ok('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       200G   50G  140G  25% /\n/dev/sdb1       1.0T  200G  800G  20% /data\n'),
  'command -v storcli': ok('/usr/bin/storcli\n'),
  '/usr/bin/storcli -v': ok('storcli version 007.1015\n'),
  'sudo -n /usr/bin/storcli -v': ok('storcli version 007.1015\n'),
};

function happyHandler(command: string): Outcome {
  const mapped = HAPPY_OUTPUT[command];
  if (mapped !== undefined) {
    return mapped;
  }
  return fail(127, '', `command not found: ${command}`);
}

function candidate(overrides: Partial<ProbeCandidate> = {}): ProbeCandidate {
  return {
    host: '10.0.0.5',
    port: 22,
    username: 'root',
    password: 'topsecret-not-echoed',
    ...overrides,
  };
}

function factoryOf(runner: ProbeRunner): ProbeRunnerFactory {
  return () => runner;
}

const AUTH_ERROR_NAMES = [
  'AuthenticationException',
  'SudoAuthError',
];
void AUTH_ERROR_NAMES;

describe('parseOsRelease', () => {
  it('reads PRETTY_NAME and strips surrounding quotes', () => {
    expect(parseOsRelease('PRETTY_NAME="Ubuntu 22.04.3 LTS"\n')).toBe('Ubuntu 22.04.3 LTS');
    expect(parseOsRelease("PRETTY_NAME='Debian GNU/Linux 12'\n")).toBe('Debian GNU/Linux 12');
    expect(parseOsRelease('PRETTY_NAME=Alpine Linux\n')).toBe('Alpine Linux');
  });

  it('returns null when PRETTY_NAME is absent or blank', () => {
    expect(parseOsRelease('NAME="Ubuntu"\nVERSION_ID="22.04"\n')).toBeNull();
    expect(parseOsRelease('PRETTY_NAME=""\n')).toBeNull();
    expect(parseOsRelease('')).toBeNull();
  });
});

describe('parseInteger', () => {
  it('parses plain integers', () => {
    expect(parseInteger('64')).toBe(64);
    expect(parseInteger('  257000 \n')).toBe(257000);
  });

  it('falls back to the first digit run', () => {
    expect(parseInteger('64 cores')).toBe(64);
    expect(parseInteger('cpu count: 12')).toBe(12);
  });

  it('returns null for missing or non-numeric text', () => {
    expect(parseInteger(null)).toBeNull();
    expect(parseInteger(undefined)).toBeNull();
    expect(parseInteger('')).toBeNull();
    expect(parseInteger('no digits here')).toBeNull();
  });
});

describe('parseMemoryTotal', () => {
  it('reads the Mem: total column (second field)', () => {
    const text =
      '              total        used        free      shared  buff/cache   available\n' +
      'Mem:         257000       12345      100000         512       144655      240000\n' +
      'Swap:          8191           0        8191\n';
    expect(parseMemoryTotal(text)).toBe(257000);
  });

  it('returns null when there is no Mem: row', () => {
    expect(parseMemoryTotal('garbage\n')).toBeNull();
    expect(parseMemoryTotal('')).toBeNull();
  });

  it('returns null when the total is not an integer', () => {
    expect(parseMemoryTotal('Mem:   NaN  0  0\n')).toBeNull();
  });
});

describe('parseDf', () => {
  it('skips the header and parses columns with an integer percent', () => {
    const text =
      'Filesystem      Size  Used Avail Use% Mounted on\n' +
      '/dev/sda1       200G   50G  140G  25% /\n' +
      '/dev/sdb1       1.0T  200G  800G  20% /data\n';
    expect(parseDf(text)).toEqual([
      { fs: '/dev/sda1', total: '200G', used: '50G', available: '140G', percent: 25, mountpoint: '/' },
      { fs: '/dev/sdb1', total: '1.0T', used: '200G', available: '800G', percent: 20, mountpoint: '/data' },
    ]);
  });

  it('joins the remaining tokens into a mountpoint containing spaces', () => {
    const text = 'Filesystem Size Used Avail Use% Mounted on\n/dev/sdc1 10G 1G 9G 10% /mnt/my disk\n';
    expect(parseDf(text)[0]?.mountpoint).toBe('/mnt/my disk');
  });

  it('skips rows with fewer than six fields or a non-percent Use%', () => {
    const text =
      'Filesystem      Size  Used Avail Use% Mounted on\n' +
      'short row\n' +
      '/dev/sda1 200G 50G 140G nope /\n' +
      '/dev/sdb1 1.0T 200G 800G 20% /data\n';
    expect(parseDf(text)).toEqual([
      { fs: '/dev/sdb1', total: '1.0T', used: '200G', available: '800G', percent: 20, mountpoint: '/data' },
    ]);
  });

  it('returns an empty array for blank input', () => {
    expect(parseDf('')).toEqual([]);
  });
});

describe('detectStorcli', () => {
  it('returns the path reported by `command -v storcli` first', async () => {
    const runner = new FakeRunner((command) =>
      command === 'command -v storcli' ? ok('/usr/bin/storcli\n') : fail(127),
    );
    await expect(detectStorcli(runner, DEFAULT_TIMEOUT)).resolves.toBe('/usr/bin/storcli');
    expect(runner.runs.map((r) => r.command)).toEqual(['command -v storcli']);
  });

  it('falls back to storcli64 when storcli is missing', async () => {
    const runner = new FakeRunner((command) =>
      command === 'command -v storcli64' ? ok('/usr/local/bin/storcli64\n') : fail(127),
    );
    await expect(detectStorcli(runner, DEFAULT_TIMEOUT)).resolves.toBe('/usr/local/bin/storcli64');
    expect(runner.runs.map((r) => r.command)).toEqual(['command -v storcli', 'command -v storcli64']);
  });

  it('returns null when neither binary is present', async () => {
    const runner = new FakeRunner(() => fail(127));
    await expect(detectStorcli(runner, DEFAULT_TIMEOUT)).resolves.toBeNull();
  });

  it('treats a zero exit with only blank lines as missing', async () => {
    const runner = new FakeRunner(() => ok('  \n\n'));
    await expect(detectStorcli(runner, DEFAULT_TIMEOUT)).resolves.toBeNull();
  });
});

describe('runProbe — happy path', () => {
  it('populates every field from the canned command outputs', async () => {
    const runner = new FakeRunner(happyHandler, (command) =>
      command === '/usr/bin/storcli -v' ? ok('storcli version 007.1015\n') : fail(127),
    );

    const result = await runProbe(runner, DEFAULT_TIMEOUT);

    expect(result).toEqual({
      ok: true,
      status: 'ok',
      message: '连接成功',
      hostname: 'gpu-01',
      osRelease: 'Ubuntu 22.04.3 LTS',
      kernel: '5.15.0-91-generic',
      cpuCores: 64,
      memoryTotalMb: 257000,
      mounts: [
        { fs: '/dev/sda1', total: '200G', used: '50G', available: '140G', percent: 25, mountpoint: '/' },
        { fs: '/dev/sdb1', total: '1.0T', used: '200G', available: '800G', percent: 20, mountpoint: '/data' },
      ],
      storcliAvailable: true,
      storcliPath: '/usr/bin/storcli',
      sudoAvailable: true,
      warnings: [],
    });
    // every probed command observed the caller timeout
    for (const call of runner.runs) {
      expect(call.timeoutMs).toBe(DEFAULT_TIMEOUT);
    }
    expect(runner.sudoRuns).toEqual([{ command: '/usr/bin/storcli -v', timeoutMs: DEFAULT_TIMEOUT }]);
  });

  it('tolerates unparseable output and still reports success', async () => {
    const runner = new FakeRunner(() => ok('totally not parseable\n'));
    const result = await runProbe(runner, DEFAULT_TIMEOUT);
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe('totally not parseable');
    expect(result.osRelease).toBeNull();
    expect(result.kernel).toBe('totally not parseable');
    expect(result.cpuCores).toBeNull();
    expect(result.memoryTotalMb).toBeNull();
    expect(result.mounts).toEqual([]);
  });
});

describe('runProbe — warnings', () => {
  it('records "无法获取{label}" for every failed/blank read and leaves fields null', async () => {
    const runner = new FakeRunner((command) => {
      if (command === 'hostname') return fail(1);
      if (command === 'free -m') return ok('   \n');
      return HAPPY_OUTPUT[command] ?? fail(127);
    });

    const result = await runProbe(runner, DEFAULT_TIMEOUT);

    expect(result.ok).toBe(true);
    expect(result.hostname).toBeNull();
    expect(result.memoryTotalMb).toBeNull();
    expect(result.warnings).toContain('无法获取主机名');
    expect(result.warnings).toContain('无法获取内存信息');
    // other fields still populated
    expect(result.cpuCores).toBe(64);
  });

  it('warns about missing storcli but stays ok', async () => {
    const runner = new FakeRunner((command) =>
      command.startsWith('command -v ') ? fail(127) : HAPPY_OUTPUT[command] ?? fail(127),
    );

    const result = await runProbe(runner, DEFAULT_TIMEOUT);

    expect(result.ok).toBe(true);
    expect(result.storcliAvailable).toBe(false);
    expect(result.storcliPath).toBeNull();
    expect(result.sudoAvailable).toBe(false);
    expect(result.warnings).toContain(STORCLI_WARNING);
    // no storcli => no sudo probe
    expect(runner.sudoRuns).toHaveLength(0);
  });

  it('warns about sudo when runSudo throws SudoAuthError', async () => {
    const runner = new FakeRunner(happyHandler, () => {
      throw new SudoAuthError('sudo password rejected');
    });

    const result = await runProbe(runner, DEFAULT_TIMEOUT);

    expect(result.ok).toBe(true);
    expect(result.storcliAvailable).toBe(true);
    expect(result.storcliPath).toBe('/usr/bin/storcli');
    expect(result.sudoAvailable).toBe(false);
    expect(result.warnings).toContain(SUDO_WARNING);
  });

  it('warns about sudo when runSudo throws SudoUnavailable', async () => {
    const runner = new FakeRunner(happyHandler, () => {
      throw new SudoUnavailable('sudo missing');
    });
    const result = await runProbe(runner, DEFAULT_TIMEOUT);
    expect(result.sudoAvailable).toBe(false);
    expect(result.warnings).toContain(SUDO_WARNING);
  });

  it('warns about sudo when the sudo probe exits non-zero', async () => {
    const runner = new FakeRunner(happyHandler, () => fail(1, '', 'sudo: a password is required'));
    const result = await runProbe(runner, DEFAULT_TIMEOUT);
    expect(result.sudoAvailable).toBe(false);
    expect(result.warnings).toContain(SUDO_WARNING);
  });

  it('falls back to `sudo -n {path} -v` when the runner has no runSudo', async () => {
    const runner = new RunOnlyRunner(happyHandler);
    const result = await runProbe(runner, DEFAULT_TIMEOUT);
    expect(result.sudoAvailable).toBe(true);
    expect(runner.runs.map((r) => r.command)).toContain('sudo -n /usr/bin/storcli -v');
    expect(result.warnings).not.toContain(SUDO_WARNING);
  });
});

describe('mapProbeError', () => {
  it('maps authentication failures to auth_failed', () => {
    const error = Object.assign(new Error('All configured authentication methods failed'), {
      name: 'AuthenticationException',
    });
    expect(mapProbeError(error)).toMatchObject({
      ok: false,
      status: 'auth_failed',
      message: AUTH_MESSAGE,
    });
  });

  it('maps host key mismatches to host_key_failed', () => {
    expect(mapProbeError(new HostKeyMismatch('host key changed'))).toMatchObject({
      ok: false,
      status: 'host_key_failed',
      message: HOST_KEY_MESSAGE,
    });
  });

  it('maps timeouts to timeout', () => {
    const error = Object.assign(new Error('Timed out while waiting for handshake'), {
      name: 'TimeoutError',
    });
    expect(mapProbeError(error)).toMatchObject({ status: 'timeout', message: TIMEOUT_MESSAGE });
  });

  it('maps ETIMEDOUT codes to timeout', () => {
    const error = Object.assign(new Error('connect ETIMEDOUT 10.0.0.5:22'), { code: 'ETIMEDOUT' });
    expect(mapProbeError(error).status).toBe('timeout');
  });

  it('maps SSH handshake failures to ssh_error', () => {
    const error = Object.assign(new Error('ssh handshake failed'), { name: 'SSHException' });
    const result = mapProbeError(error);
    expect(result.status).toBe('ssh_error');
    expect(result.message.startsWith('SSH 连接失败：')).toBe(true);
  });

  it('maps connection refusals to connection_failed', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:22'), {
      code: 'ECONNREFUSED',
    });
    expect(mapProbeError(error)).toMatchObject({
      status: 'connection_failed',
      message: REFUSED_MESSAGE,
    });
  });

  it('maps anything else to error', () => {
    const result = mapProbeError(new Error('boom'));
    expect(result.status).toBe('error');
    expect(result.message.startsWith('探测失败：')).toBe(true);
  });

  it('defaults an unknown thrown value to error without throwing', () => {
    const result = mapProbeError('plain string');
    expect(result.status).toBe('error');
    expect(result.ok).toBe(false);
  });
});

describe('probeHost', () => {
  it('runs the probe through an injected factory and closes the runner', async () => {
    const runner = new FakeRunner(happyHandler, () => ok('ok'));
    const factory = vi.fn(factoryOf(runner));

    const result = await probeHost(candidate(), { sshFactory: factory, timeout: 5 });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(candidate());
    expect(result.ok).toBe(true);
    expect(result.hostname).toBe('gpu-01');
    expect(runner.closed).toBe(true);
    expect(runner.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('uses DEFAULT_TIMEOUT when no timeout option is provided', async () => {
    const runner = new FakeRunner(happyHandler, () => ok('ok'));
    await probeHost(candidate(), { sshFactory: factoryOf(runner) });
    for (const call of runner.runs) {
      expect(call.timeoutMs).toBe(DEFAULT_TIMEOUT);
    }
  });

  it('maps a thrown auth error and still closes the runner', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('All configured authentication methods failed'), {
        name: 'AuthenticationException',
      });
    });

    const result = await probeHost(candidate(), { sshFactory: factoryOf(runner) });

    expect(result.status).toBe('auth_failed');
    expect(result.message).toBe(AUTH_MESSAGE);
    expect(runner.closed).toBe(true);
  });

  it('maps a thrown timeout error', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const result = await probeHost(candidate(), { sshFactory: factoryOf(runner) });
    expect(result.status).toBe('timeout');
    expect(result.message).toBe(TIMEOUT_MESSAGE);
  });

  it('maps a connection refusal', async () => {
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const result = await probeHost(candidate(), { sshFactory: factoryOf(runner) });
    expect(result.status).toBe('connection_failed');
    expect(result.message).toBe(REFUSED_MESSAGE);
  });

  it('maps an unexpected exception to error', async () => {
    const runner = new FakeRunner(() => {
      throw new Error('kaboom');
    });
    const result = await probeHost(candidate(), { sshFactory: factoryOf(runner) });
    expect(result.status).toBe('error');
    expect(result.message.startsWith('探测失败：')).toBe(true);
    expect(runner.closed).toBe(true);
  });

  it('captures errors thrown by the factory itself', async () => {
    const factory: ProbeRunnerFactory = () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    };
    const result = await probeHost(candidate(), { sshFactory: factory });
    expect(result.status).toBe('connection_failed');
  });

  it('never echoes the candidate password in any failure message', async () => {
    const secret = 'topsecret-not-echoed';
    const runner = new FakeRunner(() => {
      throw Object.assign(new Error('All configured authentication methods failed'), {
        name: 'AuthenticationException',
      });
    });
    const result = await probeHost(candidate({ password: secret }), {
      sshFactory: factoryOf(runner),
    });
    expect(result.message).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe('defaultRunnerFactory', () => {
  it('builds a runner exposing run / runSudo / close', () => {
    const runner = defaultRunnerFactory(candidate());
    expect(typeof runner.run).toBe('function');
    expect(typeof runner.runSudo).toBe('function');
    expect(typeof runner.close).toBe('function');
  });
});
