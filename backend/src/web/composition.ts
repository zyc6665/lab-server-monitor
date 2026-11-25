/**
 * Composition root for the desktop rewrite web layer (P2 Task 17).
 *
 * `createWebApp` (see `./app.ts`) installs the middleware gate chain and then
 * hands the Express instance to a `registerRoutes` hook. This module is that
 * hook: it wires every route module implemented during P2 into a single
 * application, injecting cross-module collaborators where one module needs
 * another's builders (notably `hosts` reusing the `overview` builders instead
 * of its local fallback stubs).
 *
 * Registration order mirrors the Python oracle's blueprint registration and the
 * order listed in the P2 plan:
 *
 *   auth → overview → hosts → settings → alerts → users → system
 *        → pages → disk-health → ssh-terminal
 *
 * Anything still unmigrated (the SSH session manager, the users monitor/admin
 * APIs, real compute/my summaries) stays `undefined` so the corresponding
 * routes keep their documented placeholder behaviour (e.g. terminal `create`
 * returns `502 ssh_failed`).
 */
import type { Express } from 'express';

import type { AppConfig, HostCheckConfig, HostConfig } from '../config/config';
import { buildServers, type HostRunner, type HostRunnerResult } from '../config/hosts';
import { loadEffectiveSettings } from '../config/service';
import { hostToSshConnectConfig } from '../collect/collectors';
import { collectContainerStats } from '../collect/container-stats';
import { buildComputeSummary } from '../collect/compute';
import {
  probeHost,
  type ProbeCandidate,
  type ProbeResult,
  type ProbeRunner,
} from '../collect/host-probe';
import { SshClient, type SshConnectConfig } from '../collect/ssh-client';
import type { CommandResult } from '../collect/types';
import { coerceHostCheckConfig, runHostChecks, type CheckRunner } from '../runtime/availability';
import { getAllHostSnapshots } from '../storage/hosts';
import { createWebApp } from './app';
import { registerAuthRoutes, type AuthRouteDeps } from './routes/auth';
import {
  createOverviewBuilders,
  registerOverviewRoutes,
  type OverviewRouteDeps,
} from './routes/overview';
import { registerHostsRoutes, type HostsRouteDeps } from './routes/hosts';
import { registerSettingsRoutes, type SettingsRouteDeps } from './routes/settings';
import { registerAlertsRoutes, type AlertsRouteDeps } from './routes/alerts';
import { registerUsersRoutes, type UsersRouteDeps } from './routes/users';
import { registerSystemRoutes, type SystemRouteDeps } from './routes/system';
import { registerPagesRoutes, type PagesRouteDeps } from './routes/pages';
import { registerDiskHealthRoutes, type DiskHealthRouteDeps } from './routes/disk-health';
import { registerSshTerminalRoutes, type SshTerminalRouteDeps } from './routes/ssh-terminal';

type SqliteDatabase = import('better-sqlite3').Database;

/**
 * Optional per-module dependency overrides accepted by {@link createServerApp}.
 *
 * Every module shares the root `db` + `config`; these partials only replace the
 * remaining collaborators (services, builders, feature flags). Omitted entries
 * fall back to the module defaults.
 */
export interface CompositionDeps {
  auth?: Partial<AuthRouteDeps>;
  overview?: Partial<OverviewRouteDeps>;
  hosts?: Partial<HostsRouteDeps>;
  settings?: Partial<SettingsRouteDeps>;
  alerts?: Partial<AlertsRouteDeps>;
  users?: Partial<UsersRouteDeps>;
  system?: Partial<SystemRouteDeps>;
  pages?: Partial<PagesRouteDeps>;
  diskHealth?: Partial<DiskHealthRouteDeps>;
  sshTerminal?: Partial<SshTerminalRouteDeps>;
}

/** Options accepted by {@link createServerApp}. */
export interface CreateServerAppOptions {
  /** Open SQLite handle shared by every route module. */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, paths, app version). */
  config: AppConfig;
  /** Optional per-module collaborator overrides. */
  deps?: CompositionDeps;
  /** Static-asset root override (defaults to `servermanage/web/static`). */
  staticDir?: string;
  /** Disable the static mount (tests that do not need it). */
  mountStatic?: boolean;
}

// ---------------------------------------------------------------------------
// P3 Task 12 — safe real implementations for the collection-backed deps
// ---------------------------------------------------------------------------

/** Default SSH timeouts (seconds) used when settings are missing / invalid. */
const DEFAULT_CONNECT_TIMEOUT_SEC = 10;
const DEFAULT_COMMAND_TIMEOUT_SEC = 20;

/** Narrows an unknown value to a plain object (non-null, non-array). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty string among `values` (tolerant reads of form payloads). */
function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return undefined;
}

/** True when `value` looks like a resolved {@link HostConfig} (has `auth`). */
function isHostConfigLike(value: Record<string, unknown>): boolean {
  return typeof value.host === 'string' && asRecord(value.auth) !== null;
}

/** Effective SSH settings read from the settings store. */
interface SshRuntimeSettings {
  /** `ssh.connect_timeout` in seconds (feeds `SshConnectConfig.connectTimeoutSec`). */
  connectTimeoutSec: number;
  /** `ssh.command_timeout` in seconds (multiplied by 1000 for `run`). */
  commandTimeoutSec: number;
  /** `ssh.host_key_policy` (`tofu`/`strict`/`insecure`, optional). */
  hostKeyPolicy: string | undefined;
}

/**
 * Reads `ssh.*` from the effective settings (the Node `AppConfig` has no `ssh`
 * section; the oracle reads `config.ssh.*` which maps onto these settings).
 */
function readSshSettings(db: SqliteDatabase): SshRuntimeSettings {
  const ssh = asRecord(loadEffectiveSettings(db).ssh) ?? {};
  const connect = Number(ssh.connect_timeout);
  const command = Number(ssh.command_timeout);
  return {
    connectTimeoutSec:
      Number.isFinite(connect) && connect > 0 ? connect : DEFAULT_CONNECT_TIMEOUT_SEC,
    commandTimeoutSec:
      Number.isFinite(command) && command > 0 ? command : DEFAULT_COMMAND_TIMEOUT_SEC,
    hostKeyPolicy: typeof ssh.host_key_policy === 'string' ? ssh.host_key_policy : undefined,
  };
}

/**
 * Maps a loose settings-form payload into a {@link ProbeCandidate} (mirrors the
 * Python `_build_host_config` tolerant field reads). Secret material stays in
 * memory only; nothing is persisted.
 */
function candidateFromPayload(payload: Record<string, unknown>): ProbeCandidate {
  const rawPort = payload.port;
  const port =
    rawPort === undefined || rawPort === null || rawPort === '' ? NaN : Number(rawPort);
  return {
    host: typeof payload.host === 'string' ? payload.host : '',
    name: firstString(payload.name),
    port: Number.isFinite(port) ? port : undefined,
    username: firstString(payload.username),
    authType: firstString(payload.auth_type, payload.authType),
    password: firstString(payload.password),
    privateKey: firstString(payload.private_key, payload.privateKey, payload.key_data),
    privateKeyPath: firstString(payload.key_path, payload.privateKeyPath),
    keyPassphrase: firstString(payload.key_passphrase, payload.keyPassphrase, payload.passphrase),
    sudoPassword: firstString(payload.sudo_password, payload.sudoPassword),
  };
}

/**
 * Builds a {@link ProbeRunner} over a fresh {@link SshClient}. Constructing the
 * client does not open a connection; the first `run`/`runSudo` does.
 */
function createProbeRunner(cfg: SshConnectConfig, sudoPassword?: string): ProbeRunner {
  const client = new SshClient(cfg);
  return {
    run: (command, timeoutMs) => client.run(command, timeoutMs),
    runSudo: (command, timeoutMs) =>
      client.runSudo(command, typeof sudoPassword === 'string' ? sudoPassword : '', timeoutMs),
    close: () => client.close(),
  };
}

/**
 * `hosts.probeHost` — accepts a saved-host name, a loose settings-form payload
 * object, or a resolved {@link HostConfig}. Connection material is built lazily
 * inside `probeHost`'s try block so failures surface as a `ProbeResult`.
 */
function createProbeHost(
  db: SqliteDatabase,
  config: AppConfig,
): (target: unknown) => Promise<ProbeResult> {
  return (target: unknown): Promise<ProbeResult> => {
    const { connectTimeoutSec, hostKeyPolicy } = readSshSettings(db);

    // A bare string: resolve by saved name/address, else probe the literal host.
    let resolved: unknown = target;
    if (typeof target === 'string') {
      const match = buildServers(db, { baseServers: config.servers }).find(
        (server) => server.name === target || server.host === target,
      );
      resolved = match ?? { host: target };
    }

    const record = asRecord(resolved);
    if (record !== null && isHostConfigLike(record)) {
      const host = record as unknown as HostConfig;
      return probeHost(
        { host: host.host, name: host.name },
        {
          timeout: connectTimeoutSec,
          // Deferred so a missing key / bad credential is mapped to a stable
          // failure result rather than thrown out of the route.
          sshFactory: () =>
            createProbeRunner(
              hostToSshConnectConfig(host, connectTimeoutSec, hostKeyPolicy),
              host.sudo_password,
            ),
        },
      );
    }

    return probeHost(candidateFromPayload(record ?? {}), { timeout: connectTimeoutSec });
  };
}

/**
 * `hosts.collectContainerStats` — one read-only `docker stats` per call over a
 * fresh `SshClient` (connect on demand, always closed).
 */
function createCollectContainerStats(
  db: SqliteDatabase,
): (host: HostConfig) => Promise<unknown[]> {
  return async (host: HostConfig): Promise<unknown[]> => {
    const { connectTimeoutSec, commandTimeoutSec, hostKeyPolicy } = readSshSettings(db);
    const client = new SshClient(hostToSshConnectConfig(host, connectTimeoutSec, hostKeyPolicy));
    try {
      return await collectContainerStats(host, client, commandTimeoutSec * 1000);
    } finally {
      client.close();
    }
  };
}

/**
 * `hosts.runner` — connectivity runner for `testHostsBatch`/test-batch: dials the
 * host and runs `echo ok` (mirrors the oracle), closing the client afterwards.
 */
function createHostRunner(db: SqliteDatabase): HostRunner {
  return async (server: HostConfig): Promise<HostRunnerResult> => {
    const { connectTimeoutSec, commandTimeoutSec, hostKeyPolicy } = readSshSettings(db);
    const client = new SshClient(hostToSshConnectConfig(server, connectTimeoutSec, hostKeyPolicy));
    try {
      const result = await client.run('echo ok', commandTimeoutSec * 1000);
      return { exitStatus: result.exitStatus, stdout: result.stdout, stderr: result.stderr };
    } finally {
      client.close();
    }
  };
}

/**
 * `hosts.runHostChecks` runner — executes one availability probe command on
 * `host` over a fresh `SshClient`, closing it afterwards. Mirrors the
 * `CollectorRunner` shape and receives a millisecond timeout per command.
 */
function createCheckRunner(db: SqliteDatabase, host: HostConfig): CheckRunner {
  return {
    run: async (command: string, timeoutMs: number): Promise<CommandResult> => {
      const { connectTimeoutSec, commandTimeoutSec, hostKeyPolicy } = readSshSettings(db);
      const client = new SshClient(hostToSshConnectConfig(host, connectTimeoutSec, hostKeyPolicy));
      try {
        const result = await client.run(
          command,
          timeoutMs > 0 ? timeoutMs : commandTimeoutSec * 1000,
        );
        return {
          exitStatus: result.exitStatus,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      } finally {
        client.close();
      }
    },
  };
}

/** `pages.buildComputeSummary` — the migrated compute module over live snapshots. */
function createComputeSummaryBuilder(): (db: SqliteDatabase, config: AppConfig) => unknown {
  return (db: SqliteDatabase, config: AppConfig): unknown =>
    buildComputeSummary(getAllHostSnapshots(db), {
      servers: config.servers.map((server) => ({
        name: server.name,
        address: server.host,
        group: server.group,
      })),
    });
}

/**
 * Builds a {@link CompositionDeps} value with the cross-module wiring that can
 * be derived purely from `db` + `config`.
 *
 * P3 Task 12 wires the migrated collection layer into the `hosts` routes
 * (`probeHost`, `collectContainerStats`, `runner`) and the `pages` route
 * (`buildComputeSummary`). P4 Task 7 adds the availability hooks
 * (`runHostChecks`, `prepareHostCheck`). Everything else still unmigrated
 * (P4/P5) stays `undefined` so its route keeps the documented placeholder
 * behaviour.
 */
export function buildDefaultDeps(db: SqliteDatabase, config: AppConfig): CompositionDeps {
  const overviewBuilders = createOverviewBuilders(db, config);
  return {
    hosts: {
      buildOverview: overviewBuilders.buildOverview,
      buildHostDetail: overviewBuilders.buildHostDetail,
      buildHostReport: overviewBuilders.buildHostReport,
      probeHost: createProbeHost(db, config),
      collectContainerStats: createCollectContainerStats(db),
      runner: createHostRunner(db),
      runHostChecks: (host: HostConfig, checks: HostCheckConfig[]) =>
        runHostChecks(host, checks, createCheckRunner(db, host), {
          timeoutMs: readSshSettings(db).commandTimeoutSec * 1000,
        }),
      prepareHostCheck: (payload: Record<string, unknown>) => coerceHostCheckConfig(payload),
    },
    pages: {
      buildComputeSummary: createComputeSummaryBuilder(),
    },
  };
}

/**
 * Builds the fully assembled server application (all P2 routes) without
 * opening a listening socket; the caller owns `app.listen`.
 *
 * @param opts db + config, optional per-module deps and static-mount options.
 */
export function createServerApp(opts: CreateServerAppOptions): Express {
  const { db, config } = opts;
  const appVersion = config.appVersion;
  const overrides = opts.deps ?? {};
  const defaults = buildDefaultDeps(db, config);

  return createWebApp({
    db,
    config,
    staticDir: opts.staticDir,
    mountStatic: opts.mountStatic,
    registerRoutes: (app: Express): void => {
      registerAuthRoutes(app, { ...overrides.auth, db, appVersion });
      registerOverviewRoutes(app, { ...overrides.overview, db, config, appVersion });
      registerHostsRoutes(app, {
        ...defaults.hosts,
        ...overrides.hosts,
        db,
        config,
        appVersion,
      });
      registerSettingsRoutes(app, { ...overrides.settings, db, config, appVersion });
      registerAlertsRoutes(app, { ...overrides.alerts, db, config, appVersion });
      registerUsersRoutes(app, { ...overrides.users, db, config, appVersion });
      registerSystemRoutes(app, { ...overrides.system, db, config, appVersion });
      registerPagesRoutes(app, {
        ...defaults.pages,
        ...overrides.pages,
        db,
        config,
        appVersion,
      });
      registerDiskHealthRoutes(app, { ...overrides.diskHealth, db, config, appVersion });
      registerSshTerminalRoutes(app, { ...overrides.sshTerminal, db, config, appVersion });
    },
  });
}
