/**
 * P4 Task 7 — availability checks (port of `servermanage/availability.py`).
 *
 * Covers every `check_type` (validate / build / parse), the injection-hardening
 * rules around targets and timeouts, the batch runner's ordering + error
 * isolation, and the route-facing `coerceHostCheckConfig` preparation. All
 * runner interactions use a fake `CheckRunner` — nothing here dials a host.
 */
import { describe, expect, it } from 'vitest';

import type { HostCheckConfig, HostConfig } from '../../src/config/config';
import type { CommandResult } from '../../src/collect/types';
import {
  CheckTargetError,
  SUPPORTED_CHECK_TYPES,
  buildCheckCommand,
  coerceHostCheckConfig,
  coerceTimeoutSeconds,
  expectedRange,
  parseCheckResult,
  runHostChecks,
  validateCheckTarget,
  type CheckRunner,
} from '../../src/runtime/availability';

/** Opaque host fixture — `runHostChecks` ignores it (as the Python oracle does). */
const HOST = { name: 'alpha', host: '127.0.0.1' } as HostConfig;

/** Builds a valid check config with sensible defaults. */
function check(overrides: Partial<HostCheckConfig> = {}): HostCheckConfig {
  return {
    name: 'probe',
    type: 'tcp',
    target: '127.0.0.1:22',
    timeout_seconds: 5,
    enabled: true,
    ...overrides,
  };
}

/** Builds a command result with defaults. */
function cmd(partial: Partial<CommandResult> = {}): CommandResult {
  return { stdout: '', stderr: '', exitStatus: 0, ...partial };
}

// ---------------------------------------------------------------------------
// validateCheckTarget — accepted targets
// ---------------------------------------------------------------------------

describe('validateCheckTarget — accepted targets', () => {
  it('exposes the supported check types', () => {
    expect(SUPPORTED_CHECK_TYPES).toEqual(['tcp', 'http', 'process', 'service']);
  });

  it.each([
    ['tcp', '127.0.0.1:22'],
    ['tcp', '10.0.0.5:2222'],
    ['tcp', '[::1]:22'],
    ['tcp', '22'],
    ['http', 'http://127.0.0.1:8000/health'],
    ['http', 'https://example.com/health'],
    ['process', 'nginx'],
    ['process', 'my-app_1.0'],
    ['service', 'nginx.service'],
    ['service', 'getty@tty1.service'],
  ])('accepts %s target %j unchanged', (type, target) => {
    expect(validateCheckTarget(type, target)).toBe(target);
  });
});

// ---------------------------------------------------------------------------
// validateCheckTarget — rejected targets (injection hardening)
// ---------------------------------------------------------------------------

describe('validateCheckTarget — HTTP rejections', () => {
  it.each([
    'http://x/$(id)',
    'http://x/;id',
    'http://x/a|b',
    'http://x/a&b',
    'http://x/`id`',
    'http://x/a b',
    'http://x/a\tb',
    'http://x/health?token=abc',
    'http://x/health#frag',
    'http://user:pw@x/health',
    'ftp://x/health',
    'http:///no-host',
  ])('rejects %j with a CheckTargetError', (target) => {
    expect(() => validateCheckTarget('http', target)).toThrow(CheckTargetError);
  });

  it('names the forbidden token', () => {
    expect(() => validateCheckTarget('http', 'http://x/$(id)')).toThrow(
      "HTTP 目标包含非法字符: '$('",
    );
  });

  it('rejects userinfo credentials', () => {
    expect(() => validateCheckTarget('http', 'http://user:pw@x/health')).toThrow(
      'HTTP 目标不允许携带 userinfo/凭据',
    );
  });

  it('rejects a missing host like Python urlsplit', () => {
    expect(() => validateCheckTarget('http', 'http:///no-host')).toThrow('HTTP 目标缺少主机');
    expect(() => validateCheckTarget('http', 'http://')).toThrow('HTTP 目标缺少主机');
  });

  it('only allows http/https schemes', () => {
    expect(() => validateCheckTarget('http', 'ftp://x/health')).toThrow(
      'HTTP 目标只允许 http/https',
    );
    expect(() => validateCheckTarget('http', 'abc')).toThrow('HTTP 目标只允许 http/https');
  });

  it('rejects whitespace / control characters before parsing', () => {
    expect(() => validateCheckTarget('http', 'http://x/a b')).toThrow(
      'HTTP 目标包含空白或控制字符',
    );
  });
});

describe('validateCheckTarget — TCP rejections', () => {
  it.each([
    "22'; id; '",
    "1.2.3.4:22'; id; '",
    'host name:22',
    '1.2.3.4:notaport',
    '1.2.3.4:0',
    '1.2.3.4:70000',
    'bad_host!:22',
    ':22',
    '1.2.3.4:',
  ])('rejects %j with a CheckTargetError', (target) => {
    expect(() => validateCheckTarget('tcp', target)).toThrow(CheckTargetError);
  });

  it('reports an illegal hostname verbatim', () => {
    expect(() => validateCheckTarget('tcp', 'bad_host!:22')).toThrow(
      "TCP 主机名非法: 'bad_host!'",
    );
  });

  it('reports an out-of-range port', () => {
    expect(() => validateCheckTarget('tcp', '1.2.3.4:70000')).toThrow(
      'TCP 端口必须在 1..65535 之间',
    );
  });
});

describe('validateCheckTarget — process/service rejections', () => {
  it.each(['nginx; id', 'foo bar', 'a`id`', 'x'.repeat(65), '', '$(id)'])(
    'rejects process %j',
    (target) => {
      expect(() => validateCheckTarget('process', target)).toThrow(CheckTargetError);
    },
  );

  it.each(['nginx;rm', 'a b', 'x'.repeat(129), '', '$(id)'])(
    'rejects service %j',
    (target) => {
      expect(() => validateCheckTarget('service', target)).toThrow(CheckTargetError);
    },
  );

  it('rejects unknown check types', () => {
    expect(() => validateCheckTarget('dns', 'example.com')).toThrow(
      "不支持的检查类型: 'dns'",
    );
    expect(() => validateCheckTarget('', 'x')).toThrow("不支持的检查类型: ''");
  });
});

// ---------------------------------------------------------------------------
// coerceTimeoutSeconds
// ---------------------------------------------------------------------------

describe('coerceTimeoutSeconds', () => {
  it.each(['5; rm -rf /', 'abc', true, false, null, 0, 31, -1, 5.5])(
    'rejects %j',
    (value) => {
      expect(() => coerceTimeoutSeconds(value)).toThrow(CheckTargetError);
    },
  );

  it('accepts integers inside 1..30', () => {
    expect(coerceTimeoutSeconds(1)).toBe(1);
    expect(coerceTimeoutSeconds(30)).toBe(30);
    expect(coerceTimeoutSeconds('7')).toBe(7);
  });

  it('uses distinct messages for booleans/floats/range', () => {
    expect(() => coerceTimeoutSeconds(true)).toThrow('timeout_seconds 不能是布尔值');
    expect(() => coerceTimeoutSeconds(5.5)).toThrow('timeout_seconds 必须是整数');
    expect(() => coerceTimeoutSeconds(31)).toThrow('timeout_seconds 必须在 1..30 之间');
  });
});

// ---------------------------------------------------------------------------
// buildCheckCommand — byte-exact shell rendering
// ---------------------------------------------------------------------------

describe('buildCheckCommand', () => {
  it('renders the default localhost TCP probe', () => {
    expect(buildCheckCommand(check({ type: 'tcp', target: '22', timeout_seconds: 5 }))).toBe(
      "timeout 5 bash -c 'cat < /dev/null > /dev/tcp/127.0.0.1/22'",
    );
  });

  it('renders an explicit TCP host/port', () => {
    expect(
      buildCheckCommand(check({ type: 'tcp', target: '10.0.0.5:2222', timeout_seconds: 5 })),
    ).toBe("timeout 5 bash -c 'cat < /dev/null > /dev/tcp/10.0.0.5/2222'");
  });

  it('brackets an IPv6 command host', () => {
    expect(buildCheckCommand(check({ type: 'tcp', target: '[::1]:22', timeout_seconds: 5 }))).toBe(
      "timeout 5 bash -c 'cat < /dev/null > /dev/tcp/[::1]/22'",
    );
  });

  it('renders HTTP with an unquoted safe URL and integer timeout', () => {
    expect(
      buildCheckCommand(
        check({ type: 'http', target: 'http://127.0.0.1:8000/health', timeout_seconds: 7 }),
      ),
    ).toBe(
      "curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time 7 http://127.0.0.1:8000/health",
    );
  });

  it('shell-quotes an HTTP URL that needs it', () => {
    expect(
      buildCheckCommand(
        check({ type: 'http', target: 'http://127.0.0.1:8000/health~x', timeout_seconds: 5 }),
      ),
    ).toBe(
      "curl -sS -o /dev/null -w '%{http_code} %{time_total}' --max-time 5 'http://127.0.0.1:8000/health~x'",
    );
  });

  it('renders process and service probes', () => {
    expect(buildCheckCommand(check({ type: 'process', target: 'nginx' }))).toBe(
      'pgrep -x -- nginx',
    );
    expect(buildCheckCommand(check({ type: 'service', target: 'nginx.service' }))).toBe(
      'systemctl is-active -- nginx.service',
    );
  });

  it('rejects an injected timeout', () => {
    expect(() =>
      buildCheckCommand(check({ timeout_seconds: '5; rm -rf /' as unknown as number })),
    ).toThrow('timeout_seconds 必须是整数');
  });

  it('rejects an unknown check type', () => {
    expect(() => buildCheckCommand(check({ type: 'dns', target: 'example.com' }))).toThrow(
      "不支持的检查类型: 'dns'",
    );
  });
});

// ---------------------------------------------------------------------------
// expectedRange
// ---------------------------------------------------------------------------

describe('expectedRange', () => {
  it.each([
    [undefined, [200, 399]],
    [null, [200, 399]],
    ['', [200, 399]],
    ['200-299', [200, 299]],
    ['201', [201, 201]],
    ['500-200', [200, 500]],
    ['nope', [200, 399]],
  ])('maps %j → %j', (input, expected) => {
    expect(expectedRange(input as string | null | undefined)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// parseCheckResult — HTTP
// ---------------------------------------------------------------------------

describe('parseCheckResult — HTTP', () => {
  it.each([
    ['200 0.25', undefined, 'ok', 'HTTP 200', 250],
    ['500 0.1', undefined, 'failed', 'HTTP 500（期望 200-399）', 100],
    ['204 0.5', '200-299', 'ok', 'HTTP 204', 500],
    ['300 0.2', '200-299', 'failed', 'HTTP 300（期望 200-299）', 200],
    ['201 0.0', '201', 'ok', 'HTTP 201', 0],
    ['202 0.0', '201', 'failed', 'HTTP 202（期望 201-201）', 0],
    ['000 0.0', undefined, 'error', 'HTTP 000：无法连接', 0],
  ])('parses %j (expected %j)', (stdout, expected, status, message, latency) => {
    const parsed = parseCheckResult(
      check({ type: 'http', target: 'http://x/health', expected: expected as string | undefined }),
      cmd({ stdout }),
    );
    expect(parsed.status).toBe(status);
    expect(parsed.message).toBe(message);
    expect(parsed.latencyMs).toBe(latency);
  });

  it('maps exit 127 to curl unavailable', () => {
    const parsed = parseCheckResult(check({ type: 'http' }), cmd({ exitStatus: 127 }));
    expect(parsed.status).toBe('error');
    expect(parsed.message).toBe('curl 不可用');
  });

  it('maps empty output to an error', () => {
    const parsed = parseCheckResult(check({ type: 'http' }), cmd({ stdout: '   \n' }));
    expect(parsed).toMatchObject({ status: 'error', message: '无 HTTP 输出', latencyMs: null });
  });

  it('maps a non-numeric status to an error', () => {
    const parsed = parseCheckResult(check({ type: 'http' }), cmd({ stdout: 'abc 0.1' }));
    expect(parsed.status).toBe('error');
    expect(parsed.message).toBe('HTTP abc：无法连接');
    expect(parsed.latencyMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// parseCheckResult — TCP / process / service
// ---------------------------------------------------------------------------

describe('parseCheckResult — TCP', () => {
  it('maps exit 0 to reachable', () => {
    expect(parseCheckResult(check({ type: 'tcp' }), cmd({ exitStatus: 0 }))).toMatchObject({
      status: 'ok',
      message: '端口可连接',
    });
  });

  it('maps a non-zero exit to unreachable, keeping stderr detail', () => {
    expect(
      parseCheckResult(check({ type: 'tcp' }), cmd({ exitStatus: 1, stderr: 'Connection refused\n' })),
    ).toMatchObject({ status: 'failed', message: '端口不可连接：Connection refused' });
    expect(parseCheckResult(check({ type: 'tcp' }), cmd({ exitStatus: 1 }))).toMatchObject({
      status: 'failed',
      message: '端口不可连接',
    });
  });

  it('maps exit 127 to a missing timeout/bash', () => {
    expect(parseCheckResult(check({ type: 'tcp' }), cmd({ exitStatus: 127 }))).toMatchObject({
      status: 'error',
      message: 'timeout/bash 命令不可用',
    });
  });
});

describe('parseCheckResult — process', () => {
  it.each([
    [cmd({ exitStatus: 0, stdout: '1234\n' }), 'ok', '进程运行中'],
    [cmd({ exitStatus: 1 }), 'failed', '进程未运行'],
    [cmd({ exitStatus: 0, stdout: '' }), 'error', '进程检查无输出'],
    [cmd({ exitStatus: 2 }), 'error', 'pgrep 退出码 2'],
  ])('maps process result %#', (result, status, message) => {
    expect(parseCheckResult(check({ type: 'process', target: 'nginx' }), result)).toMatchObject({
      status,
      message,
    });
  });
});

describe('parseCheckResult — service', () => {
  it.each([
    [cmd({ stdout: 'active\n' }), 'ok', '服务 active'],
    [cmd({ stdout: 'inactive\n' }), 'failed', '服务 inactive'],
    [cmd({ stdout: 'failed\n' }), 'failed', '服务 failed'],
    [cmd({ stdout: 'activating\n' }), 'error', '服务状态 activating'],
    [cmd({ stdout: '' }), 'error', '服务状态 未知'],
  ])('maps service result %#', (result, status, message) => {
    expect(parseCheckResult(check({ type: 'service', target: 'nginx.service' }), result)).toMatchObject(
      { status, message },
    );
  });
});

describe('parseCheckResult — metadata', () => {
  it('carries name/type/target and a UTC timestamp', () => {
    const parsed = parseCheckResult(
      check({ name: 'web', type: 'process', target: 'nginx' }),
      cmd({ exitStatus: 0, stdout: '42\n' }),
    );
    expect(parsed.name).toBe('web');
    expect(parsed.type).toBe('process');
    expect(parsed.target).toBe('nginx');
    expect(parsed.latencyMs).toBeNull();
    expect(parsed.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.+\+00:00$/);
  });

  it('errors on an unknown check type', () => {
    expect(parseCheckResult(check({ type: 'dns' }), cmd())).toMatchObject({
      status: 'error',
      message: "不支持的检查类型: 'dns'",
    });
  });
});

// ---------------------------------------------------------------------------
// runHostChecks — sequencing + error isolation
// ---------------------------------------------------------------------------

describe('runHostChecks', () => {
  it('runs checks sequentially in order', async () => {
    const calls: Array<{ command: string; timeoutMs: number }> = [];
    const runner: CheckRunner = {
      run: (command, timeoutMs) => {
        calls.push({ command, timeoutMs });
        return command.startsWith('pgrep')
          ? cmd({ stdout: '1234\n' })
          : cmd({ stdout: 'active\n' });
      },
    };
    const checks = [
      check({ name: 'p', type: 'process', target: 'nginx' }),
      check({ name: 's', type: 'service', target: 'nginx.service' }),
    ];
    const results = await runHostChecks(HOST, checks, runner);
    expect(calls.map((c) => c.command)).toEqual([
      'pgrep -x -- nginx',
      'systemctl is-active -- nginx.service',
    ]);
    expect(calls.map((c) => c.timeoutMs)).toEqual([5000, 5000]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(results.map((r) => r.name)).toEqual(['p', 's']);
  });

  it('isolates one validation failure without aborting the rest', async () => {
    const calls: string[] = [];
    const runner: CheckRunner = {
      run: (command) => {
        calls.push(command);
        return cmd({ stdout: 'active\n' });
      },
    };
    const checks = [
      check({ name: 'bad', type: 'tcp', target: '1.2.3.4:notaport' }),
      check({ name: 'good', type: 'service', target: 'nginx.service' }),
    ];
    const results = await runHostChecks(HOST, checks, runner);
    expect(results[0]).toMatchObject({
      status: 'error',
      message: "检查执行失败：TCP 端口非法: 'notaport'",
      latencyMs: null,
    });
    expect(results[1].status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('isolates a throwing runner', async () => {
    const runner: CheckRunner = {
      run: (command) => {
        if (command.startsWith('pgrep')) throw new Error('boom');
        return cmd({ stdout: 'active\n' });
      },
    };
    const checks = [
      check({ name: 'p', type: 'process', target: 'nginx' }),
      check({ name: 's', type: 'service', target: 'nginx.service' }),
    ];
    const results = await runHostChecks(HOST, checks, runner);
    expect(results[0]).toMatchObject({ status: 'error', message: '检查执行失败：boom' });
    expect(results[1].status).toBe('ok');
  });

  it('skips disabled checks', async () => {
    let count = 0;
    const runner: CheckRunner = {
      run: () => {
        count += 1;
        return cmd({ stdout: '1\n' });
      },
    };
    const checks = [
      check({ name: 'off', type: 'process', target: 'nginx', enabled: false }),
      check({ name: 'on', type: 'process', target: 'nginx' }),
    ];
    const results = await runHostChecks(HOST, checks, runner);
    expect(count).toBe(1);
    expect(results).toHaveLength(1);
  });

  it('clamps the per-check timeout to the command ceiling', async () => {
    const timeouts: number[] = [];
    const runner: CheckRunner = {
      run: (_command, timeoutMs) => {
        timeouts.push(timeoutMs);
        return cmd({ stdout: '1\n' });
      },
    };
    const checks = [check({ type: 'process', target: 'nginx', timeout_seconds: 10 })];
    await runHostChecks(HOST, checks, runner, { timeoutMs: 3000 });
    await runHostChecks(HOST, checks, runner);
    expect(timeouts).toEqual([3000, 10000]);
  });

  it('caps the batch at 20 checks', async () => {
    let count = 0;
    const runner: CheckRunner = {
      run: () => {
        count += 1;
        return cmd({ stdout: '1\n' });
      },
    };
    const checks = Array.from({ length: 25 }, (_, i) =>
      check({ name: `c${i}`, type: 'process', target: 'nginx' }),
    );
    const results = await runHostChecks(HOST, checks, runner);
    expect(count).toBe(20);
    expect(results).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// coerceHostCheckConfig — route preparation
// ---------------------------------------------------------------------------

describe('coerceHostCheckConfig', () => {
  it('applies defaults and trims fields', () => {
    expect(
      coerceHostCheckConfig({ name: ' probe ', type: 'TCP', target: ' 1.2.3.4:22 ' }),
    ).toEqual({
      name: 'probe',
      type: 'tcp',
      target: '1.2.3.4:22',
      timeout_seconds: 5,
      enabled: true,
    });
  });

  it('keeps an explicit timeout and expected', () => {
    expect(
      coerceHostCheckConfig({
        name: 'web',
        type: 'http',
        target: 'http://x/health',
        timeout_seconds: 3,
        expected: '200-299',
        enabled: false,
      }),
    ).toMatchObject({ timeout_seconds: 3, expected: '200-299', enabled: false });
  });

  it('rejects a missing name', () => {
    expect(() => coerceHostCheckConfig({ type: 'tcp', target: 'x:22' })).toThrow(
      'checks[0].name 不能为空',
    );
  });

  it('rejects an unsupported type', () => {
    expect(() => coerceHostCheckConfig({ name: 'a', type: 'dns', target: 'x' })).toThrow(
      'checks[0].type 必须是 tcp/http/process/service 之一',
    );
  });

  it('rejects an empty target', () => {
    expect(() => coerceHostCheckConfig({ name: 'a', type: 'tcp', target: '  ' })).toThrow(
      'checks[0].target 不能为空',
    );
  });

  it('rejects a boolean or out-of-range timeout', () => {
    expect(() =>
      coerceHostCheckConfig({ name: 'a', type: 'tcp', target: 'x:22', timeout_seconds: true }),
    ).toThrow('checks[0].timeout_seconds 必须是整数');
    expect(() =>
      coerceHostCheckConfig({ name: 'a', type: 'tcp', target: 'x:22', timeout_seconds: 31 }),
    ).toThrow('checks[0].timeout_seconds 必须在 1 到 30 之间');
  });

  it('rejects a malformed expected status', () => {
    expect(() =>
      coerceHostCheckConfig({
        name: 'a',
        type: 'http',
        target: 'http://x/',
        expected: '2xx',
      }),
    ).toThrow('checks[0].expected 必须是 200 或 200-299 这样的状态码');
  });
});
