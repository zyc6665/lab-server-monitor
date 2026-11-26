/**
 * Declarative settings schema + pure validation for the admin settings API.
 *
 * This mirrors the behaviour of the Python oracle:
 *   - `servermanage/settings/schema.py`  (coercion / clamp helpers)
 *   - `servermanage/settings/sections.py` (per-section apply/sanitize rules)
 *   - `servermanage/models.py` + `servermanage/config.py` (default values)
 *
 * It is intentionally pure: no filesystem, no environment, no DB access.
 * `validateSection` never mutates its input; it returns a fresh merged object.
 */
import { ConfigError } from './errors';

export type FieldType = 'boolean' | 'integer' | 'number' | 'string' | 'string_list' | 'object';

/** One field inside a section payload. */
export interface FieldSpec {
  type: FieldType;
  default: unknown;
  /** Name used in error messages; defaults to the field key. */
  label?: string;
  min?: number;
  max?: number;
  /** Allowed enum values (compared after trim+lowercase). */
  options?: readonly string[];
  /** Text field that must be non-empty. */
  required?: boolean;
  /** Value is a credential and must never be echoed back in clear text. */
  secret?: boolean;
  /** Reject non-integer JSON numbers (mirrors Python `isinstance(value, int)`). */
  strictInt?: boolean;
  /** Strict boolean switch: never guess from strings (mirrors `_require_bool`). */
  strictBool?: boolean;
  /** Custom error message for {@link strictBool} failures. */
  boolMessage?: string;
  /** `compact` removes the space before 必须 (used by the user_monitoring labels). */
  messageStyle?: 'spaced' | 'compact';
  /** Child fields when {@link type} is `object`. */
  fields?: Record<string, FieldSpec>;
}

/** Metadata + field specs for one settings section. */
export interface SectionSpec {
  name: string;
  label: string;
  /** Whether saving this section requires an application restart. */
  restartRequired: boolean;
  fields: Record<string, FieldSpec>;
}

export interface SectionValidationResult {
  value: Record<string, unknown>;
  errors: string[];
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (isMapping(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = cloneValue(val);
    }
    return out;
  }
  return value;
}

function buildDefault(fields: Record<string, FieldSpec>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    out[key] = spec.type === 'object' ? buildDefault(spec.fields ?? {}) : cloneValue(spec.default);
  }
  return out;
}

const spaced = (spec: FieldSpec): boolean => (spec.messageStyle ?? 'spaced') === 'spaced';

function intMessage(label: string, spec: FieldSpec): string {
  return spaced(spec) ? `${label} 必须是整数` : `${label}必须是整数`;
}

function numberMessage(label: string, spec: FieldSpec): string {
  return spaced(spec) ? `${label} 必须是数字` : `${label}必须是数字`;
}

function rangeMessage(label: string, spec: FieldSpec, min: number, max: number): string {
  const head = spaced(spec) ? `${label} 必须在` : `${label}必须在`;
  return `${head} ${min} 到 ${max} 之间`;
}

function toIntLoose(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : undefined;
  }
  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!/^[+-]?\d+$/.test(text)) {
      return undefined;
    }
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toNumberLoose(raw: unknown): number | undefined {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (typeof raw === 'boolean') {
    return raw ? 1 : 0;
  }
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') {
      return undefined;
    }
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

interface CoerceResult {
  ok: boolean;
  value?: unknown;
}

function coerceField(key: string, spec: FieldSpec, raw: unknown, errors: string[]): CoerceResult {
  const label = spec.label ?? key;

  switch (spec.type) {
    case 'boolean': {
      if (spec.strictBool) {
        if (typeof raw !== 'boolean') {
          errors.push(spec.boolMessage ?? `${label}必须是 true 或 false`);
          return { ok: false };
        }
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string') {
        const flag = raw.trim().toLowerCase();
        return { ok: true, value: flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on' };
      }
      return { ok: true, value: Boolean(raw) };
    }

    case 'integer': {
      if (spec.strictInt) {
        if (typeof raw !== 'number' || !Number.isInteger(raw)) {
          errors.push(intMessage(label, spec));
          return { ok: false };
        }
        return checkRange(label, spec, raw as number, errors);
      }
      const n = toIntLoose(raw);
      if (n === undefined) {
        errors.push(intMessage(label, spec));
        return { ok: false };
      }
      return checkRange(label, spec, n, errors);
    }

    case 'number': {
      const n = toNumberLoose(raw);
      if (n === undefined) {
        errors.push(numberMessage(label, spec));
        return { ok: false };
      }
      return checkRange(label, spec, n, errors);
    }

    case 'string': {
      if (spec.options) {
        const text = typeof raw === 'string' ? raw : String(raw);
        const normalized = text.trim().toLowerCase();
        if (!spec.options.includes(normalized)) {
          errors.push(`${label} must be one of: ${spec.options.join(', ')}`);
          return { ok: false };
        }
        return { ok: true, value: normalized };
      }
      if (typeof raw === 'string') {
        if (spec.required && raw.trim() === '') {
          errors.push(`${label} 不能为空`);
          return { ok: false };
        }
        return { ok: true, value: raw };
      }
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return { ok: true, value: String(raw) };
      }
      errors.push(`${label} 不能为空`);
      return { ok: false };
    }

    case 'string_list': {
      if (Array.isArray(raw)) {
        const list = raw.map((item) => String(item).trim()).filter((item) => item !== '');
        return { ok: true, value: list };
      }
      if (typeof raw === 'string') {
        const list = raw
          .split(/[,;\n]/)
          .map((item) => item.trim())
          .filter((item) => item !== '');
        return { ok: true, value: list };
      }
      errors.push(`${label} 必须是字符串列表`);
      return { ok: false };
    }

    case 'object':
    default:
      return { ok: true, value: raw };
  }
}

function checkRange(label: string, spec: FieldSpec, n: number, errors: string[]): CoerceResult {
  const min = spec.min;
  const max = spec.max;
  if (min !== undefined && n < min) {
    errors.push(rangeMessage(label, spec, min, max ?? min));
    return { ok: false };
  }
  if (max !== undefined && n > max) {
    errors.push(rangeMessage(label, spec, min ?? max, max));
    return { ok: false };
  }
  return { ok: true, value: n };
}

function validateFields(
  fields: Record<string, FieldSpec>,
  payload: Record<string, unknown>,
  out: Record<string, unknown>,
  errors: string[],
): void {
  for (const [key, spec] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) {
      continue;
    }
    const raw = payload[key];
    if (raw === null) {
      // Python `_coerce_like` maps None to None; treat as "leave default".
      continue;
    }
    if (spec.type === 'object') {
      // The oracle only applies nested objects when the payload value is a dict;
      // a non-object value is silently ignored.
      if (!isMapping(raw)) {
        continue;
      }
      const current = out[key];
      const child = isMapping(current) ? current : {};
      validateFields(spec.fields ?? {}, raw, child, errors);
      out[key] = child;
      continue;
    }
    const result = coerceField(key, spec, raw, errors);
    if (result.ok) {
      out[key] = result.value;
    }
  }
}

function normalizeMonitoringMode(out: Record<string, unknown>, errors: string[]): void {
  // Mirrors servermanage/usermode.py: normalize_mode + normalize_member_account + validate_mode.
  const rawMode = out.mode;
  let mode = 'admin';
  if (typeof rawMode === 'string' && rawMode.trim() !== '') {
    const text = rawMode.trim().toLowerCase();
    if (text === 'admin' || text === 'user') {
      mode = text;
    } else {
      errors.push(`未知使用模式: ${rawMode}（只支持 admin / user）`);
    }
  }

  const rawMember = out.member_account;
  let member = '';
  if (rawMember !== undefined && rawMember !== null) {
    const text = String(rawMember).trim().toLowerCase();
    if (text !== '') {
      if (/^[a-z_][a-z0-9_-]{0,31}$/.test(text)) {
        member = text;
      } else {
        // Keep the (invalid) value so the "user mode needs an account" check does
        // not fire a second, misleading error — the oracle raises on the first.
        member = text;
        errors.push('账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头');
      }
    }
  }

  if (mode === 'user' && member === '') {
    errors.push('用户模式需要填写自己的服务器账号名');
  }

  out.mode = mode;
  out.member_account = member;
}

const monField = (
  type: FieldType,
  def: unknown,
  extra: Partial<FieldSpec> = {},
): FieldSpec => ({ type, default: def, ...extra });

const INT_RANGES: Record<string, [number, number]> = {
  host_metrics_max_points: [10, 10000],
  disk_health_retention_days: [1, 365],
  disk_health_max_batches: [1, 1000],
  host_daily_summary_retention_days: [7, 3650],
  alert_history_retention_days: [1, 3650],
  ssh_audit_retention_days: [1, 3650],
};

function monitoringFields(): Record<string, FieldSpec> {
  const fields: Record<string, FieldSpec> = {
    poll_interval_seconds: monField('integer', 600),
    disk_poll_interval_seconds: monField('integer', 86400),
    concurrency: monField('integer', 8),
    retention_days: monField('integer', 90),
  };
  const ranged: Record<string, number> = {
    host_metrics_max_points: 100,
    disk_health_retention_days: 7,
    disk_health_max_batches: 100,
    host_daily_summary_retention_days: 90,
    alert_history_retention_days: 30,
    ssh_audit_retention_days: 30,
  };
  for (const [key, def] of Object.entries(ranged)) {
    const [min, max] = INT_RANGES[key];
    fields[key] = monField('integer', def, { min, max });
  }
  fields.timezone = monField('string', 'Asia/Shanghai');
  fields.auto_port_fallback = monField('boolean', true);
  fields.tray_enabled = monField('boolean', true);
  fields.open_browser_on_start = monField('boolean', true);
  fields.mode = monField('string', 'admin');
  fields.member_account = monField('string', '');
  // P1-1 采集耗时: 单个采集阶段失败后的重试次数 (0-3, 默认 1)。
  fields.stage_retries = monField('integer', 1, {
    label: '采集阶段重试次数',
    min: 0,
    max: 3,
    strictInt: true,
  });
  return fields;
}

/** Per-section field specs, ordered the way the UI lists them. */
export const SETTINGS_SCHEMA: Record<string, SectionSpec> = {
  monitoring: {
    name: 'monitoring',
    label: '监控与存储',
    restartRequired: false,
    fields: monitoringFields(),
  },
  dashboard: {
    name: 'dashboard',
    label: '看板与安全',
    restartRequired: true,
    fields: {
      host: monField('string', '0.0.0.0'),
      port: monField('integer', 8080, { label: 'port' }),
      session_lifetime_hours: monField('integer', 12),
      auth: monField('object', null, {
        fields: {
          enabled: monField('boolean', true),
          username: monField('string', 'admin'),
          password_env: monField('string', 'DASHBOARD_PASSWORD'),
        },
      }),
    },
  },
  alerts: {
    name: 'alerts',
    label: '通知',
    restartRequired: false,
    fields: {
      enabled: monField('boolean', true),
      desktop_notification: monField('boolean', true),
      email: monField('boolean', true),
      cooldown_minutes: monField('integer', 60),
      repeat_while_active: monField('boolean', false),
      offline_failures: monField('integer', 2),
      aggregate_by_host: monField('boolean', true),
      notify_on_recovery: monField('boolean', true),
      consecutive_periods: monField('integer', 2, {
        label: 'alerts.consecutive_periods',
        min: 1,
        max: 10,
        strictInt: true,
      }),
      thresholds: monField('object', null, {
        fields: {
          cpu_percent: monField('number', 90),
          memory_percent: monField('number', 90),
          disk_percent: monField('number', 90),
          gpu_memory_percent: monField('number', 90),
          disk_temperature_c: monField('number', 55),
        },
      }),
      webhook: monField('object', null, {
        fields: {
          enabled: monField('boolean', false),
          type: monField('string', 'wecom'),
          url_env: monField('string', 'ALERT_WEBHOOK_URL'),
          url: monField('string', null, { secret: true }),
        },
      }),
    },
  },
  report: {
    name: 'report',
    label: '报告',
    restartRequired: false,
    fields: {
      subject_prefix: monField('string', '[Server Daily Report]'),
      include_failed_hosts: monField('boolean', true),
      daily_enabled: monField('boolean', true),
      daily_time: monField('string', '09:00'),
      weekly: monField('object', null, {
        fields: {
          enabled: monField('boolean', true),
          subject_prefix: monField('string', '[Server Weekly Report]'),
          busy_threshold: monField('number', 70),
          idle_threshold: monField('number', 20),
          time: monField('string', '16:00'),
          weekday: monField('integer', 4),
        },
      }),
      executive: monField('object', null, {
        fields: {
          enabled: monField('boolean', false, {
            strictBool: true,
            boolMessage: '管理层摘要版日报开关必须是 true 或 false',
          }),
          subject_prefix: monField('string', '[Leader Summary]'),
          to_addrs: monField('string_list', []),
        },
      }),
    },
  },
  disk_health: {
    name: 'disk_health',
    label: '磁盘健康',
    restartRequired: false,
    fields: {
      enabled: monField('boolean', true),
      use_sudo: monField('boolean', true),
      storcli_candidates: monField('string_list', [
        'storcli',
        'storcli64',
        '/opt/MegaRAID/storcli/storcli64',
        '/opt/lsi/storcli/storcli64',
        '/usr/local/bin/storcli',
        '/usr/sbin/storcli',
      ]),
      rules: monField('object', null, {
        fields: {
          alert_on_media_errors: monField('boolean', true),
          alert_on_other_errors: monField('boolean', true),
          alert_on_predictive_failure: monField('boolean', true),
          alert_on_smart_flag: monField('boolean', true),
          alert_on_state_not_optimal: monField('boolean', true),
          alert_on_error_increase: monField('boolean', true),
        },
      }),
    },
  },
  ssh: {
    name: 'ssh',
    label: 'SSH',
    restartRequired: false,
    fields: {
      connect_timeout: monField('integer', 10),
      command_timeout: monField('integer', 20),
      host_key_policy: monField('string', 'tofu', {
        label: 'ssh.host_key_policy',
        options: ['tofu', 'strict', 'insecure'],
      }),
    },
  },
  smtp: {
    name: 'smtp',
    label: '邮件服务器（SMTP）',
    restartRequired: false,
    fields: {
      host: monField('string', ''),
      port: monField('integer', 587, { label: 'port' }),
      username: monField('string', ''),
      password: monField('string', '', { secret: true }),
      use_ssl: monField('boolean', false),
      from_addr: monField('string', ''),
      to_addrs: monField('string_list', []),
    },
  },
  user_monitoring: {
    name: 'user_monitoring',
    label: '服务器用户采集',
    restartRequired: false,
    fields: {
      enabled: monField('boolean', true, {
        strictBool: true,
        boolMessage: '启用服务器用户采集必须是布尔值',
      }),
      scan_interval_seconds: monField('integer', 3600, {
        label: '账号扫描间隔',
        min: 300,
        max: 86400,
        strictInt: true,
        messageStyle: 'compact',
      }),
      usage_interval_seconds: monField('integer', 259200, {
        label: '占用统计间隔',
        min: 3600,
        max: 604800,
        strictInt: true,
        messageStyle: 'compact',
      }),
      usage_timeout_seconds: monField('integer', 1800, {
        label: '占用统计超时',
        min: 60,
        max: 7200,
        strictInt: true,
        messageStyle: 'compact',
      }),
      command_timeout: monField('integer', 120, {
        label: '单次命令超时',
        min: 10,
        max: 600,
        strictInt: true,
        messageStyle: 'compact',
      }),
      write_enabled: monField('boolean', false, {
        strictBool: true,
        boolMessage: '允许账号写操作必须是 true 或 false',
      }),
    },
  },
};

/** Section names in UI order (hosts is intentionally excluded; Task4 owns it). */
export const SECTION_NAMES: string[] = [
  'monitoring',
  'dashboard',
  'alerts',
  'report',
  'disk_health',
  'ssh',
  'smtp',
  'user_monitoring',
];

export function isKnownSection(section: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, section);
}

/** Fresh deep copy of a section's default payload. */
export function defaultSection(section: string): Record<string, unknown> {
  if (!isKnownSection(section)) {
    throw new ConfigError(`unknown settings section: ${section}`);
  }
  return buildDefault(SETTINGS_SCHEMA[section].fields);
}

/**
 * Validate + coerce a settings payload for one section.
 *
 * Returns the merged section object (defaults overlaid with the coerced payload)
 * plus a list of human-readable errors. The input is never mutated.
 */
export function validateSection(section: string, payload: unknown): SectionValidationResult {
  if (!isKnownSection(section)) {
    return { value: {}, errors: [`unknown settings section: ${section}`] };
  }
  if (!isMapping(payload)) {
    return { value: defaultSection(section), errors: ['settings payload must be an object'] };
  }

  const errors: string[] = [];
  const value = defaultSection(section);
  validateFields(SETTINGS_SCHEMA[section].fields, payload, value, errors);

  if (section === 'monitoring') {
    normalizeMonitoringMode(value, errors);
  }

  return { value, errors };
}

/** Like {@link validateSection} but throws {@link ConfigError} on invalid input. */
export function coerceSection(section: string, payload: unknown): Record<string, unknown> {
  const { value, errors } = validateSection(section, payload);
  if (errors.length > 0) {
    throw new ConfigError(errors.join('; '));
  }
  return value;
}

/** Coerce a TCP port to 1..65535 (mirrors `schema.py:_coerce_port`). */
export function coercePort(value: unknown): number {
  let port: number;
  if (typeof value === 'number' && Number.isFinite(value)) {
    port = Math.trunc(value);
  } else if (typeof value === 'string' && /^[+-]?\d+$/.test(value.trim())) {
    port = Number(value.trim());
  } else {
    throw new ConfigError('port 必须是整数');
  }
  if (!(port >= 1 && port <= 65535)) {
    throw new ConfigError('port 超出范围');
  }
  return port;
}
