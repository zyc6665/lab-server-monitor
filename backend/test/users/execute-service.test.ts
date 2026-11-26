import { describe, it, expect } from 'vitest';

import type { HostConfig } from '../../src/config/config';
import { AdminPlanError, COMMAND_TIMEOUT_SECONDS } from '../../src/users/admin';
import type { UsersAdminApi } from '../../src/web/routes/users';
import {
  createSshPlanRunner,
  createUsersAdminApi,
  createUsersExecuteRunner,
  hostToBuildPlanParams,
  resolveServer,
  type PlanSshClient,
} from '../../src/users/execute-service';

type Obj = Record<string, unknown>;

function makeServer(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name: 'alpha',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: true,
    sudo_password: 'sudopw',
    ...overrides,
  };
}

function makeApi(servers: HostConfig[] = [makeServer()]): UsersAdminApi {
  return createUsersAdminApi({ servers });
}

/** Build the masked job the users route enqueues (steps minus `stdin`). */
function makeJob(plan: Obj): Obj {
  const source = Array.isArray(plan['steps']) ? (plan['steps'] as Obj[]) : [];
  const steps = source.map((step) => {
    const copy: Obj = {};
    for (const [key, value] of Object.entries(step)) {
      if (key !== 'stdin') copy[key] = value;
    }
    return copy;
  });
  return {
    id: 'job-1',
    host: plan['host'],
    account: plan['account'],
    operation: plan['operation'],
    actor: 'admin',
    state: 'running',
    ok: null,
    error: '',
    steps,
    started_at: '',
    finished_at: null,
    _ts: 0,
  };
}

function buildCreatePlan(api: UsersAdminApi): Obj {
  return api.buildPlan('create', {
    hostName: 'alpha',
    account: 'newacct',
    accountExists: false,
    sudoOk: true,
    dataSupported: true,
    withDocker: true,
    withData: true,
  });
}

interface CallRecord {
  command: string;
  timeoutMs: number;
}

interface SudoCallRecord extends CallRecord {
  password: string;
  stdinData: string | null | undefined;
}

/** Fake SSH client: scripted exit codes, records every call (incl. timeout). */
class FakePlanClient implements PlanSshClient {
  readonly runCalls: CallRecord[] = [];
  readonly sudoCalls: SudoCallRecord[] = [];
  closeCalls = 0;
  private index = 0;

  constructor(
    private readonly script: Array<{ exitStatus: number; stdout?: string; stderr?: string }> = [],
  ) {}

  async run(command: string, timeoutMs: number): Promise<{ exitStatus: number; stdout: string; stderr: string }> {
    this.runCalls.push({ command, timeoutMs });
    return this.next();
  }

  async runSudo(
    command: string,
    password: string,
    timeoutMs: number,
    stdinData?: string | null,
  ): Promise<{ exitStatus: number; stdout: string; stderr: string }> {
    this.sudoCalls.push({ command, password, timeoutMs, stdinData });
    return this.next();
  }

  close(): void {
    this.closeCalls += 1;
  }

  private next(): { exitStatus: number; stdout: string; stderr: string } {
    const current = this.index;
    this.index += 1;
    return this.script[current] ?? { exitStatus: 0, stdout: 'ok', stderr: '' };
  }
}

function stepById(job: Obj, id: string): Obj | undefined {
  const steps = Array.isArray(job['steps']) ? (job['steps'] as Obj[]) : [];
  return steps.find((step) => step['id'] === id);
}

// ---------------------------------------------------------------------------
// Planner adapter
// ---------------------------------------------------------------------------

describe('createUsersAdminApi', () => {
  it('builds a plan and publicPlan strips the stdin secret', () => {
    const api = makeApi();
    const plan = buildCreatePlan(api);

    const steps = plan['steps'] as Obj[];
    expect(steps.length).toBeGreaterThan(2);
    // The server-side plan carries the chpasswd payload on `stdin`...
    const chpasswd = steps.find((step) => step['id'] === 'chpasswd');
    expect(typeof chpasswd?.['stdin']).toBe('string');
    expect(String(chpasswd?.['stdin'])).toContain('newacct:');

    // ...but the browser-facing plan never does.
    const pub = api.publicPlan(plan);
    const pubSteps = pub['steps'] as Obj[];
    expect(pubSteps).toHaveLength(steps.length);
    for (const step of pubSteps) {
      expect(Object.prototype.hasOwnProperty.call(step, 'stdin')).toBe(false);
    }
    expect(JSON.stringify(pub)).not.toContain(String(chpasswd?.['stdin']));
  });

  it('raises AdminPlanError for an unknown host', () => {
    const api = makeApi();
    expect(() => api.buildPlan('create', { hostName: 'ghost', account: 'newacct' })).toThrow(
      AdminPlanError,
    );
    expect(() => api.buildPlan('create', { hostName: 'ghost', account: 'newacct' })).toThrow(
      '未知主机',
    );
  });

  it('maps camelCase route options onto snake_case build params', () => {
    const server = makeServer({ sudo_password: '' });
    const params = hostToBuildPlanParams(server, 'create', {
      account: 'newacct',
      accountExists: true,
      sudoOk: false,
      withDocker: false,
      withData: false,
      dataSupported: false,
    });
    expect(params).toMatchObject({
      operation: 'create',
      host_name: 'alpha',
      account: 'newacct',
      account_exists: true,
      sudo_configured: false,
      with_docker: false,
      with_data: false,
      data_supported: false,
      password: null,
    });
    expect(resolveServer({ servers: [server] }, 'alpha')).toBe(server);
  });
});

// ---------------------------------------------------------------------------
// SSH runner adapter
// ---------------------------------------------------------------------------

describe('createSshPlanRunner', () => {
  it('converts seconds to milliseconds, uses server sudo password and forwards stdin', async () => {
    const server = makeServer({ sudo_password: 'sekret' });
    const client = new FakePlanClient();
    const runner = createSshPlanRunner(server, client);

    await runner.run('id -u', 30);
    await runner.run_sudo('chpasswd', 45, { stdin_data: 'newacct:hunter2' });

    expect(client.runCalls).toEqual([{ command: 'id -u', timeoutMs: 30_000 }]);
    expect(client.sudoCalls).toEqual([
      {
        command: 'chpasswd',
        password: 'sekret',
        timeoutMs: 45_000,
        stdinData: 'newacct:hunter2',
      },
    ]);
  });

  it('maps the client exitStatus onto the plan result shape', async () => {
    const client = new FakePlanClient([{ exitStatus: 3, stdout: 'out', stderr: 'err' }]);
    const runner = createSshPlanRunner(makeServer(), client);
    const result = await runner.run('false', 1);
    expect(result).toEqual({ exit_status: 3, stdout: 'out', stderr: 'err' });
  });
});

// ---------------------------------------------------------------------------
// Background executor
// ---------------------------------------------------------------------------

describe('createUsersExecuteRunner', () => {
  it('runs every step and finishes the job as success', async () => {
    const server = makeServer();
    const api = makeApi([server]);
    const plan = buildCreatePlan(api);
    const job = makeJob(plan);
    const client = new FakePlanClient();
    const runner = createUsersExecuteRunner({
      config: { servers: [server] },
      makeClient: () => client,
      commandTimeoutSec: 30,
      now: () => new Date('2026-01-02T03:04:05.678Z'),
    });

    await runner(job, plan);

    expect(job['state']).toBe('done');
    expect(job['ok']).toBe(true);
    expect(job['error']).toBe('');
    expect(job['finished_at']).toBe('2026-01-02T03:04:05.678000+00:00');
    expect(client.closeCalls).toBe(1);

    const steps = job['steps'] as Obj[];
    for (const step of steps) {
      expect(step['status']).toBe('ok');
      expect(step['exit_status']).toBe(0);
    }
    // chpasswd ran through sudo and received its stdin payload.
    const chpasswdCall = client.sudoCalls.find((call) => call.command === 'chpasswd');
    expect(chpasswdCall).toBeDefined();
    expect(String(chpasswdCall?.stdinData)).toContain('newacct:');
    // Timeout conversion: 30s config -> 30_000ms on the wire.
    expect(client.sudoCalls[0]?.timeoutMs).toBe(30_000);
    expect(client.runCalls[0]?.timeoutMs).toBe(30_000);
  });

  it('marks the failing step failed and records stderr', async () => {
    const server = makeServer();
    const api = makeApi([server]);
    const plan = buildCreatePlan(api);
    const job = makeJob(plan);
    // Call 0 (useradd) succeeds, call 1 (chpasswd) fails.
    const client = new FakePlanClient([
      { exitStatus: 0 },
      { exitStatus: 7, stdout: '', stderr: 'chpasswd: boom' },
    ]);
    const runner = createUsersExecuteRunner({
      config: { servers: [server] },
      makeClient: () => client,
    });

    await runner(job, plan);

    expect(job['state']).toBe('done');
    expect(job['ok']).toBe(false);
    expect(String(job['error'])).toContain('退出码 7');
    expect(client.closeCalls).toBe(1);

    expect(stepById(job, 'useradd')?.['status']).toBe('ok');
    const chpasswd = stepById(job, 'chpasswd');
    expect(chpasswd?.['status']).toBe('failed');
    expect(chpasswd?.['exit_status']).toBe(7);
    expect(chpasswd?.['stderr']).toContain('chpasswd: boom');
    // Steps after the failure are not executed and stay status-less.
    expect(stepById(job, 'verify-id')?.['status']).toBeUndefined();
    expect(client.sudoCalls).toHaveLength(2);
    expect(client.runCalls).toHaveLength(0);
  });

  it('reports an unknown host without throwing', async () => {
    const api = makeApi();
    const plan = { ...buildCreatePlan(api), host: 'ghost' };
    const job = makeJob(plan);
    const runner = createUsersExecuteRunner({
      config: { servers: [makeServer()] },
      makeClient: () => new FakePlanClient(),
    });

    await runner(job, plan);

    expect(job['state']).toBe('done');
    expect(job['ok']).toBe(false);
    expect(job['error']).toBe('未知主机');
  });

  it('uses COMMAND_TIMEOUT_SECONDS by default and always stamps finished_at', async () => {
    const server = makeServer();
    const api = makeApi([server]);
    const plan = buildCreatePlan(api);
    const job = makeJob(plan);
    const client = new FakePlanClient();
    const runner = createUsersExecuteRunner({
      config: { servers: [server] },
      makeClient: () => client,
    });

    await runner(job, plan);

    expect(client.sudoCalls[0]?.timeoutMs).toBe(COMMAND_TIMEOUT_SECONDS * 1000);
    expect(typeof job['finished_at']).toBe('string');
    expect(String(job['finished_at'])).toMatch(/\+00:00$/);
  });
});
