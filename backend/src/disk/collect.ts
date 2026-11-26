/**
 * Disk-health collection — 1:1 TypeScript port of `collect_disk_health`
 * (`servermanage/disk_health.py:791-1016`, P5 Task 5).
 *
 * Probes storcli over an injected runner, enumerates controllers, then each
 * controller's virtual + physical drives, evaluates every drive, and returns a
 * {@link DiskHealthReport}. It **never raises for an operational failure** and
 * never fabricates drives: every problem surfaces as a report whose `status`
 * reflects the real condition.
 *
 * Status vocabulary (consumers must treat every non-`ok` value as "disk health
 * unavailable", never as healthy):
 *
 * - `ok`                 collection succeeded with no warnings.
 * - `permission_denied`  storcli needs root / passwordless sudo that is not
 *                        available (or a non-sudo run reports "No Controller
 *                        found").
 * - `no_storcli`         none of the candidate storcli binaries could be run.
 * - `no_controller`      storcli ran but reported no controllers.
 * - `error`              a transport/parse failure prevented collection.
 * - `degraded`           some per-controller data was collected but at least
 *                        one query failed; only the collected drives appear.
 *
 * ## Command sequence (per host, matches the oracle byte-for-byte)
 *
 * 1. `{candidate} -v` for each candidate — the first that exits 0 is chosen.
 * 2. `{storcli} /cALL show J`.
 * 3. For each controller `cid`:
 *    - `{storcli} /c{cid}/vall show J`
 *    - `{storcli} /c{cid}/eall/sall show all J`
 *
 * ## Runner / sudo divergence
 *
 * Python's `_run_privileged` calls `runner.run(command, timeout)` or, when sudo
 * is enabled, `runner.run_sudo(command, timeout)` if the runner exposes it
 * (else `run("sudo -n " + command, timeout)`). The backend `SshClient.runSudo`
 * additionally needs a sudo password, so a real caller must pass a runner whose
 * `runSudo` is already bound to that password — exactly the shape produced by
 * `web/composition.ts:createProbeRunner` (`run`/`runSudo(command, timeoutMs)`).
 * This module only depends on that 2-argument surface, so fakes stay trivial.
 */

import type { HostDiskHealthOverride } from '../config/config';
import { SudoAuthError, SudoUnavailable } from '../collect/ssh-client';
import type { CommandResult } from '../collect/types';
import {
  StorcliParseError,
  parseControllers,
  parsePhysicalDrives,
  parseVirtualDrives,
} from './parse';
import type {
  DiskControllerInfo as ParsedController,
  PhysicalDriveInfo as ParsedDrive,
  VirtualDriveInfo as ParsedVd,
} from './parse';
import {
  evaluateControllerHealth,
  evaluateDriveHealth,
  evaluateVirtualDriveHealth,
} from './evaluate';
import type { DiskHealthRuleConfig } from './evaluate';
import type {
  DiskControllerInfo,
  DiskHealthReport,
  PhysicalDriveInfo,
  VirtualDriveInfo,
} from './report';
import { nowIsoUtc } from '../storage/time';

// ---------------------------------------------------------------------------
// Configuration / dependency-injection surface
// ---------------------------------------------------------------------------

/** Default storcli candidates (`models.py` `DiskHealthConfig`). */
export const DEFAULT_STORCLI_CANDIDATES: readonly string[] = [
  'storcli',
  'storcli64',
  '/opt/MegaRAID/storcli/storcli64',
  '/opt/lsi/storcli/storcli64',
  '/usr/local/bin/storcli',
  '/usr/sbin/storcli',
];

/** Default command timeout in **milliseconds** (`ssh.command_timeout` = 20 s). */
export const DEFAULT_DISK_COMMAND_TIMEOUT_MS = 20_000;

/** Default drive-temperature alert threshold, in °C. */
export const DEFAULT_DISK_TEMPERATURE_THRESHOLD_C = 55;

/** The subset of `DiskHealthConfig` (`models.py`) `collectDiskHealth` reads. */
export interface DiskHealthCollectConfig {
  /** `DiskHealthConfig.use_sudo` (default `true`). */
  use_sudo?: boolean | null;
  /** `DiskHealthConfig.storcli_candidates`. */
  storcli_candidates?: readonly string[] | null;
  /** `DiskHealthConfig.rules` (undefined → the evaluators' all-true defaults). */
  rules?: DiskHealthRuleConfig | null;
}

/**
 * Minimal host view: only `name` (report label) and the optional per-host
 * `disk_health` override are used. A real `HostConfig` is assignable.
 */
export interface DiskHealthHost {
  name: string;
  disk_health?: HostDiskHealthOverride | null;
}

/** Structural runner surface (real `SshClient`-backed adapter or a test fake). */
export interface DiskHealthRunner {
  run(command: string, timeoutMs: number): Promise<CommandResult> | CommandResult;
  runSudo?(command: string, timeoutMs: number): Promise<CommandResult> | CommandResult;
  close?(): void;
}

/** Builds a runner for one host (mirrors `CollectorRunner`'s factory shape). */
export type DiskHealthRunnerFactory = (
  host: DiskHealthHost,
) => Promise<DiskHealthRunner> | DiskHealthRunner;

/** Options for {@link collectDiskHealth} (mirror Python keyword arguments). */
export interface CollectDiskHealthOptions {
  /** Disk-health config (candidates / sudo / rules); defaults match Python. */
  config?: DiskHealthCollectConfig | null;
  /** Previous persisted batch — feeds `evaluateDriveHealth`'s error-increase rule. */
  previous?: DiskHealthReport | null;
  /** Explicit override; falls back to `host.disk_health` when omitted/null. */
  override?: HostDiskHealthOverride | null;
  /** Clock for `collected_at` (defaults to now, in UTC). */
  now?: Date | string;
  /** Temperature threshold in °C (default `55`). */
  temperatureThresholdC?: number;
  /** Per-command timeout in milliseconds (default `20_000`). */
  timeoutMs?: number;
  /** Build a runner from `host` when no runner argument is supplied. */
  runnerFactory?: DiskHealthRunnerFactory;
}

// ---------------------------------------------------------------------------
// Small oracle helpers (disk_health.py:660-700)
// ---------------------------------------------------------------------------

const PERMISSION_MARKERS = ['password is required', 'not in the sudoers', 'permission'];
const NO_CONTROLLER_MARKER = 'no controller found';
const BRIEF_LIMIT = 300;

/** `_looks_permission_error` — true when any text mentions a sudo failure. */
function looksPermissionError(...texts: Array<string | null | undefined>): boolean {
  const lowered = texts.map((text) => text ?? '').join(' ').toLowerCase();
  return PERMISSION_MARKERS.some((marker) => lowered.includes(marker));
}

/** `_brief` — strip, then truncate past `limit` with an ellipsis. */
function brief(text: string | null | undefined, limit: number = BRIEF_LIMIT): string {
  const value = (text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

/** `_permission_message` — append the actionable sudo hint. */
function permissionMessage(error: unknown): string {
  return `${errorMessage(error)}；请在主机编辑中配置 sudo 密码或免密 sudo 后重试。`;
}

/** `str(exc)` for a thrown JS value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when a thrown value is one of the two sudo failures. */
function isSudoError(error: unknown): boolean {
  return error instanceof SudoAuthError || error instanceof SudoUnavailable;
}

/**
 * `_run_privileged` — read path through `run`, sudo path through `runSudo` when
 * available, else the historical `sudo -n` prefix over `run`.
 */
async function runPrivileged(
  runner: DiskHealthRunner,
  command: string,
  timeoutMs: number,
  useSudo: boolean,
): Promise<CommandResult> {
  if (!useSudo) {
    return runner.run(command, timeoutMs);
  }
  const runSudo = runner.runSudo;
  if (typeof runSudo === 'function') {
    return runSudo.call(runner, command, timeoutMs);
  }
  return runner.run(`sudo -n ${command}`, timeoutMs);
}

/** Resolve `opts.now` to a `Date` (naive ISO treated as UTC). */
function resolveNow(value: Date | string | undefined): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date() : new Date(value.getTime());
  }
  if (typeof value === 'string' && value.trim() !== '') {
    let text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) {
      text = `${text.replace(' ', 'T')}Z`;
    }
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) {
      return new Date(ms);
    }
  }
  return new Date();
}

// ---------------------------------------------------------------------------
// camelCase (parse/evaluate) -> snake_case (report) boundary
// ---------------------------------------------------------------------------

function reportController(c: ParsedController): DiskControllerInfo {
  return {
    controller: c.controller,
    model: c.model,
    firmware: c.firmware,
    bbu_state: c.bbuState,
    health: c.health,
    reasons: [...c.reasons],
  };
}

function reportVirtualDrive(v: ParsedVd): VirtualDriveInfo {
  return {
    controller: v.controller,
    vd_id: v.vdId,
    raid_level: v.raidLevel,
    state: v.state,
    size: v.size,
    health: v.health,
    reasons: [...v.reasons],
  };
}

function reportPhysicalDrive(d: ParsedDrive): PhysicalDriveInfo {
  return {
    controller: d.controller,
    enclosure: d.enclosure,
    slot: d.slot,
    did: d.did,
    model: d.model,
    serial: d.serial,
    state: d.state,
    media_errors: d.mediaErrors,
    other_errors: d.otherErrors,
    predictive_failures: d.predictiveFailures,
    smart_alert: d.smartAlert,
    temperature_c: d.temperatureC,
    shield_counter: d.shieldCounter,
    health: d.health,
    reasons: [...d.reasons],
  };
}

/** Inverse boundary, used only to feed the previous batch to the evaluators. */
function parsedPhysicalDrive(d: PhysicalDriveInfo): ParsedDrive {
  return {
    controller: d.controller,
    enclosure: d.enclosure,
    slot: d.slot,
    did: d.did,
    model: d.model,
    serial: d.serial,
    state: d.state,
    mediaErrors: d.media_errors,
    otherErrors: d.other_errors,
    predictiveFailures: d.predictive_failures,
    smartAlert: d.smart_alert,
    temperatureC: d.temperature_c,
    shieldCounter: d.shield_counter,
    health: d.health,
    reasons: [...d.reasons],
  };
}

/** Stable identity key for the previous-snapshot lookup (controller, e, slot). */
function driveKey(controller: number, enclosure: number | null, slot: number | null): string {
  return JSON.stringify([controller, enclosure, slot]);
}

// ---------------------------------------------------------------------------
// collect_disk_health
// ---------------------------------------------------------------------------

/**
 * `collect_disk_health` (`disk_health.py:791`). Collect one host's disk health
 * over `runner`. Never throws for an operational failure; any problem becomes a
 * report with a non-`ok` status.
 */
export async function collectDiskHealth(
  host: DiskHealthHost,
  runner?: DiskHealthRunner | null,
  opts: CollectDiskHealthOptions = {},
): Promise<DiskHealthReport> {
  let activeRunner = runner ?? null;
  if (!activeRunner && opts.runnerFactory) {
    activeRunner = await opts.runnerFactory(host);
  }
  if (!activeRunner) {
    throw new Error('collectDiskHealth requires a runner or a runnerFactory option');
  }

  const config = opts.config ?? {};
  const collectedAt = nowIsoUtc(resolveNow(opts.now));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DISK_COMMAND_TIMEOUT_MS;
  const temperatureThresholdC =
    opts.temperatureThresholdC ?? DEFAULT_DISK_TEMPERATURE_THRESHOLD_C;

  const effective = opts.override != null ? opts.override : (host.disk_health ?? null);

  const candidates =
    effective?.storcli_path != null && effective.storcli_path !== ''
      ? [effective.storcli_path]
      : [...(config.storcli_candidates ?? DEFAULT_STORCLI_CANDIDATES)];

  const useSudo =
    effective?.use_sudo != null ? effective.use_sudo : (config.use_sudo ?? true);

  const rules = config.rules ?? undefined;

  const report = (
    status: string,
    message: string | null,
    extras: Partial<Pick<DiskHealthReport, 'controllers' | 'virtual_drives' | 'physical_drives'>> = {},
  ): DiskHealthReport => ({
    host_name: host.name,
    collected_at: collectedAt,
    status,
    message,
    controllers: extras.controllers ?? [],
    virtual_drives: extras.virtual_drives ?? [],
    physical_drives: extras.physical_drives ?? [],
  });

  if (candidates.length === 0) {
    return report('no_storcli', '未配置 storcli 候选路径');
  }

  // 1. Probe candidates in order; the first one that exits 0 is used.
  let storcli: string | null = null;
  const probeErrors: string[] = [];
  for (const candidate of candidates) {
    let result: CommandResult;
    try {
      result = await runPrivileged(activeRunner, `${candidate} -v`, timeoutMs, useSudo);
    } catch (error) {
      if (isSudoError(error)) {
        return report('permission_denied', permissionMessage(error));
      }
      probeErrors.push(`${candidate}: ${errorMessage(error)}`);
      continue;
    }
    if (result.exitStatus === 0) {
      storcli = candidate;
      break;
    }
    const detail =
      [brief(result.stderr), brief(result.stdout)].filter((part) => part !== '').join(' ') ||
      `exit ${result.exitStatus}`;
    probeErrors.push(`${candidate}: ${detail}`);
  }

  if (storcli === null) {
    if (probeErrors.some((item) => looksPermissionError(item))) {
      return report(
        'permission_denied',
        'sudo 权限不足，无法以 root 运行 storcli；' +
          '请在主机编辑中配置 sudo 密码，或配置免密 sudo 后重试。',
      );
    }
    return report('no_storcli', `未找到可用的 storcli 可执行文件：${probeErrors.join('; ')}`);
  }

  // 2. Enumerate controllers.
  let controllersResult: CommandResult;
  try {
    controllersResult = await runPrivileged(
      activeRunner,
      `${storcli} /cALL show J`,
      timeoutMs,
      useSudo,
    );
  } catch (error) {
    if (isSudoError(error)) {
      return report('permission_denied', permissionMessage(error));
    }
    return report('error', `storcli /cALL show J 执行异常：${errorMessage(error)}`);
  }

  if (controllersResult.exitStatus !== 0) {
    if (looksPermissionError(controllersResult.stderr, controllersResult.stdout)) {
      return report(
        'permission_denied',
        'sudo 权限不足，无法以 root 运行 storcli；' +
          '请在主机编辑中配置 sudo 密码，或配置免密 sudo 后重试。',
      );
    }
    return report(
      'error',
      `storcli /cALL show J 执行失败（exit ${controllersResult.exitStatus}）：${brief(
        controllersResult.stderr || controllersResult.stdout,
      )}`,
    );
  }

  // Interpret raw stdout before parsing: a genuinely controller-less host
  // reports empty output or "No Controller found" with no JSON at all.
  const rawStdout = controllersResult.stdout ?? '';
  const strippedStdout = rawStdout.trim();
  if (!strippedStdout || strippedStdout.toLowerCase().includes(NO_CONTROLLER_MARKER)) {
    if (!useSudo) {
      return report(
        'permission_denied',
        'storcli 未提权运行且未报告控制器（空输出 / No Controller found）；' +
          '非 root 的 storcli 无法看到控制器，请以 root（sudo）运行。',
      );
    }
    return report('no_controller', 'storcli 未发现任何控制器');
  }

  let controllers: ParsedController[];
  try {
    controllers = parseControllers(rawStdout);
  } catch (error) {
    if (error instanceof StorcliParseError) {
      return report('error', `无法解析控制器输出：${error.message}`);
    }
    throw error;
  }

  if (controllers.length === 0) {
    return report('no_controller', 'storcli 未发现任何控制器');
  }

  // 3. Virtual drives and physical drives per controller.
  const virtualDrives: ParsedVd[] = [];
  const physicalDrives: ParsedDrive[] = [];
  const warnings: string[] = [];

  for (const controller of controllers) {
    const cid = controller.controller;

    try {
      const vdResult = await runPrivileged(
        activeRunner,
        `${storcli} /c${cid}/vall show J`,
        timeoutMs,
        useSudo,
      );
      if (vdResult.exitStatus !== 0) {
        warnings.push(`控制器 ${cid} 虚拟盘查询失败：${brief(vdResult.stderr || vdResult.stdout)}`);
      } else {
        try {
          virtualDrives.push(...parseVirtualDrives(vdResult.stdout, cid));
        } catch (error) {
          if (!(error instanceof StorcliParseError)) {
            throw error;
          }
          warnings.push(`控制器 ${cid} 虚拟盘解析失败：${error.message}`);
        }
      }
    } catch (error) {
      if (isSudoError(error)) {
        warnings.push(`控制器 ${cid} 虚拟盘查询需要 sudo 权限：${errorMessage(error)}`);
      } else {
        warnings.push(`控制器 ${cid} 虚拟盘查询异常：${errorMessage(error)}`);
      }
    }

    try {
      const pdResult = await runPrivileged(
        activeRunner,
        `${storcli} /c${cid}/eall/sall show all J`,
        timeoutMs,
        useSudo,
      );
      if (pdResult.exitStatus !== 0) {
        warnings.push(`控制器 ${cid} 物理盘查询失败：${brief(pdResult.stderr || pdResult.stdout)}`);
        continue;
      }
      try {
        physicalDrives.push(...parsePhysicalDrives(pdResult.stdout));
      } catch (error) {
        if (!(error instanceof StorcliParseError)) {
          throw error;
        }
        warnings.push(`控制器 ${cid} 物理盘解析失败：${error.message}`);
      }
    } catch (error) {
      if (isSudoError(error)) {
        warnings.push(`控制器 ${cid} 物理盘查询需要 sudo 权限：${errorMessage(error)}`);
      } else {
        warnings.push(`控制器 ${cid} 物理盘查询异常：${errorMessage(error)}`);
      }
      continue;
    }
  }

  // 4. Evaluate health, matching the previous snapshot by slot identity.
  const previousIndex = new Map<string, ParsedDrive>();
  if (opts.previous) {
    for (const item of opts.previous.physical_drives) {
      previousIndex.set(
        driveKey(item.controller, item.enclosure, item.slot),
        parsedPhysicalDrive(item),
      );
    }
  }

  const evaluated: PhysicalDriveInfo[] = physicalDrives.map((drive) => {
    const prior = previousIndex.get(driveKey(drive.controller, drive.enclosure, drive.slot));
    return reportPhysicalDrive(
      evaluateDriveHealth(drive, {
        rules,
        previous: prior ?? null,
        temperatureThresholdC,
      }),
    );
  });

  const evaluatedControllers: DiskControllerInfo[] = controllers.map((controller) =>
    reportController(evaluateControllerHealth(controller)),
  );
  const evaluatedVirtual: VirtualDriveInfo[] = virtualDrives.map((vd) =>
    reportVirtualDrive(evaluateVirtualDriveHealth(vd)),
  );

  let status: string;
  if (warnings.length > 0 && physicalDrives.length === 0 && virtualDrives.length === 0) {
    status = 'error';
  } else if (warnings.length > 0) {
    status = 'degraded';
  } else {
    status = 'ok';
  }
  const message = warnings.length > 0 ? warnings.join('; ') : null;

  return report(status, message, {
    controllers: evaluatedControllers,
    virtual_drives: evaluatedVirtual,
    physical_drives: evaluated,
  });
}
