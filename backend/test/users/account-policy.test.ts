import { describe, expect, it } from 'vitest';

import type { HostConfig } from '../../src/config/config';
import {
  buildPlan,
  type AccountPolicy,
} from '../../src/users/admin';
import { hostToBuildPlanParams } from '../../src/users/execute-service';

const NOW = new Date('2026-01-02T03:04:05.678Z');

const policy: AccountPolicy = {
  naming_regex: '^[a-z][a-z0-9_-]{2,15}$',
  default_template: 'developer',
  expiry_days: 90,
  templates: [
    { name: 'standard', description: '标准', groups: [], sudo: [] },
    { name: 'developer', description: '开发', groups: ['developers'], sudo: ['systemctl restart jupyter'] },
  ],
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'create',
    host_name: 'gpu-01',
    account: 'alice',
    account_exists: false,
    sudoOk: true,
    now: NOW,
    ...overrides,
  } as Parameters<typeof buildPlan>[0];
}

describe('buildPlan — account policy', () => {
  it('adds no steps for the empty standard template', () => {
    const plan = buildPlan({
      ...base(),
      policy: { ...policy, default_template: 'standard', expiry_days: 0 },
    });
    const ids = plan.steps.map((s) => s.id);
    expect(ids).toEqual(['useradd', 'chpasswd', 'docker', 'data', 'verify-id', 'verify-data']);
    expect(plan.blocked).toBe(false);
  });

  it('adds group + sudoers steps for the developer template', () => {
    const plan = buildPlan({ ...base(), policy });
    const steps = plan.steps.map((s) => s.command).join('\n');
    expect(steps).toContain('gpasswd -a alice developers');
    expect(steps).toContain('/etc/sudoers.d/alice');
    expect(steps).toContain('NOPASSWD: systemctl restart jupyter');
  });

  it('adds a chage expiry step computed in UTC', () => {
    const plan = buildPlan({ ...base(), policy });
    const expiry = plan.steps.find((s) => s.id === 'expiry');
    expect(expiry).toBeDefined();
    // 2026-01-02 + 90 days = 2026-04-02
    expect(expiry?.command).toBe('chage -E 2026-04-02 alice');
  });

  it('blocks a name that fails the naming_regex', () => {
    const plan = buildPlan({ ...base({ account: 'ab' }), policy });
    expect(plan.blocked).toBe(true);
    expect(plan.blocked_reasons.join('\n')).toContain('账号名不符合命名规范');
  });

  it('blocks a leading-underscore name that passes the legacy validator', () => {
    const plan = buildPlan({ ...base({ account: '_leader' }), policy });
    expect(plan.blocked).toBe(true);
  });

  it('does not block a compliant name', () => {
    const plan = buildPlan({ ...base({ account: 'alice-01' }), policy });
    expect(plan.blocked).toBe(false);
  });

  it('includes template/expiry content in plan_hash (step-derived)', () => {
    const withPolicy = buildPlan({ ...base(), policy });
    const withoutPolicy = buildPlan({ ...base(), policy: null });
    expect(withPolicy.plan_hash).not.toBe(withoutPolicy.plan_hash);
  });
});

describe('hostToBuildPlanParams — policy passthrough', () => {
  const server = { name: 'gpu-01', host: '10.0.0.1', sudo_password: 'x' } as unknown as HostConfig;

  it('forwards accountPolicy into buildPlan params', () => {
    const params = hostToBuildPlanParams(server, 'create', {
      account: 'alice',
      accountPolicy: policy,
    });
    expect(params.policy).toBe(policy);
  });

  it('defaults policy to undefined when not supplied', () => {
    const params = hostToBuildPlanParams(server, 'create', { account: 'alice' });
    expect(params.policy).toBeUndefined();
  });
});
