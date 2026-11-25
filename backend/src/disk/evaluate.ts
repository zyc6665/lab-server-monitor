/**
 * Disk health evaluation — ported 1:1 from the Python oracle
 * `servermanage/disk_health.py:529-653` (P5 Task 4).
 *
 * Covered oracle functions:
 * - `_state_word` (`disk_health.py:529-533`)
 * - `_increased` (`disk_health.py:536-542`)
 * - `evaluate_drive_health` (`disk_health.py:545-621`)
 * - `evaluate_virtual_drive_health` (`disk_health.py:624-641`)
 * - `_evaluate_controller_health` (`disk_health.py:644-653`)
 *
 * Everything here is a pure function: no I/O, no clock, no SSH. The input
 * objects are never mutated — each evaluator returns a freshly spread copy with
 * `health` / `reasons` overwritten, exactly like Python's `dataclasses.replace`.
 *
 * The `DiskControllerInfo` / `VirtualDriveInfo` / `PhysicalDriveInfo` shapes are
 * the canonical ones owned by P5 Task 3 (`backend/src/disk/parse.ts`, the storcli
 * parse layer), re-used here so the parse → evaluate pipeline shares one type.
 * Task 3 uses camelCase field names; the Python oracle uses snake_case — the
 * differential tests camelise the oracle output before diffing.
 *
 * Iron laws carried over from the oracle:
 * - Missing counters are `null`, never `0`: an unknown previous value cannot be
 *   evidence of an error-count increase (`_increased` requires both sides known).
 * - `_state_word` trims, lowercases and collapses internal whitespace runs so
 *   `"  Partially   Degraded "` matches the canonical `"partially degraded"`.
 * - The temperature check is strict (`>`), so a drive *exactly* at the 55 °C
 *   threshold does not alert.
 * - Physical-drive reasons are appended in a fixed order: state → predictive →
 *   smart → media → other → increase → temperature.
 * - `evaluateVirtualDriveHealth` never silently reports an unknown/missing state
 *   as healthy; and any *other* known non-optimal VD state is a warning.
 *
 * Note on the plan text: it says "介质错误/其他错误计数增长 → critical", but the
 * Python oracle yields `warning` for `media_errors` / `other_errors` /
 * `error_increase` (only a failed/offline/missing physical state is `critical`).
 * This port follows the Python oracle byte-for-byte so the differential oracle
 * yields an empty diff.
 */

import type {
  DiskControllerInfo,
  PhysicalDriveInfo,
  VirtualDriveInfo,
} from './parse';

// ---------------------------------------------------------------------------
// Types (mirrors `servermanage/disk_health.py` dataclasses 102-127)
// ---------------------------------------------------------------------------

/**
 * `AlertEvent` (`servermanage/disk_health.py:102-113`). Field names stay
 * snake_case because the event is consumed verbatim by the storage layer and the
 * alert templates. `reasons` defaults to `[]`.
 */
export interface AlertEvent {
  host_name: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  fingerprint: string;
  reasons: string[];
}

/** `DiskHealthRuleConfig` (`servermanage/models.py:227-234`) — all default true. */
export interface DiskHealthRuleConfig {
  alert_on_media_errors?: boolean;
  alert_on_other_errors?: boolean;
  alert_on_predictive_failure?: boolean;
  alert_on_smart_flag?: boolean;
  alert_on_state_not_optimal?: boolean;
  alert_on_error_increase?: boolean;
}

// ---------------------------------------------------------------------------
// State vocabulary (mirrors `disk_health.py:496-526`)
// ---------------------------------------------------------------------------

/** Physical drive failed and needs replacing. */
const CRITICAL_STATES = new Set(['failed', 'offline', 'offln', 'missing']);
/** Physical drive rebuilding / degraded. */
const WARNING_STATES = new Set(['rebuild', 'rbld', 'copyback', 'degraded']);

const VD_OPTIMAL_STATES = new Set(['optimal', 'optl', 'online', 'onln']);
const VD_CRITICAL_STATES = new Set(['failed', 'offline', 'offln', 'missing']);
const VD_WARNING_STATES = new Set([
  'degraded',
  'partially degraded',
  'partiallydegraded',
  'rbld',
  'rebuild',
  'copyback',
  'init',
  'initializing',
  'dgrd',
]);

const BBU_FAILURE_WORDS = [
  'failed',
  'failure',
  'fault',
  'faulty',
  'bad',
  'degraded',
  'critical',
  'offline',
  'missing',
  'replace',
];

// ---------------------------------------------------------------------------
// Helpers (mirrors `_state_word` / `_increased`)
// ---------------------------------------------------------------------------

/**
 * `_state_word` (`disk_health.py:529-533`): normalise a storcli state string for
 * comparison — trim, lowercase, collapse whitespace runs to a single space, and
 * `""` when absent.
 */
export function stateWord(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * `_increased` (`disk_health.py:536-542`): true only when both counters are known
 * and *current* grew. A missing (`null`/`undefined`) side can never be evidence of
 * an increase.
 */
export function increased(
  current: number | null | undefined,
  previous: number | null | undefined,
): boolean {
  return (
    current !== null
    && current !== undefined
    && previous !== null
    && previous !== undefined
    && current > previous
  );
}

// ---------------------------------------------------------------------------
// Health evaluation (mirrors `disk_health.py:545-653`)
// ---------------------------------------------------------------------------

export interface EvaluateDriveOptions {
  /** Rule toggles; each defaults to `true` (the Python `DiskHealthRuleConfig`). */
  rules?: DiskHealthRuleConfig;
  /** Temperature threshold in °C; defaults to `55`. `null` disables the check. */
  temperatureThresholdC?: number | null;
  /** Previous sample of the same drive; enables the error-increase rule. */
  previous?: PhysicalDriveInfo | null;
}

/**
 * `evaluate_drive_health` (`disk_health.py:545-621`): return a copy of `drive`
 * with `health` and machine-code `reasons` set. Reason codes: `state_failed` /
 * `state_degraded` / `predictive_failure` / `smart_flag` / `media_errors` /
 * `other_errors` / `error_increase` / `temperature`. The input is never mutated.
 */
export function evaluateDriveHealth(
  drive: PhysicalDriveInfo,
  opts: EvaluateDriveOptions = {},
): PhysicalDriveInfo {
  const rules = opts.rules;
  const alertState = rules?.alert_on_state_not_optimal ?? true;
  const alertPredictive = rules?.alert_on_predictive_failure ?? true;
  const alertSmart = rules?.alert_on_smart_flag ?? true;
  const alertMedia = rules?.alert_on_media_errors ?? true;
  const alertOther = rules?.alert_on_other_errors ?? true;
  const alertErrorIncrease = rules?.alert_on_error_increase ?? true;
  const temperatureThresholdC =
    opts.temperatureThresholdC === undefined ? 55 : opts.temperatureThresholdC;
  const previous = opts.previous ?? null;

  const reasons: string[] = [];
  let critical = false;
  let warning = false;

  const state = stateWord(drive.state);
  if (alertState) {
    if (CRITICAL_STATES.has(state)) {
      reasons.push('state_failed');
      critical = true;
    } else if (WARNING_STATES.has(state)) {
      reasons.push('state_degraded');
      warning = true;
    }
  }

  if (
    alertPredictive
    && drive.predictiveFailures !== null
    && drive.predictiveFailures !== undefined
    && drive.predictiveFailures > 0
  ) {
    reasons.push('predictive_failure');
    warning = true;
  }

  if (alertSmart && drive.smartAlert === true) {
    reasons.push('smart_flag');
    warning = true;
  }

  if (
    alertMedia
    && drive.mediaErrors !== null
    && drive.mediaErrors !== undefined
    && drive.mediaErrors > 0
  ) {
    reasons.push('media_errors');
    warning = true;
  }

  if (
    alertOther
    && drive.otherErrors !== null
    && drive.otherErrors !== undefined
    && drive.otherErrors > 0
  ) {
    reasons.push('other_errors');
    warning = true;
  }

  if (alertErrorIncrease && previous !== null) {
    if (
      increased(drive.mediaErrors, previous.mediaErrors)
      || increased(drive.otherErrors, previous.otherErrors)
    ) {
      reasons.push('error_increase');
      warning = true;
    }
  }

  if (
    drive.temperatureC !== null
    && drive.temperatureC !== undefined
    && temperatureThresholdC !== null
    && drive.temperatureC > temperatureThresholdC
  ) {
    reasons.push('temperature');
    warning = true;
  }

  const health = critical ? 'critical' : warning ? 'warning' : 'healthy';
  return { ...drive, health, reasons };
}

/**
 * `evaluate_virtual_drive_health` (`disk_health.py:624-641`): return a copy of
 * `vd` with `health`/`reasons` based on its state. Only *Optimal* is healthy; a
 * degraded/rebuilding VD is a warning and an offline/failed/missing VD is
 * critical. A missing state stays `unknown` (never silently healthy); any other
 * known non-optimal state is a warning.
 */
export function evaluateVirtualDriveHealth(vd: VirtualDriveInfo): VirtualDriveInfo {
  const state = stateWord(vd.state);
  if (!state) {
    return { ...vd, health: 'unknown', reasons: [] };
  }
  if (VD_CRITICAL_STATES.has(state)) {
    return { ...vd, health: 'critical', reasons: ['state_failed'] };
  }
  if (VD_OPTIMAL_STATES.has(state)) {
    return { ...vd, health: 'healthy', reasons: [] };
  }
  if (VD_WARNING_STATES.has(state)) {
    return { ...vd, health: 'warning', reasons: ['state_degraded'] };
  }
  // "VD State 非 Optimal → warning" (design 7.2): any other known state warns.
  return { ...vd, health: 'warning', reasons: ['state_degraded'] };
}

/**
 * `_evaluate_controller_health` (`disk_health.py:644-653`): fill controller
 * health from its BBU/CacheVault state when it is known. An unknown/missing BBU
 * state leaves the controller health/reasons untouched (Python returns the
 * original object; we return an equal copy).
 */
export function evaluateControllerHealth(
  controller: DiskControllerInfo,
): DiskControllerInfo {
  const bbu = stateWord(controller.bbuState);
  if (!bbu) {
    return {
      ...controller,
      health: controller.health ?? 'unknown',
      reasons: [...(controller.reasons ?? [])],
    };
  }
  if (BBU_FAILURE_WORDS.some((word) => bbu.includes(word))) {
    return { ...controller, health: 'warning', reasons: ['bbu_not_optimal'] };
  }
  return { ...controller, health: 'healthy', reasons: [] };
}
