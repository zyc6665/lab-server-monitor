/**
 * Server account write-operation execution service.
 *
 * Ports the Python `servermanage.user_admin` glue that the web layer used to
 * provide through `_core.py::_run_execute_job`:
 *
 * - {@link createUsersAdminApi} adapts the pure planner in `./admin.ts` to the
 *   {@link UsersAdminApi} surface the route handler expects (camelCase route
 *   options in, snake_case build params out, host lookup by name).
 * - {@link createSshPlanRunner} adapts an {@link SSHClient} to the async
 *   {@link AsyncPlanRunner} contract, converting PlanRunner timeouts (seconds)
 *   to SSH client timeouts (milliseconds) and forwarding passwords/PII via
 *   stdin only.
 * - {@link createUsersExecuteRunner} wires connect → execute → job-status
 *   updates and always closes the connection.
 *
 * The route-level `PlanCache`, `executeJobs` map and audit persistence stay in
 * `web/routes/users.ts` (Python `storage.save_user_operation`); this module is
 * deliberately storage-free and only receives the already-debounced `job` and
 * the full (secret-bearing) `plan`.
 */

import type { HostConfig } from '../config/config';
import { hostToSshConnectConfig } from '../collect/collectors';
import { SshClient, type SshConnectConfig } from '../collect/ssh-client';
import { nowIsoUtc } from '../storage/time';
import type { UsersAdminApi, UsersExecuteRunner } from '../web/routes/users';
import {
  AdminPlanError,
  COMMAND_TIMEOUT_SECONDS,
  buildPlan,
  executePlanAsync,
  publicPlan,
  validateAccountName,
  type AdminPlan,
  type AsyncPlanRunner,
  type BuildPlanParams,
  type CommandResult,
  type ExecutePlanResult,
  type PlanCache,
} from './admin';

type Obj = Record<string, unknown>;

/**
 * Minimal config surface this module needs (a full `AppConfig` also matches).
 *
 * `servers` may be a static list or a getter. The users route resolves hosts via
 * `currentServers()` (which can include DB-imported hosts that are not in the
 * static `config.servers`), so the composition root can pass
 * `{ servers: () => deps.currentServers?.() ?? config.servers }` to stay in sync.
 */
export interface UsersAdminConfig {
  servers: HostConfig[] | (() => HostConfig[]);
}

function listServers(config: UsersAdminConfig): HostConfig[] {
  return typeof config.servers === 'function' ? config.servers() : config.servers;
}

/** The subset of `SSHClient` used by {@link createSshPlanRunner}. */
export interface PlanSshClient {
  run(
    command: string,
    timeoutMs: number,
  ): Promise<{ exitStatus: number; stdout: string; stderr: string }>;
  runSudo(
    command: string,
    password: string,
    timeoutMs: number,
    stdinData?: string | null,
  ): Promise<{ exitStatus: number; stdout: string; stderr: string }>;
  close(): void;
}

// ---------------------------------------------------------------------------
// Small coercion helpers (mirror the route's `asString`/`asBool` utilities)
// ---------------------------------------------------------------------------

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return String(value);
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined) return fallback;
  return Boolean(value);
}

function safeErrorMessage(exc: unknown): string {
  let message: string;
  if (exc instanceof Error) {
    message = exc.message || exc.constructor.name;
  } else if (typeof exc === 'string') {
    message = exc;
  } else {
    message = String(exc);
  }
  return message.slice(0, 400);
}

/**
 * Look up a host by name, raising the Python-compatible `未知主机` error when it
 * is absent. Exported so callers can pre-validate before showing a plan.
 */
export function resolveServer(config: UsersAdminConfig, hostName: string): HostConfig {
  const name = hostName.trim();
  const server = listServers(config).find((item) => item.name === name);
  if (!server) {
    throw new AdminPlanError('未知主机');
  }
  return server;
}

// ---------------------------------------------------------------------------
// Planner adapter
// ---------------------------------------------------------------------------

/**
 * Map the route handler's camelCase options plus the resolved {@link HostConfig}
 * onto `admin.buildPlan`'s snake_case {@link BuildPlanParams}.
 *
 * Route keys (see `web/routes/users.ts: /plan`): `hostName`, `account`,
 * `password`, `accountExists`, `dataSupported`, `sudoOk`, `withDocker`, `withData`.
 */
export function hostToBuildPlanParams(
  server: HostConfig,
  operation: string,
  options: Record<string, unknown>,
  now?: Date,
): BuildPlanParams {
  const password = options['password'];
  return {
    operation,
    host_name: server.name,
    account: coerceString(options['account']),
    password: password === null || password === undefined
      ? null
      : coerceString(password),
    account_exists: coerceBoolean(options['accountExists'] ?? options['account_exists'], false),
    docker_group: coerceBoolean(options['dockerGroup'] ?? options['docker_group'], true),
    data_supported: coerceBoolean(options['dataSupported'] ?? options['data_supported'], true),
    sudo_configured: coerceBoolean(
      options['sudoOk'] ?? options['sudo_configured'],
      Boolean(server.sudo_password),
    ),
    with_docker: coerceBoolean(options['withDocker'] ?? options['with_docker'], true),
    with_data: coerceBoolean(options['withData'] ?? options['with_data'], true),
    now,
  };
}

/**
 * Build the {@link UsersAdminApi} the users route delegates `/plan` to.
 *
 * `buildPlan` resolves the host from `options.hostName` (the route always
 * passes an existing `server.name`), maps the remaining options and returns the
 * full plan (with server-side `stdin` secrets). `publicPlan` strips them.
 */
export function createUsersAdminApi(config: UsersAdminConfig): UsersAdminApi {
  return {
    AdminPlanError,
    validateAccountName,
    buildPlan(operation: string, options: Record<string, unknown>): Obj {
      const hostName = coerceString(options['hostName'] ?? options['host_name']);
      const server = resolveServer(config, hostName);
      const params = hostToBuildPlanParams(server, operation, options);
      return buildPlan(params) as unknown as Obj;
    },
    publicPlan(plan: Obj): Obj {
      return publicPlan(plan as unknown as AdminPlan) as unknown as Obj;
    },
  };
}

// ---------------------------------------------------------------------------
// SSH runner adapter
// ---------------------------------------------------------------------------

function toPlanResult(result: {
  exitStatus: number;
  stdout?: string | null;
  stderr?: string | null;
}): CommandResult {
  return {
    exit_status: result.exitStatus,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Adapt an {@link SSHClient} (or any {@link PlanSshClient}) to the async
 * {@link AsyncPlanRunner} contract used by {@link executePlanAsync}.
 *
 * Timeouts: `PlanRunner` expresses them in seconds, the SSH client in
 * milliseconds, so each command is multiplied by 1000. The sudo password comes
 * from the server config (`sudo_password`); per-step `stdin_data` is forwarded so
 * `chpasswd` receives its payload on the same channel as the sudo password.
 */
export function createSshPlanRunner(server: HostConfig, client: PlanSshClient): AsyncPlanRunner {
  const sudoPassword = typeof server.sudo_password === 'string' ? server.sudo_password : '';
  return {
    async run(command: string, timeout: number): Promise<CommandResult> {
      const result = await client.run(command, timeout * 1000);
      return toPlanResult(result);
    },
    async run_sudo(
      command: string,
      timeout: number,
      opts?: { stdin_data?: string | null },
    ): Promise<CommandResult> {
      const stdinData = opts?.stdin_data ?? null;
      const result = await client.runSudo(command, sudoPassword, timeout * 1000, stdinData);
      return toPlanResult(result);
    },
  };
}

// ---------------------------------------------------------------------------
// Background executor
// ---------------------------------------------------------------------------

/** Options for {@link createUsersExecuteRunner}. */
export interface UsersExecuteRunnerOptions {
  /** Host inventory (the route's `config.servers`). */
  config: UsersAdminConfig;
  /** Injectable SSH client factory (tests pass a fake). */
  makeClient?: (cfg: SshConnectConfig) => PlanSshClient;
  /**
   * Optional preview cache. The route consumes/drops the plan before enqueueing
   * the job, so production wiring should leave this `null`; hash integrity is
   * still verified by {@link executePlanAsync}.
   */
  cache?: PlanCache | null;
  /** Clock override for deterministic `finished_at` values. */
  now?: () => Date;
  /** SSH connect timeout in seconds (default 10, matching collectors). */
  connectTimeoutSec?: number;
  /** SSH host-key policy (defaults to the collector default). */
  hostKeyPolicy?: string;
  /** Per-command timeout in seconds (default {@link COMMAND_TIMEOUT_SECONDS}). */
  commandTimeoutSec?: number;
}

const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

function applyOutcome(job: Obj, outcome: ExecutePlanResult): void {
  const rawSteps = job['steps'];
  const steps: Obj[] = Array.isArray(rawSteps) ? (rawSteps as Obj[]) : [];
  const byId = new Map<string, Obj>();
  for (const step of steps) {
    if (step !== null && typeof step === 'object') {
      byId.set(coerceString(step['id']), step as Obj);
    }
  }
  for (const entry of outcome.steps) {
    const target = byId.get(entry.id);
    if (!target) continue;
    target['status'] = entry.status;
    target['exit_status'] = entry.exit_status;
    target['stdout'] = entry.stdout;
    target['stderr'] = entry.stderr;
  }
}

/**
 * Build the `runExecuteJob` collaborator the users route calls for `/execute`.
 *
 * The returned function mutates the in-flight `job` exactly like the Python
 * `_run_execute_job`: it connects, runs the plan step-by-step, copies each
 * executed step's status/stdout/stderr onto the masked job steps, then sets
 * `job.ok`/`job.error`/`job.state = 'done'` (or `'error'` on an unexpected
 * failure). `job.finished_at` is always stamped. The connection is closed in a
 * `finally`. Audit persistence is intentionally out of scope (no DB handle
 * here) and remains the route/composition concern.
 */
export function createUsersExecuteRunner(options: UsersExecuteRunnerOptions): UsersExecuteRunner {
  const { config } = options;
  const makeClient =
    options.makeClient ?? ((cfg: SshConnectConfig): PlanSshClient => new SshClient(cfg));
  const cache = options.cache ?? null;
  const connectTimeoutSec = options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
  const commandTimeoutSec = options.commandTimeoutSec ?? COMMAND_TIMEOUT_SECONDS;
  const resolveNow = (): Date => (options.now ? options.now() : new Date());

  return async (job: Obj, plan: Obj): Promise<void> => {
    try {
      let outcome: ExecutePlanResult;
      try {
        const hostName = coerceString(plan['host']);
        const server = resolveServer(config, hostName);
        const cfg = hostToSshConnectConfig(server, connectTimeoutSec, options.hostKeyPolicy);
        const client = makeClient(cfg);
        try {
          const runner = createSshPlanRunner(server, client);
          outcome = await executePlanAsync(plan as unknown as AdminPlan, runner, cache, {
            timeout: commandTimeoutSec,
            now: options.now ? options.now() : undefined,
          });
        } finally {
          try {
            client.close();
          } catch {
            // ignore teardown errors, like the Python context manager
          }
        }
      } catch (exc) {
        // Connection / plan-validation failure: report an error outcome while
        // still finishing the job cleanly (Python sets state 'done', ok false).
        outcome = { ok: false, status: 'error', steps: [], error: safeErrorMessage(exc) };
      }

      applyOutcome(job, outcome);
      job['ok'] = Boolean(outcome.ok);
      job['error'] = outcome.error;
      job['state'] = 'done';
    } catch (exc) {
      job['ok'] = false;
      job['error'] = safeErrorMessage(exc);
      job['state'] = 'error';
    } finally {
      job['finished_at'] = nowIsoUtc(resolveNow());
    }
  };
}
