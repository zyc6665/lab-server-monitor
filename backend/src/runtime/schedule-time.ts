/**
 * Scheduling time primitives — a line-for-line port of
 * `servermanage/scheduler.py:84-260`.
 *
 * ## Time representation
 *
 * Python's `datetime` carries an optional `tzinfo`; a JS `Date` never does.
 * This module therefore works with two clearly separated shapes:
 *
 * - **Wall-clock Date ("civil Date")** — an ordinary `Date` whose UTC field
 *   getters (`getUTCFullYear()`, `getUTCMonth()`, …) return the *local wall
 *   clock* components in some target timezone, as if those components were UTC.
 *   Build one with `Date.UTC(year, monthIndex, day, hour, minute, second, ms)`.
 *   All of the pure scheduling helpers (`computeDailyFire`, `computeWeeklyFire`,
 *   `currentPeriodTarget`, `shouldRun`, `isReportDue`) operate inside this
 *   civil domain and perform calendar arithmetic on the encoded UTC millisecond
 *   value, so their results never depend on the host machine's timezone
 *   (`process.env.TZ`) or on `Date`'s local-time getters.
 *
 * - **Instant Date** — a normal `Date` whose `getTime()` is a true Unix epoch
 *   time (UTC). `normalizeDt` maps a civil Date into the real instant that the
 *   target zone shows that wall clock; `toLocalWall` maps an instant back to the
 *   civil wall clock of a target zone. Both use `Intl.DateTimeFormat` and are
 *   exact inverses of each other. Together they cover the two branches of
 *   Python's `_normalize` (naive → aware, and aware → `astimezone`), which in JS
 *   must be expressed as two explicit functions because a Date has no `tzinfo`.
 */

const MS_PER_SECOND = 1000;
const MS_PER_DAY = 86_400_000;

/** Parsed `HH:MM` pair. */
export interface Hhmm {
  /** Hour of day, 0-23. */
  h: number;
  /** Minute of hour, 0-59. */
  m: number;
}

// --- Timezone conversion (Intl-backed) --------------------------------------

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** UTC offset (ms) of `timeZone` at the instant `epochMs` (whole-second precision). */
function zoneOffsetMs(epochMs: number, timeZone: string): number {
  if (timeZone === 'UTC') {
    return 0;
  }
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      fields[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour),
    Number(fields.minute),
    Number(fields.second),
  );
  const epochSeconds = Math.floor(epochMs / 1000) * 1000;
  return asUtc - epochSeconds;
}

/** UTC instant (ms) whose local wall clock in `timeZone` is `wallMs`. */
function wallToInstantMs(wallMs: number, timeZone: string): number {
  const firstOffset = zoneOffsetMs(wallMs, timeZone);
  let instant = wallMs - firstOffset;
  const secondOffset = zoneOffsetMs(instant, timeZone);
  if (secondOffset !== firstOffset) {
    instant = wallMs - secondOffset;
  }
  return instant;
}

/**
 * Interprets the UTC fields of `d` as a wall clock in `tz` and returns the real
 * UTC instant at which that wall clock occurs — the analogue of Python
 * `_normalize(naive_datetime, tz)` for a naive input.
 *
 * Feed it a *civil* Date (built via `Date.UTC(...)`), not a real instant; use
 * {@link toLocalWall} for the instant → wall direction.
 */
export function normalizeDt(d: Date, tz: string): Date {
  return new Date(wallToInstantMs(d.getTime(), tz));
}

/**
 * Projects the real UTC instant `instant` onto the wall clock of `tz`, returned
 * as a civil Date (UTC getters == local wall components) — the analogue of
 * Python `aware_dt.astimezone(tz)` when only the wall components are needed.
 *
 * This is the function the scheduler uses to build the `nowLocal` / `lastRunAt`
 * values consumed by the pure helpers below from a real instant:
 * `const nowLocal = toLocalWall(new Date(), tz);`
 * (For a naive DB timestamp without an offset, {@link parseIsoOrNull} already
 * returns a civil Date, so no extra projection is needed.)
 */
export function toLocalWall(instant: Date, tz: string): Date {
  const ms = instant.getTime();
  return new Date(ms + zoneOffsetMs(ms, tz));
}

// --- Calendar helpers -------------------------------------------------------

/**
 * Python `datetime.weekday()`: Monday = 0 … Sunday = 6, computed from the civil
 * (UTC-encoded) fields so it is host-TZ independent.
 */
function pythonWeekday(wall: Date): number {
  // JS getUTCDay(): 0 = Sunday … 6 = Saturday.
  return (wall.getUTCDay() + 6) % 7;
}

/**
 * Python `_align_pair(a, b)`: when one value is naive it is anchored to the
 * other's tzinfo. Both sides already live in the same civil domain here, so the
 * port is the identity; the function is kept to mirror the Python call sites.
 */
function alignPair(first: Date, second: Date): [Date, Date] {
  return [first, second];
}

// --- Parsing ----------------------------------------------------------------

const INTEGER_RE = /^[+-]?\d+$/;

/** Python-ish `repr()` sufficient for error messages. */
function pyRepr(value: unknown): string {
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  return String(value);
}

function invalidHhmm(value: unknown): Error {
  return new Error(`Invalid HH:MM time value: ${pyRepr(value)}`);
}

/**
 * Parses a `"HH:MM"` string — mirrors Python `_parse_hhmm`. Throws `Error`
 * with the exact Python message on any malformed value.
 */
export function parseHhmm(value: string): Hhmm {
  const text = String(value);
  const parts = text.split(':');
  if (parts.length !== 2) {
    throw invalidHhmm(value);
  }
  const hourText = parts[0].trim();
  const minuteText = parts[1].trim();
  if (!INTEGER_RE.test(hourText) || !INTEGER_RE.test(minuteText)) {
    throw invalidHhmm(value);
  }
  const h = Number.parseInt(hourText, 10);
  const m = Number.parseInt(minuteText, 10);
  if (!(h >= 0 && h < 24 && m >= 0 && m < 60)) {
    throw invalidHhmm(value);
  }
  return { h, m };
}

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses an ISO-8601 timestamp — mirrors Python `_parse_iso` + the naive/aware
 * distinction of `datetime.fromisoformat`:
 *
 * - non-string or empty → `null`
 * - unparseable → `null`
 * - timestamp **without** an offset ("naive") → a civil (wall-clock) Date, ready
 *   for {@link normalizeDt} with the target zone
 * - timestamp **with** `Z` / `±HH:MM` ("aware") → a real instant Date, ready for
 *   {@link toLocalWall}
 */
export function parseIsoOrNull(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  const match = ISO_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const fraction = match[7] ?? '';
  const milliseconds =
    fraction.length === 0 ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const offsetToken = match[8];

  // Reject impossible calendar fields the way datetime.fromisoformat does.
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);

  // Naive (no offset) → leave as a civil Date. Aware → collapse to an instant.
  if (offsetToken === undefined || offsetToken === 'Z') {
    return new Date(wallMs);
  }
  const sign = offsetToken[0] === '-' ? -1 : 1;
  const digits = offsetToken.slice(1).replace(':', '');
  const offsetHours = Number(digits.slice(0, 2));
  const offsetMinutes = Number(digits.slice(2, 4));
  const offsetMs = sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  return new Date(wallMs - offsetMs);
}

// --- Scheduling predicates and fire-time computation ------------------------

/**
 * Mirrors Python `should_run`: a task is due when it has never run, when its
 * interval is non-positive (always due), or when at least `intervalSeconds`
 * have elapsed since `lastRunAt` (`now - last >= interval`).
 */
export function shouldRun(
  lastRunAt: Date | null,
  now: Date,
  intervalSeconds: number,
): boolean {
  if (lastRunAt === null || lastRunAt === undefined) {
    return true;
  }
  if (intervalSeconds <= 0) {
    return true;
  }
  const [last, current] = alignPair(lastRunAt, now);
  return current.getTime() - last.getTime() >= intervalSeconds * MS_PER_SECOND;
}

/**
 * Mirrors Python `compute_daily_fire`: today's occurrence of `hhmm` in the civil
 * domain, rolled to tomorrow when `nowLocal` is already at or past it.
 */
export function computeDailyFire(nowLocal: Date, hhmm: string): Date {
  const { h, m } = parseHhmm(hhmm);
  let target = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate(),
      h,
      m,
      0,
      0,
    ),
  );
  if (target.getTime() <= nowLocal.getTime()) {
    target = new Date(target.getTime() + MS_PER_DAY);
  }
  return target;
}

/**
 * Mirrors Python `compute_weekly_fire`: the next occurrence of `hhmm` on
 * `weekday` (Monday = 0, Sunday = 6), rolled a full week forward when the
 * occurrence in the current week is already at or past `nowLocal`.
 *
 * Throws when `weekday` is outside 0..6 (matching Python's `ValueError`).
 */
export function computeWeeklyFire(
  nowLocal: Date,
  weekday: number,
  hhmm: string,
): Date {
  if (!(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
    throw new Error(`weekday must be in 0..6, got ${pyRepr(weekday)}`);
  }
  const { h, m } = parseHhmm(hhmm);
  const daysAhead = (((weekday - pythonWeekday(nowLocal)) % 7) + 7) % 7;
  let target = new Date(
    Date.UTC(
      nowLocal.getUTCFullYear(),
      nowLocal.getUTCMonth(),
      nowLocal.getUTCDate() + daysAhead,
      h,
      m,
      0,
      0,
    ),
  );
  if (target.getTime() <= nowLocal.getTime()) {
    target = new Date(target.getTime() + 7 * MS_PER_DAY);
  }
  return target;
}

/**
 * Mirrors Python `_current_period_target`: choose the occurrence an interval
 * task should be reconciled against before it has a recorded `lastRunAt`.
 *
 * - `spacingDays <= 2` (daily-like): today's `hhmm` (past or future).
 * - `spacingDays <= 14` (weekly-like): this week's `weekday` at `hhmm`.
 * - otherwise: the next occurrence is the only sensible bucket.
 *
 * `spacingDays` is the nominal gap between fires (`1` for daily, `7` for
 * weekly); `weekday` is required for the weekly branch.
 */
export function currentPeriodTarget(
  nowLocal: Date,
  spacingDays: number,
  hhmm: string,
  weekday?: number,
): Date {
  const { h, m } = parseHhmm(hhmm);

  if (spacingDays <= 2) {
    // Today's occurrence at hhmm; may already be in the past — that is fine,
    // `isReportDue` compares it against (a possibly null) lastRunAt.
    return new Date(
      Date.UTC(
        nowLocal.getUTCFullYear(),
        nowLocal.getUTCMonth(),
        nowLocal.getUTCDate(),
        h,
        m,
        0,
        0,
      ),
    );
  }

  if (spacingDays <= 14) {
    if (weekday === undefined) {
      throw new Error('currentPeriodTarget: weekday is required for a weekly cadence');
    }
    if (!(Number.isInteger(weekday) && weekday >= 0 && weekday <= 6)) {
      throw new Error(`weekday must be in 0..6, got ${pyRepr(weekday)}`);
    }
    const weekStart = new Date(
      Date.UTC(
        nowLocal.getUTCFullYear(),
        nowLocal.getUTCMonth(),
        nowLocal.getUTCDate() - pythonWeekday(nowLocal),
        0,
        0,
        0,
        0,
      ),
    );
    return new Date(
      Date.UTC(
        weekStart.getUTCFullYear(),
        weekStart.getUTCMonth(),
        weekStart.getUTCDate() + weekday,
        h,
        m,
        0,
        0,
      ),
    );
  }

  // Sparse cadences: the next occurrence; a (future) target is simply not due.
  return weekday === undefined
    ? computeDailyFire(nowLocal, hhmm)
    : computeWeeklyFire(nowLocal, weekday, hhmm);
}

/**
 * Mirrors Python `is_report_due`: a report occurrence `target` is due when it is
 * not in the future and has not already been recorded as run at or after it.
 */
export function isReportDue(
  nowLocal: Date,
  lastRunAt: Date | null,
  target: Date,
): boolean {
  const [targetAligned, nowAligned] = alignPair(target, nowLocal);
  if (targetAligned.getTime() > nowAligned.getTime()) {
    return false;
  }
  if (lastRunAt === null || lastRunAt === undefined) {
    return true;
  }
  const [lastAligned, targetAgain] = alignPair(lastRunAt, targetAligned);
  return lastAligned.getTime() < targetAgain.getTime();
}
