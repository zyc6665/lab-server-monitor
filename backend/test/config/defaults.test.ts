import { describe, it, expect } from 'vitest';

import { DEFAULT_SETTINGS, defaultSection, SECTION_NAMES } from '../../src/config/defaults';

describe('DEFAULT_SETTINGS', () => {
  it('exposes exactly the eight configurable sections (hosts is owned elsewhere)', () => {
    expect(SECTION_NAMES).toEqual([
      'monitoring',
      'dashboard',
      'alerts',
      'report',
      'disk_health',
      'ssh',
      'smtp',
      'user_monitoring',
    ]);
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual([...SECTION_NAMES].sort());
    expect(DEFAULT_SETTINGS).not.toHaveProperty('hosts');
  });

  it('monitoring mirrors AppRuntimeConfig defaults', () => {
    expect(DEFAULT_SETTINGS.monitoring).toEqual({
      poll_interval_seconds: 600,
      disk_poll_interval_seconds: 86400,
      concurrency: 8,
      retention_days: 90,
      host_metrics_max_points: 100,
      disk_health_retention_days: 7,
      disk_health_max_batches: 100,
      host_daily_summary_retention_days: 90,
      alert_history_retention_days: 30,
      ssh_audit_retention_days: 30,
      timezone: 'Asia/Shanghai',
      auto_port_fallback: true,
      tray_enabled: true,
      open_browser_on_start: true,
      mode: 'admin',
      member_account: '',
      stage_retries: 1,
    });
  });

  it('ssh mirrors SSHRuntimeConfig defaults', () => {
    expect(DEFAULT_SETTINGS.ssh).toEqual({
      connect_timeout: 10,
      command_timeout: 20,
      host_key_policy: 'tofu',
    });
  });

  it('alerts mirrors AlertsConfig including nested thresholds and webhook', () => {
    expect(DEFAULT_SETTINGS.alerts).toEqual({
      enabled: true,
      desktop_notification: true,
      email: true,
      cooldown_minutes: 60,
      repeat_while_active: false,
      offline_failures: 2,
      aggregate_by_host: true,
      notify_on_recovery: true,
      consecutive_periods: 2,
      thresholds: {
        cpu_percent: 90,
        memory_percent: 90,
        disk_percent: 90,
        gpu_memory_percent: 90,
        disk_temperature_c: 55,
      },
      webhook: {
        enabled: false,
        type: 'wecom',
        url_env: 'ALERT_WEBHOOK_URL',
        url: null,
      },
    });
  });

  it('dashboard mirrors DashboardConfig with nested auth', () => {
    expect(DEFAULT_SETTINGS.dashboard).toEqual({
      host: '0.0.0.0',
      port: 8080,
      session_lifetime_hours: 12,
      auth: {
        enabled: true,
        username: 'admin',
        password_env: 'DASHBOARD_PASSWORD',
      },
    });
  });

  it('smtp uses the empty/587 public defaults', () => {
    expect(DEFAULT_SETTINGS.smtp).toEqual({
      host: '',
      port: 587,
      username: '',
      password: '',
      use_ssl: false,
      from_addr: '',
      to_addrs: [],
    });
  });

  it('report mirrors ReportConfig plus weekly and executive defaults', () => {
    expect(DEFAULT_SETTINGS.report).toEqual({
      subject_prefix: '[Server Daily Report]',
      include_failed_hosts: true,
      daily_enabled: true,
      daily_time: '09:00',
      weekly: {
        enabled: true,
        subject_prefix: '[Server Weekly Report]',
        busy_threshold: 70,
        idle_threshold: 20,
        time: '16:00',
        weekday: 4,
      },
      executive: {
        enabled: false,
        subject_prefix: '[Leader Summary]',
        to_addrs: [],
      },
    });
  });

  it('disk_health mirrors DiskHealthConfig with storcli candidates and rules', () => {
    expect(DEFAULT_SETTINGS.disk_health).toEqual({
      enabled: true,
      use_sudo: true,
      storcli_candidates: [
        'storcli',
        'storcli64',
        '/opt/MegaRAID/storcli/storcli64',
        '/opt/lsi/storcli/storcli64',
        '/usr/local/bin/storcli',
        '/usr/sbin/storcli',
      ],
      rules: {
        alert_on_media_errors: true,
        alert_on_other_errors: true,
        alert_on_predictive_failure: true,
        alert_on_smart_flag: true,
        alert_on_state_not_optimal: true,
        alert_on_error_increase: true,
      },
    });
  });

  it('user_monitoring mirrors UserMonitoringConfig defaults', () => {
    expect(DEFAULT_SETTINGS.user_monitoring).toEqual({
      enabled: true,
      scan_interval_seconds: 3600,
      usage_interval_seconds: 259200,
      usage_timeout_seconds: 1800,
      command_timeout: 120,
      write_enabled: false,
      account_policy: {
        naming_regex: '^[a-z][a-z0-9_-]{2,15}$',
        templates: [
          { name: 'standard', description: '标准账号（默认附加组）', groups: [], sudo: [] },
          { name: 'developer', description: '开发账号（附加组 + sudo 白名单）', groups: ['developers'], sudo: ['systemctl restart jupyter'] },
          { name: 'readonly', description: '只读账号（仅家目录）', groups: [], sudo: [] },
        ],
        default_template: 'standard',
        expiry_days: 0,
      },
    });
  });

  it('defaultSection returns a deep clone that callers may mutate safely', () => {
    const first = defaultSection('alerts');
    (first.thresholds as Record<string, unknown>).cpu_percent = 1;
    (first as Record<string, unknown>).new_key = true;

    const second = defaultSection('alerts');
    expect((second.thresholds as Record<string, unknown>).cpu_percent).toBe(90);
    expect(second).not.toHaveProperty('new_key');
    // the pristine snapshot is untouched
    expect((DEFAULT_SETTINGS.alerts.thresholds as Record<string, unknown>).cpu_percent).toBe(90);
  });

  it('defaultSection throws for unknown sections', () => {
    expect(() => defaultSection('nope')).toThrow(/unknown settings section/);
  });
});
