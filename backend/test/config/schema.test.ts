import { describe, it, expect } from 'vitest';

import { ConfigError } from '../../src/config/errors';
import {
  SETTINGS_SCHEMA,
  SECTION_NAMES,
  validateSection,
  coerceSection,
  coercePort,
  isKnownSection,
} from '../../src/config/schema';

describe('SETTINGS_SCHEMA', () => {
  it('declares all eight sections with metadata', () => {
    expect(SECTION_NAMES).toHaveLength(8);
    for (const name of SECTION_NAMES) {
      const spec = SETTINGS_SCHEMA[name];
      expect(spec).toBeDefined();
      expect(spec.name).toBe(name);
      expect(typeof spec.label).toBe('string');
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.restartRequired).toBe(name === 'dashboard');
    }
  });

  it('marks secret fields', () => {
    expect(SETTINGS_SCHEMA.smtp.fields.password.secret).toBe(true);
    expect(SETTINGS_SCHEMA.alerts.fields.webhook.fields?.url.secret).toBe(true);
  });

  it('recognises known sections only', () => {
    expect(isKnownSection('monitoring')).toBe(true);
    expect(isKnownSection('hosts')).toBe(false);
    expect(isKnownSection('nope')).toBe(false);
  });
});

describe('validateSection - monitoring', () => {
  it('coerces numeric strings and fills defaults', () => {
    const { value, errors } = validateSection('monitoring', { poll_interval_seconds: '1200' });
    expect(errors).toEqual([]);
    expect(value.poll_interval_seconds).toBe(1200);
    expect(value.concurrency).toBe(8);
    expect(value.timezone).toBe('Asia/Shanghai');
  });

  it('enforces the documented integer ranges', () => {
    expect(validateSection('monitoring', { host_metrics_max_points: 5 }).errors).toEqual([
      'host_metrics_max_points 必须在 10 到 10000 之间',
    ]);
    expect(validateSection('monitoring', { disk_health_retention_days: 366 }).errors).toEqual([
      'disk_health_retention_days 必须在 1 到 365 之间',
    ]);
    expect(validateSection('monitoring', { alert_history_retention_days: 'abc' }).errors).toEqual([
      'alert_history_retention_days 必须是整数',
    ]);
  });

  it('allows fields without a range to pass any integer', () => {
    const { value, errors } = validateSection('monitoring', {
      poll_interval_seconds: 30,
      concurrency: 99,
      retention_days: 1,
    });
    expect(errors).toEqual([]);
    expect(value.poll_interval_seconds).toBe(30);
    expect(value.concurrency).toBe(99);
    expect(value.retention_days).toBe(1);
  });

  it('validates and normalises the usage mode', () => {
    expect(validateSection('monitoring', { mode: 'user' }).errors).toEqual([
      '用户模式需要填写自己的服务器账号名',
    ]);
    expect(validateSection('monitoring', { mode: 'root' }).errors).toEqual([
      '未知使用模式: root（只支持 admin / user）',
    ]);

    const ok = validateSection('monitoring', { mode: 'USER', member_account: 'Alice' });
    expect(ok.errors).toEqual([]);
    expect(ok.value.mode).toBe('user');
    expect(ok.value.member_account).toBe('alice');
  });

  it('rejects invalid member accounts', () => {
    const { errors } = validateSection('monitoring', {
      mode: 'user',
      member_account: '1bad',
    });
    expect(errors).toEqual(['账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头']);
  });
});

describe('validateSection - alerts', () => {
  it('rejects out-of-range consecutive_periods instead of clamping', () => {
    expect(validateSection('alerts', { consecutive_periods: 0 }).errors).toEqual([
      'alerts.consecutive_periods 必须在 1 到 10 之间',
    ]);
    expect(validateSection('alerts', { consecutive_periods: 11 }).errors).toEqual([
      'alerts.consecutive_periods 必须在 1 到 10 之间',
    ]);
  });

  it('treats consecutive_periods strictly (no string coercion)', () => {
    expect(validateSection('alerts', { consecutive_periods: '3' }).errors).toEqual([
      'alerts.consecutive_periods 必须是整数',
    ]);
    expect(validateSection('alerts', { consecutive_periods: true }).errors).toEqual([
      'alerts.consecutive_periods 必须是整数',
    ]);
  });

  it('accepts a valid period and keeps defaults', () => {
    const { value, errors } = validateSection('alerts', { consecutive_periods: 5 });
    expect(errors).toEqual([]);
    expect(value.consecutive_periods).toBe(5);
    expect((value.thresholds as Record<string, unknown>).cpu_percent).toBe(90);
  });

  it('coerces threshold numbers without range checks (oracle has none)', () => {
    const { value, errors } = validateSection('alerts', {
      thresholds: { cpu_percent: '95', disk_temperature_c: 60 },
    });
    expect(errors).toEqual([]);
    const thresholds = value.thresholds as Record<string, unknown>;
    expect(thresholds.cpu_percent).toBe(95);
    expect(thresholds.disk_temperature_c).toBe(60);
    expect(thresholds.memory_percent).toBe(90);
  });

  it('ignores unknown keys', () => {
    const { value, errors } = validateSection('alerts', { bogus: 1 });
    expect(errors).toEqual([]);
    expect(value).not.toHaveProperty('bogus');
  });
});

describe('validateSection - ssh', () => {
  it('defaults host_key_policy to tofu and normalises case', () => {
    const { value, errors } = validateSection('ssh', {});
    expect(errors).toEqual([]);
    expect(value).toEqual({ connect_timeout: 10, command_timeout: 20, host_key_policy: 'tofu' });

    const upper = validateSection('ssh', { host_key_policy: 'STRICT' });
    expect(upper.errors).toEqual([]);
    expect(upper.value.host_key_policy).toBe('strict');
  });

  it('rejects an unknown host_key_policy with the oracle message', () => {
    const { errors } = validateSection('ssh', { host_key_policy: 'nope' });
    expect(errors).toEqual(['ssh.host_key_policy must be one of: tofu, strict, insecure']);
  });

  it('coerces timeouts to integers', () => {
    const { value, errors } = validateSection('ssh', {
      connect_timeout: '30',
      command_timeout: 40.9,
    });
    expect(errors).toEqual([]);
    expect(value.connect_timeout).toBe(30);
    expect(value.command_timeout).toBe(40);
  });
});

describe('validateSection - smtp', () => {
  it('coerces port and splits a string recipient list', () => {
    const { value, errors } = validateSection('smtp', {
      port: '2525',
      from_addr: 'bot@example.com',
      to_addrs: 'a@x.com, b@y.com',
    });
    expect(errors).toEqual([]);
    expect(value.port).toBe(2525);
    expect(value.to_addrs).toEqual(['a@x.com', 'b@y.com']);
    expect(value.use_ssl).toBe(false);
  });

  it('rejects a non-integer port with the port message', () => {
    expect(validateSection('smtp', { port: 'abc' }).errors).toEqual(['port 必须是整数']);
  });

  it('normalises an array recipient list (trim, drop blanks)', () => {
    const { value } = validateSection('smtp', { to_addrs: [' x@y.com ', '', 'z@w.com'] });
    expect(value.to_addrs).toEqual(['x@y.com', 'z@w.com']);
  });
});

describe('validateSection - dashboard / report / disk_health / user_monitoring', () => {
  it('merges nested auth and coerces the dashboard port', () => {
    const { value, errors } = validateSection('dashboard', {
      port: '9000',
      auth: { username: 'root' },
    });
    expect(errors).toEqual([]);
    expect(value.port).toBe(9000);
    const auth = value.auth as Record<string, unknown>;
    expect(auth.username).toBe('root');
    expect(auth.enabled).toBe(true);
    expect(auth.password_env).toBe('DASHBOARD_PASSWORD');
  });

  it('deep-merges weekly report overrides', () => {
    const { value, errors } = validateSection('report', {
      weekly: { busy_threshold: '80', enabled: false },
    });
    expect(errors).toEqual([]);
    const weekly = value.weekly as Record<string, unknown>;
    expect(weekly.busy_threshold).toBe(80);
    expect(weekly.enabled).toBe(false);
    expect(weekly.idle_threshold).toBe(20);
    expect(weekly.subject_prefix).toBe('[Server Weekly Report]');
  });

  it('merges disk_health rule overrides and coerces storcli candidates', () => {
    const { value, errors } = validateSection('disk_health', {
      use_sudo: false,
      storcli_candidates: ['/usr/bin/storcli'],
      rules: { alert_on_smart_flag: false },
    });
    expect(errors).toEqual([]);
    expect(value.use_sudo).toBe(false);
    expect(value.storcli_candidates).toEqual(['/usr/bin/storcli']);
    const rules = value.rules as Record<string, unknown>;
    expect(rules.alert_on_smart_flag).toBe(false);
    expect(rules.alert_on_media_errors).toBe(true);
  });

  it('validates user_monitoring integers strictly with the oracle messages', () => {
    const rangeErr = validateSection('user_monitoring', { scan_interval_seconds: 100 });
    expect(rangeErr.errors).toEqual(['账号扫描间隔必须在 300 到 86400 之间']);

    const intErr = validateSection('user_monitoring', { command_timeout: '120' });
    expect(intErr.errors).toEqual(['单次命令超时必须是整数']);

    const ok = validateSection('user_monitoring', { command_timeout: 300 });
    expect(ok.errors).toEqual([]);
    expect(ok.value.command_timeout).toBe(300);
  });

  it('requires user_monitoring.write_enabled to be a strict boolean', () => {
    expect(validateSection('user_monitoring', { write_enabled: 'yes' }).errors).toEqual([
      '允许账号写操作必须是 true 或 false',
    ]);
  });
});

describe('validateSection - structural guards', () => {
  it('reports an unknown section', () => {
    const { value, errors } = validateSection('nope', {});
    expect(errors).toEqual(['unknown settings section: nope']);
    expect(value).toEqual({});
  });

  it('reports a non-object payload', () => {
    expect(validateSection('ssh', null).errors).toEqual(['settings payload must be an object']);
    expect(validateSection('ssh', 'x').errors).toEqual(['settings payload must be an object']);
    expect(validateSection('ssh', []).errors).toEqual(['settings payload must be an object']);
  });

  it('does not mutate the input payload', () => {
    const payload = { monitoring: {}, nested: { a: 1 } };
    validateSection('monitoring', payload.monitoring);
    expect(payload).toEqual({ monitoring: {}, nested: { a: 1 } });
  });
});

describe('coerceSection', () => {
  it('returns the coerced value for a valid payload', () => {
    const value = coerceSection('ssh', { connect_timeout: '30' });
    expect(value.connect_timeout).toBe(30);
  });

  it('throws ConfigError for an invalid payload', () => {
    expect(() => coerceSection('monitoring', { host_metrics_max_points: 1 })).toThrow(ConfigError);
  });
});

describe('coercePort', () => {
  it('accepts 1..65535 and rejects the rest with the oracle messages', () => {
    expect(coercePort('22')).toBe(22);
    expect(coercePort(65535)).toBe(65535);
    expect(() => coercePort('abc')).toThrow('port 必须是整数');
    expect(() => coercePort(0)).toThrow('port 超出范围');
    expect(() => coercePort(70000)).toThrow('port 超出范围');
  });
});
