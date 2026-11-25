/**
 * Tests for the pure alert rules (`backend/src/alerts/rules.ts`), ported 1:1
 * from the Python oracle tests `tests/test_alert_rules.py` and
 * `tests/test_user_alerts.py` (Task 3 of P4).
 *
 * Every `evaluate_*` block covers: trigger / no-trigger / missing-metric skip /
 * per-host override / severity / exact message text.
 */
import { describe, it, expect } from 'vitest';

import {
  DEFAULT_ALERT_THRESHOLDS,
  effectiveThresholds,
  evaluateAvailabilityAlerts,
  evaluateDiskAlerts,
  evaluateSystemAlerts,
  evaluateUserAlerts,
  fingerprintFor,
  formatG,
  offlineAlert,
  recoveryEvent,
  type AlertEvent,
  type AlertThresholds,
  type DiskHealthReport,
  type HostAlertRules,
  type PhysicalDriveInfo,
  type VirtualDriveInfo,
} from '../../src/alerts/rules';
import {
  emptyHostMetrics,
  type GPUSummaryRow,
  type HostCheckResult,
  type HostMetrics,
  type HostUserAccount,
  type MemorySummary,
} from '../../src/collect/types';

const NOW = '2026-11-06T12:00:00.000000+00:00';

// --- Fixtures --------------------------------------------------------------

function memory(totalMb: number, usedMb: number): MemorySummary {
  return {
    totalMb,
    usedMb,
    freeMb: totalMb - usedMb,
    sharedMb: 0,
    buffCacheMb: 0,
    availableMb: totalMb - usedMb,
    swapTotalMb: 0,
    swapUsedMb: 0,
    swapFreeMb: 0,
  };
}

function gpu(usedMb: number, totalMb: number): GPUSummaryRow {
  return {
    index: 0,
    name: 'A100',
    utilizationPercent: 0,
    temperatureC: null,
    memoryUsedMb: usedMb,
    memoryTotalMb: totalMb,
  };
}

function metrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return { ...emptyHostMetrics(), ...overrides };
}

function thresholds(overrides: Partial<AlertThresholds> = {}): AlertThresholds {
  return { ...DEFAULT_ALERT_THRESHOLDS, ...overrides };
}

function check(overrides: Partial<HostCheckResult> = {}): HostCheckResult {
  return {
    name: 'API',
    type: 'tcp',
    target: '8000',
    status: 'failed',
    message: '连接超时',
    latencyMs: null,
    checkedAt: NOW,
    ...overrides,
  };
}

function account(overrides: Partial<HostUserAccount> = {}): HostUserAccount {
  return {
    hostName: 'gpu-01',
    username: 'alice',
    uid: 1000,
    gid: 1000,
    primaryGroup: 'alice',
    gecos: 'Alice',
    home: '/home/alice',
    shell: '/bin/bash',
    groups: ['alice', 'docker'],
    inDocker: true,
    inSudo: false,
    homeExists: true,
    homeOwner: 'alice',
    homeGroup: 'alice',
    homeMode: '755',
    homeSizeBytes: null,
    dataExists: true,
    dataOwner: 'alice',
    dataGroup: 'alice',
    dataMode: '755',
    dataSizeBytes: null,
    dataSupported: true,
    usageReadable: true,
    usageStale: false,
    usageCollectedAt: null,
    collectedAt: NOW,
    state: 'present',
    ...overrides,
  };
}

function fingerprints(events: AlertEvent[]): string[] {
  return events.map((event) => event.fingerprint);
}

// ---------------------------------------------------------------------------
// fingerprint_for
// ---------------------------------------------------------------------------

describe('fingerprintFor', () => {
  it('is colon-joined and lower-cased', () => {
    expect(fingerprintFor('System', 'GPU-01', 'CPU')).toBe('system:gpu-01:cpu');
  });

  it('accepts several parts and preserves order', () => {
    expect(fingerprintFor('disk', 'gpu-01', 'c0', 'e252', 's3', 'media_errors'))
      .toBe('disk:gpu-01:c0:e252:s3:media_errors');
  });
});

// ---------------------------------------------------------------------------
// formatG (Python %g parity for threshold text)
// ---------------------------------------------------------------------------

describe('formatG', () => {
  it('renders integers without a decimal point', () => {
    expect(formatG(90)).toBe('90');
    expect(formatG(0)).toBe('0');
  });

  it('keeps up to six significant digits', () => {
    expect(formatG(90.5)).toBe('90.5');
    expect(formatG(90.123456789)).toBe('90.1235');
  });

  it('switches to exponent notation exactly like Python %g', () => {
    expect(formatG(1_000_000)).toBe('1e+06');
    expect(formatG(1.23456789e-5)).toBe('1.23457e-05');
    expect(formatG(0.0001)).toBe('0.0001');
  });
});

// ---------------------------------------------------------------------------
// evaluate_system_alerts
// ---------------------------------------------------------------------------

describe('evaluateSystemAlerts', () => {
  it('fires CPU/memory/GPU warnings at the threshold with distinct fingerprints', () => {
    const m = metrics({
      cpuUsagePercent: 95,
      memory: memory(100, 90), // 90% -> at threshold
      gpuSummary: [gpu(95, 100)],
    });
    const events = evaluateSystemAlerts('gpu-01', m, thresholds());

    expect(events).toHaveLength(3);
    expect(events.every((e) => e.severity === 'warning')).toBe(true);
    expect(events.every((e) => e.category === 'system')).toBe(true);
    expect(new Set(fingerprints(events)).size).toBe(3);
    expect(fingerprints(events)).toContain('system:gpu-01:cpu');
    expect(fingerprints(events)).toContain('system:gpu-01:memory');
    expect(fingerprints(events)).toContain('system:gpu-01:gpu_memory');
    expect(events.map((e) => e.title)).toEqual(
      expect.arrayContaining(['CPU 使用率过高', '内存使用率过高', 'GPU 显存占用过高']),
    );
  });

  it('emits exact CPU message text', () => {
    const events = evaluateSystemAlerts(
      'gpu-01',
      metrics({ cpuUsagePercent: 95 }),
      thresholds(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('主机 gpu-01 CPU 使用率 95.0% 达到阈值 90%');
  });

  it('emits exact memory message text', () => {
    const events = evaluateSystemAlerts(
      'gpu-01',
      metrics({ memory: memory(100, 90) }),
      thresholds(),
    );
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('主机 gpu-01 内存使用率 90.0% 达到阈值 90%');
  });

  it('treats the threshold as inclusive (>=) for CPU', () => {
    expect(
      evaluateSystemAlerts('gpu-01', metrics({ cpuUsagePercent: 90 }), thresholds()),
    ).toHaveLength(1);
  });

  it('does not fire just below the threshold', () => {
    const m = metrics({
      cpuUsagePercent: 89.9,
      memory: memory(100, 40),
      gpuSummary: [gpu(30, 100)],
    });
    expect(evaluateSystemAlerts('gpu-01', m, thresholds(), { diskPercent: 20 }))
      .toEqual([]);
  });

  it('skips missing metrics instead of treating them as 0', () => {
    expect(evaluateSystemAlerts('gpu-01', metrics(), thresholds())).toEqual([]);
  });

  it('skips memory with a zero total', () => {
    expect(
      evaluateSystemAlerts('gpu-01', metrics({ memory: memory(0, 0) }), thresholds()),
    ).toEqual([]);
  });

  it('skips GPU when the aggregate total is zero', () => {
    expect(
      evaluateSystemAlerts(
        'gpu-01',
        metrics({ gpuSummary: [gpu(0, 0)] }),
        thresholds(),
      ),
    ).toEqual([]);
  });

  it('fires a single disk warning from diskPercent, with exact message', () => {
    const m = metrics({ cpuUsagePercent: 10, memory: memory(100, 10) });
    const events = evaluateSystemAlerts('gpu-01', m, thresholds(), {
      diskPercent: 95,
    });

    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('system');
    expect(events[0].severity).toBe('warning');
    expect(events[0].fingerprint).toBe('system:gpu-01:disk');
    expect(events[0].title).toBe('磁盘使用率过高');
    expect(events[0].message).toBe('主机 gpu-01 磁盘使用率 95.0% 达到阈值 90%');
  });

  it('prefers diskMounts over diskPercent and fingerprints per mountpoint', () => {
    const m = metrics({ cpuUsagePercent: 10, memory: memory(100, 10) });
    const events = evaluateSystemAlerts('gpu-01', m, thresholds(), {
      diskPercent: 10, // below threshold and shadowed by mounts
      diskMounts: [
        { present: true, percent: 93.2, mountpoint: '/data' },
        { present: true, percent: '91', mountpoint: '/' },
      ],
    });

    expect(events).toHaveLength(2);
    expect(fingerprints(events)).toEqual([
      'system:gpu-01:disk:/data',
      'system:gpu-01:disk:/',
    ]);
    expect(events[0].message).toBe(
      '主机 gpu-01 挂载点 /data 磁盘使用率 93.2% 达到阈值 90%',
    );
  });

  it('skips absent mounts and mounts with a null percent', () => {
    const m = metrics({ cpuUsagePercent: 10, memory: memory(100, 10) });
    const events = evaluateSystemAlerts('gpu-01', m, thresholds(), {
      diskMounts: [
        { present: false, percent: 99, mountpoint: '/mnt' },
        { present: true, percent: null, mountpoint: '/var' },
        { present: true, percent: 95, mountpoint: '/data' },
      ],
    });
    expect(fingerprints(events)).toEqual(['system:gpu-01:disk:/data']);
  });

  it('honours per-host threshold overrides resolved via effectiveThresholds', () => {
    const rule: HostAlertRules = { cpu_percent: 95 };
    const effective = effectiveThresholds(thresholds(), rule);

    expect(
      evaluateSystemAlerts('gpu-01', metrics({ cpuUsagePercent: 92 }), effective),
    ).toEqual([]);
    expect(
      evaluateSystemAlerts('gpu-01', metrics({ cpuUsagePercent: 96 }), effective),
    ).toHaveLength(1);
  });

  it('keeps fingerprints stable across repeated runs', () => {
    const m = metrics({ cpuUsagePercent: 99 });
    const first = evaluateSystemAlerts('gpu-01', m, thresholds());
    const second = evaluateSystemAlerts('gpu-01', m, thresholds());
    expect(fingerprints(first)).toEqual(fingerprints(second));
  });
});

// ---------------------------------------------------------------------------
// effective_thresholds
// ---------------------------------------------------------------------------

describe('effectiveThresholds', () => {
  it('applies host overrides and inherits the rest', () => {
    const result = effectiveThresholds(90, {
      cpu_percent: 95,
      disk_temperature_c: 60,
    });
    expect(result.cpu_percent).toBe(95);
    expect(result.disk_temperature_c).toBe(60);
    expect(result.memory_percent).toBe(90);
    expect(result.disk_percent).toBe(90);
    expect(result.gpu_memory_percent).toBe(90);
  });

  it('uses the global object when there are no host rules', () => {
    const result = effectiveThresholds(thresholds({ cpu_percent: 88 }));
    expect(result.cpu_percent).toBe(88);
    expect(result.memory_percent).toBe(90);
    expect(result.disk_temperature_c).toBe(55);
  });

  it('expands a scalar global to every field', () => {
    const result = effectiveThresholds(70);
    expect([
      result.cpu_percent,
      result.memory_percent,
      result.disk_percent,
      result.gpu_memory_percent,
      result.disk_temperature_c,
    ]).toEqual([70, 70, 70, 70, 70]);
  });

  it('ignores null overrides (inherit)', () => {
    const result = effectiveThresholds(90, {
      cpu_percent: null,
      memory_percent: 80,
    });
    expect(result.cpu_percent).toBe(90);
    expect(result.memory_percent).toBe(80);
  });

  it('defaults to the scalar 90 for every field when called with no args', () => {
    // Mirrors Python: effective_thresholds() uses the scalar 90 default, so the
    // disk temperature falls back to 90 too (not the AlertThresholds() 55).
    const result = effectiveThresholds();
    expect([
      result.cpu_percent,
      result.memory_percent,
      result.disk_percent,
      result.gpu_memory_percent,
      result.disk_temperature_c,
    ]).toEqual([90, 90, 90, 90, 90]);
  });
});

// ---------------------------------------------------------------------------
// evaluate_availability_alerts
// ---------------------------------------------------------------------------

describe('evaluateAvailabilityAlerts', () => {
  it('emits a critical alert for a failed check with exact text', () => {
    const events = evaluateAvailabilityAlerts('gpu-01', [check()]);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.host_name).toBe('gpu-01');
    expect(event.category).toBe('availability');
    expect(event.severity).toBe('critical');
    expect(event.fingerprint).toBe(fingerprintFor('availability', 'gpu-01', 'API'));
    expect(event.title).toBe('服务检查失败：API');
    expect(event.message).toBe(
      '主机 gpu-01 服务检查 API（类型 tcp，目标 8000）失败：连接超时',
    );
  });

  it('emits an alert for an error status', () => {
    const events = evaluateAvailabilityAlerts('gpu-01', [
      check({ status: 'error' }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('critical');
  });

  it('normalises status case and surrounding whitespace', () => {
    const events = evaluateAvailabilityAlerts('gpu-01', [
      check({ status: ' FAILED ' }),
    ]);
    expect(events).toHaveLength(1);
  });

  it('does not alert for ok or unknown checks', () => {
    expect(
      evaluateAvailabilityAlerts('gpu-01', [
        check({ status: 'ok' }),
        check({ name: 'DB', status: 'unknown' }),
      ]),
    ).toEqual([]);
  });

  it('keeps fingerprints stable and distinct per check name', () => {
    const results = [check(), check({ name: 'DB', type: 'http' })];
    const first = evaluateAvailabilityAlerts('gpu-01', results);
    const second = evaluateAvailabilityAlerts('gpu-01', results);
    expect(fingerprints(first)).toEqual(fingerprints(second));
    expect(new Set(fingerprints(first)).size).toBe(2);
  });

  it('returns nothing for an empty result list', () => {
    expect(evaluateAvailabilityAlerts('gpu-01', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluate_user_alerts
// ---------------------------------------------------------------------------

describe('evaluateUserAlerts', () => {
  it('emits only user-present for a missing account, ignoring stale state', () => {
    const a = account({
      inDocker: false,
      homeExists: false,
      homeOwner: null,
      dataExists: false,
      dataOwner: null,
    });
    const events = evaluateUserAlerts(a, { inBaseline: true, missing: true });

    expect(fingerprints(events)).toEqual(['user-present:gpu-01:alice']);
    expect(events[0].category).toBe('user');
    expect(events[0].severity).toBe('warning');
    expect(events[0].title).toBe('账号缺失');
    expect(events[0].message).toBe(
      '主机 gpu-01 的账号 alice 已从当前快照中消失，但仍在监控基线中',
    );
  });

  it('ignores inBaseline when the account is missing', () => {
    const events = evaluateUserAlerts(account(), {
      inBaseline: false,
      missing: true,
    });
    expect(fingerprints(events)).toEqual(['user-present:gpu-01:alice']);
  });

  it('emits only user-added for a new healthy account', () => {
    const events = evaluateUserAlerts(account(), {
      inBaseline: false,
      missing: false,
    });
    expect(fingerprints(events)).toEqual(['user-added:gpu-01:alice']);
    expect(events[0].title).toBe('发现新账号');
    expect(events[0].message).toBe(
      '主机 gpu-01 发现新账号 alice，已加入监控基线',
    );
  });

  it('emits user-added plus true state alarms for a new unhealthy account', () => {
    const events = evaluateUserAlerts(account({ inDocker: false }), {
      inBaseline: false,
      missing: false,
    });
    expect(fingerprints(events)).toEqual([
      'user-added:gpu-01:alice',
      'user-docker:gpu-01:alice',
    ]);
  });

  it('emits nothing for a healthy existing account', () => {
    expect(
      evaluateUserAlerts(account(), { inBaseline: true, missing: false }),
    ).toEqual([]);
  });

  it.each([
    [{ inDocker: false }, 'user-docker:gpu-01:alice', '未加入 docker 组'],
    [{ homeExists: false, homeOwner: null }, 'user-home:gpu-01:alice', '家目录缺失'],
    [{ dataExists: false, dataOwner: null }, 'user-data:gpu-01:alice', '数据目录缺失'],
    [{ homeOwner: 'root' }, 'user-config:gpu-01:alice', '目录所有者异常'],
    [{ dataOwner: 'root' }, 'user-config:gpu-01:alice', '目录所有者异常'],
  ] as const)(
    'emits the expected state alarm for %o',
    (overrides, fingerprint, title) => {
      const events = evaluateUserAlerts(account(overrides), {
        inBaseline: true,
        missing: false,
      });
      expect(fingerprints(events)).toEqual([fingerprint]);
      const event = events[0];
      expect(event.title).toBe(title);
      expect(event.category).toBe('user');
      expect(event.severity).toBe('warning');
      expect(event.host_name).toBe('gpu-01');
      expect(event.message).toContain('gpu-01');
      expect(event.message).toContain('alice');
    },
  );

  it('suppresses user-data when the host has no /data', () => {
    const a = account({ dataSupported: false, dataExists: false, dataOwner: null });
    expect(
      evaluateUserAlerts(a, { inBaseline: true, missing: false }),
    ).toEqual([]);
  });

  it('ignores a stale data-owner mismatch when /data is unsupported', () => {
    const a = account({ dataSupported: false, dataExists: true, dataOwner: 'root' });
    expect(
      evaluateUserAlerts(a, { inBaseline: true, missing: false }),
    ).toEqual([]);
  });

  it('does not compare home owner when the home is missing', () => {
    const a = account({ homeExists: false, homeOwner: 'root' });
    expect(
      fingerprints(evaluateUserAlerts(a, { inBaseline: true, missing: false })),
    ).toEqual(['user-home:gpu-01:alice']);
  });

  it('emits exactly one user-config when both directories are mismatched', () => {
    const a = account({ homeOwner: 'root', dataOwner: 'root' });
    const events = evaluateUserAlerts(a, { inBaseline: true, missing: false });
    expect(fingerprints(events)).toEqual(['user-config:gpu-01:alice']);
    expect(events[0].message).toBe(
      '主机 gpu-01 的账号 alice 家目录 /home/alice 所有者为 root'
        + '；数据目录 /data/alice 所有者为 root，应为 alice',
    );
  });

  it('does not raise user-config for an unreadable (null) owner', () => {
    const a = account({ homeOwner: null, dataOwner: null });
    expect(
      evaluateUserAlerts(a, { inBaseline: true, missing: false }),
    ).toEqual([]);
  });

  it('uses the account host and username in every field', () => {
    const a = account({
      hostName: 'gpu-02',
      username: 'bob',
      home: '/home/bob',
      homeOwner: 'root',
      inDocker: false,
    });
    const events = evaluateUserAlerts(a, { inBaseline: true, missing: false });
    expect(fingerprints(events)).toEqual([
      'user-docker:gpu-02:bob',
      'user-config:gpu-02:bob',
    ]);
    expect(events.every((e) => e.host_name === 'gpu-02')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluate_disk_alerts
// ---------------------------------------------------------------------------

function drive(overrides: Partial<PhysicalDriveInfo> = {}): PhysicalDriveInfo {
  return { controller: 0, health: 'warning', ...overrides };
}

function vd(overrides: Partial<VirtualDriveInfo> = {}): VirtualDriveInfo {
  return { controller: 0, vd_id: 1, health: 'warning', ...overrides };
}

function report(overrides: Partial<DiskHealthReport> = {}): DiskHealthReport {
  return { host_name: 'gpu-01', collected_at: NOW, status: 'ok', ...overrides };
}

describe('evaluateDiskAlerts', () => {
  it('emits a warning event for a degraded physical drive', () => {
    const r = report({
      physical_drives: [
        drive({
          enclosure: 252,
          slot: 3,
          state: 'Onln',
          model: 'ST4000NM0035',
          serial: 'Z1F00ABC',
          health: 'warning',
          reasons: ['media_errors'],
        }),
      ],
    });
    const events = evaluateDiskAlerts(r);

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.category).toBe('disk');
    expect(event.severity).toBe('warning');
    expect(event.host_name).toBe('gpu-01');
    expect(event.fingerprint).toBe('disk:gpu-01:c0:e252:s3:media_errors');
    expect(event.reasons).toEqual(['media_errors']);
    expect(event.message).toBe(
      '物理盘 c0/e252/s3 健康状态 warning；原因：media_errors；'
        + '状态 Onln；型号 ST4000NM0035；序列号 Z1F00ABC',
    );
  });

  it('keeps the critical severity of a critical drive', () => {
    const r = report({
      physical_drives: [
        drive({
          controller: 1,
          enclosure: 252,
          slot: 9,
          state: 'Failed',
          health: 'critical',
          reasons: ['state_failed'],
        }),
      ],
    });
    const events = evaluateDiskAlerts(r);
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('critical');
    expect(events[0].fingerprint).toContain('c1:e252:s9');
  });

  it('uses the device id when a drive has no slot', () => {
    const r = report({
      physical_drives: [drive({ did: 7, health: 'warning', reasons: ['smart_flag'] })],
    });
    const events = evaluateDiskAlerts(r);
    expect(events).toHaveLength(1);
    expect(events[0].fingerprint).toBe('disk:gpu-01:c0:did7:smart_flag');
  });

  it('produces distinct fingerprints for multiple drives', () => {
    const r = report({
      physical_drives: [
        drive({ enclosure: 252, slot: 1, health: 'warning', reasons: ['media_errors'] }),
        drive({ enclosure: 252, slot: 2, health: 'critical', reasons: ['state_failed'] }),
      ],
    });
    const events = evaluateDiskAlerts(r);
    expect(events).toHaveLength(2);
    expect(new Set(fingerprints(events)).size).toBe(2);
  });

  it('emits a warning event for a degraded virtual drive', () => {
    const r = report({
      virtual_drives: [
        vd({
          controller: 0,
          vd_id: 1,
          raid_level: 'RAID1',
          state: 'Degraded',
          health: 'warning',
          reasons: ['state_degraded'],
        }),
      ],
    });
    const events = evaluateDiskAlerts(r);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('disk');
    expect(events[0].severity).toBe('warning');
    expect(events[0].fingerprint).toBe('disk:gpu-01:c0:vd1:state_degraded');
    expect(events[0].message).toBe(
      '虚拟盘 c0/vd1 健康状态 warning；RAID RAID1；状态 Degraded；'
        + '原因：state_degraded',
    );
  });

  it('does not alert when everything is healthy', () => {
    const r = report({
      physical_drives: [drive({ enclosure: 252, slot: 0, health: 'healthy' })],
      virtual_drives: [vd({ health: 'healthy' })],
    });
    expect(evaluateDiskAlerts(r)).toEqual([]);
  });

  it.each([
    'permission_denied',
    'no_storcli',
    'no_controller',
    'error',
    'degraded',
  ])('emits a warning for a non-ok report status: %s', (status) => {
    const r = report({ status, message: `无法检查磁盘健康：${status}` });
    const events = evaluateDiskAlerts(r);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('disk');
    expect(events[0].severity).toBe('warning');
    expect(events[0].fingerprint).toBe(`disk:gpu-01:status:${status}`);
    expect(events[0].message).toBe(`无法检查磁盘健康：${status}`);
  });

  it('falls back to a default status message when report.message is null', () => {
    const events = evaluateDiskAlerts(report({ status: 'error', message: null }));
    expect(events).toHaveLength(1);
    expect(events[0].message).toBe('主机 gpu-01 磁盘健康检查状态：error');
  });

  it('treats an omitted status as ok', () => {
    expect(evaluateDiskAlerts({ host_name: 'gpu-01' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// offline_alert / recovery_event
// ---------------------------------------------------------------------------

describe('offlineAlert', () => {
  it('builds a critical offline event with the failure count', () => {
    const event = offlineAlert('gpu-01', 3);
    expect(event.host_name).toBe('gpu-01');
    expect(event.category).toBe('offline');
    expect(event.severity).toBe('critical');
    expect(event.fingerprint).toBe('offline:gpu-01');
    expect(event.message).toBe('主机 gpu-01 连续 3 次采集失败，判定为离线。');
    expect(event.reasons).toEqual([]);
  });
});

describe('recoveryEvent', () => {
  it('builds an info recovery event for the category', () => {
    const event = recoveryEvent('gpu-01', 'disk');
    expect(event.host_name).toBe('gpu-01');
    expect(event.category).toBe('disk');
    expect(event.severity).toBe('info');
    expect(event.fingerprint).toBe('recovery:gpu-01:disk');
    expect(event.title).toBe('主机 gpu-01 disk 告警恢复');
    expect(event.message).toBe('主机 gpu-01 的 disk 告警已恢复。');
  });
});
