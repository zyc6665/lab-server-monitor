import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import { SETTINGS_SCHEMA, validateSection } from '../../src/config/schema';

const policy = DEFAULT_SETTINGS.user_monitoring.account_policy as Record<string, unknown>;

describe('account_policy defaults', () => {
  it('ships the three built-in templates', () => {
    const templates = policy.templates as Array<Record<string, unknown>>;
    expect(templates.map((t) => t.name)).toEqual(['standard', 'developer', 'readonly']);
    expect(templates[1].groups).toEqual(['developers']);
    expect(templates[1].sudo).toEqual(['systemctl restart jupyter']);
    expect(templates[2].groups).toEqual([]);
    expect(policy.default_template).toBe('standard');
    expect(policy.expiry_days).toBe(0);
    expect(policy.naming_regex).toBe('^[a-z][a-z0-9_-]{2,15}$');
  });

  it('declares account_policy on the user_monitoring section', () => {
    expect(Object.keys(SETTINGS_SCHEMA.user_monitoring.fields)).toContain('account_policy');
  });
});

describe('validateSection — account_policy', () => {
  it('accepts a valid policy and coerces comma-separated groups', () => {
    const { value, errors } = validateSection('user_monitoring', {
      account_policy: {
        naming_regex: '^[a-z]{3,8}$',
        default_template: 'dev',
        expiry_days: 90,
        templates: [{ name: 'dev', description: '开发', groups: 'a, b', sudo: 'x; y' }],
      },
    });
    expect(errors).toEqual([]);
    const ap = value.account_policy as Record<string, unknown>;
    expect(ap.expiry_days).toBe(90);
    expect(ap.naming_regex).toBe('^[a-z]{3,8}$');
    const tpl = (ap.templates as Array<Record<string, unknown>>)[0];
    expect(tpl.groups).toEqual(['a', 'b']);
    expect(tpl.sudo).toEqual(['x', 'y']);
  });

  it('rejects a non-array templates value', () => {
    const { errors } = validateSection('user_monitoring', {
      account_policy: { templates: 'standard' },
    });
    expect(errors.some((e) => e.includes('必须是列表'))).toBe(true);
  });

  it('rejects non-object template entries', () => {
    const { errors } = validateSection('user_monitoring', {
      account_policy: { templates: ['standard'] },
    });
    expect(errors.some((e) => e.includes('每一项必须是对象'))).toBe(true);
  });

  it('clamps expiry_days into range', () => {
    const tooBig = validateSection('user_monitoring', {
      account_policy: { expiry_days: 99999 },
    });
    expect(tooBig.errors.some((e) => e.includes('有效期天数'))).toBe(true);
    const negative = validateSection('user_monitoring', {
      account_policy: { expiry_days: -1 },
    });
    expect(negative.errors.length).toBeGreaterThan(0);
  });
});
