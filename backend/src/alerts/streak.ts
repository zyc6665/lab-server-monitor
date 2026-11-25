/**
 * Consecutive-period gating for alerts, mirroring the streak machine in
 * `servermanage/app.py` (`run_status_once`, approx. lines 646-725).
 *
 * The Python monitor keeps two dictionaries keyed by `(host, fingerprint)`:
 * `_alert_streaks` counts consecutive *present* observations and
 * `_clear_streaks` counts consecutive *absent* observations.  A present
 * streak only fires an alert once it reaches the host's effective period
 * count; an absent streak only recovers an alert once it reaches the same
 * threshold.  Because each side resets the other, a bad → good → bad wobble
 * restarts the present count at 1 and can never be mistaken for a sustained
 * condition.
 *
 * This module factors that logic out as a deterministic, side-effect-free
 * tracker so it can be unit tested in isolation.  The caller is responsible
 * for calling {@link StreakTracker.observe} explicitly for *every* fingerprint
 * it wants tracked — including absent ones (`present = false`).  Fingerprints
 * the caller never observes are simply not part of the state.
 *
 * Reference: `servermanage/app.py` `_effective_periods` (lines 472-493) and
 * `servermanage/alerts.py` (streak consumers).
 */

/** Default consecutive-period threshold when neither host nor global sets one. */
export const DEFAULT_CONSECUTIVE_PERIODS = 2;

/** Lower bound applied to the effective period count. */
export const MIN_CONSECUTIVE_PERIODS = 1;

/** Upper bound applied to the effective period count. */
export const MAX_CONSECUTIVE_PERIODS = 10;

/** A per-host rules object as stored in `HostConfig.alert_rules`. */
export interface PeriodRule {
  /** `alert_rules.consecutive_periods`; `null`/missing means "use global". */
  consecutive_periods?: number | string | null;
}

/** A single per-host override: a rules object, or a bare numeric value. */
export type PeriodOverride = PeriodRule | number | string | null | undefined;

/** A host config object as found in `AppConfig.servers`. */
export interface HostPeriodConfig {
  name?: string;
  alert_rules?: PeriodRule | null;
  consecutive_periods?: number | string | null;
}

/**
 * Per-host rule lookup.  Accepts a plain object keyed by host name
 * (`{"web-1": {consecutive_periods: 3}}`), a `Map` with the same shape, or a
 * `HostConfig[]`-style array of `{name, alert_rules}` objects.  A bare
 * number/string entry is treated as `consecutive_periods`.
 */
export type PerHostRules =
  | Readonly<Record<string, PeriodOverride>>
  | ReadonlyMap<string, PeriodOverride>
  | ReadonlyArray<HostPeriodConfig>;

/** Outcome of one {@link StreakTracker.observe} call. */
export interface StreakResult {
  /** True only on the observation where a present streak reaches the threshold. */
  trigger: boolean;
  /** True only on the observation where an absent streak reaches the threshold. */
  recover: boolean;
  /** Current consecutive count for the observed state (present or absent). */
  streak: number;
}

interface StreakState {
  present: number;
  absent: number;
}

function coerceInt(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/** Clamps a period count into `[1, 10]`, falling back to the default on garbage. */
export function clampPeriods(value: number | string | null | undefined): number {
  const parsed = coerceInt(value);
  const periods = parsed === null ? DEFAULT_CONSECUTIVE_PERIODS : parsed;
  return Math.max(MIN_CONSECUTIVE_PERIODS, Math.min(MAX_CONSECUTIVE_PERIODS, periods));
}

function lookupRule(perHostRules: PerHostRules | null | undefined, host: string): PeriodOverride {
  if (!perHostRules) {
    return undefined;
  }
  if (perHostRules instanceof Map) {
    return perHostRules.get(host);
  }
  if (Array.isArray(perHostRules)) {
    const entry = perHostRules.find((item) => item?.name === host);
    if (!entry) {
      return undefined;
    }
    if (entry.alert_rules !== null && entry.alert_rules !== undefined) {
      return entry.alert_rules;
    }
    return entry.consecutive_periods;
  }
  return (perHostRules as Record<string, PeriodOverride>)[host];
}

/**
 * Resolves the number of consecutive periods a host must be in a state before
 * an alert is raised (or recovered).  Mirrors `_effective_periods` in
 * `servermanage/app.py`:
 *
 * - a per-host `consecutive_periods` override wins over the global default,
 * - the global default is `alerts.consecutive_periods`, itself defaulting to 2,
 * - the result is always clamped to `[1, 10]`.
 *
 * `host` that has no entry (or a `null` override) falls back to the global
 * value.  Unparseable overrides fall back to the global value as well, which
 * matches Python's `int(value)` raising `TypeError`/`ValueError` there.
 */
export function effectivePeriods(
  host: string,
  perHostRules: PerHostRules | null | undefined,
  globalPeriods?: number | string | null,
): number {
  const global = coerceInt(globalPeriods);
  const fallback = global === null ? DEFAULT_CONSECUTIVE_PERIODS : global;

  const rule = lookupRule(perHostRules, host);
  const override =
    rule !== null && typeof rule === 'object' ? rule.consecutive_periods : rule;
  const parsedOverride = coerceInt(override);

  return clampPeriods(parsedOverride === null ? fallback : parsedOverride);
}

function streakKey(host: string, fingerprint: string): string {
  // A NUL separator cannot occur in a host name or alert fingerprint, so the
  // composite key is unambiguous (a plain ":" could collide).
  return `${host}\u0000${fingerprint}`;
}

/**
 * Tracks consecutive present/absent observations per `(host, fingerprint)`.
 *
 * ```ts
 * const tracker = new StreakTracker();
 * tracker.observe('web-1', 'cpu', true, 2);  // {trigger: false, streak: 1}
 * tracker.observe('web-1', 'cpu', true, 2);  // {trigger: true,  streak: 2}
 * tracker.observe('web-1', 'cpu', false, 2); // {recover: false, streak: 1}
 * tracker.observe('web-1', 'cpu', false, 2); // {recover: true,  streak: 2}
 * ```
 */
export class StreakTracker {
  private readonly streaks = new Map<string, StreakState>();

  /**
   * Records one observation and reports whether it crossed a threshold.
   *
   * `trigger` is true only on the exact observation where the present streak
   * reaches `effectivePeriods`; `recover` likewise for the absent streak.  Any
   * observation of one state resets the other state's counter, so a single
   * good interval between two bad ones restarts the bad streak at 1.
   */
  observe(
    host: string,
    fingerprint: string,
    present: boolean,
    effectivePeriods: number,
  ): StreakResult {
    const periods = clampPeriods(effectivePeriods);
    const key = streakKey(host, fingerprint);
    const state = this.streaks.get(key) ?? { present: 0, absent: 0 };

    if (present) {
      state.present += 1;
      state.absent = 0;
      this.streaks.set(key, state);
      return {
        trigger: state.present === periods,
        recover: false,
        streak: state.present,
      };
    }

    state.absent += 1;
    state.present = 0;
    this.streaks.set(key, state);
    return {
      trigger: false,
      recover: state.absent === periods,
      streak: state.absent,
    };
  }

  /** Drops every tracked streak (used when the monitor is reconfigured). */
  reset(): void {
    this.streaks.clear();
  }
}
