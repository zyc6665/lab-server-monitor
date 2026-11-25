import { describe, it, expect } from 'vitest';

import {
  computeDailyFire,
  computeWeeklyFire,
  currentPeriodTarget,
  isReportDue,
  normalizeDt,
  parseHhmm,
  parseIsoOrNull,
  shouldRun,
  toLocalWall,
} from '../../src/runtime/schedule-time';

/**
 * Build a civil ("wall clock") Date for 2026-11-06 etc. Every expected value in
 * this file is expressed with `Date.UTC(...)`, never local getters, so the suite
 * is completely independent of the host `process.env.TZ`.
 */
function wall(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
}

/** Wall-clock millisecond value for an expected civil instant. */
function wallMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

describe('parseHhmm', () => {
  it('parses a normal HH:MM string', () => {
    expect(parseHhmm('09:30')).toEqual({ h: 9, m: 30 });
  });

  it('parses the day boundaries', () => {
    expect(parseHhmm('00:00')).toEqual({ h: 0, m: 0 });
    expect(parseHhmm('23:59')).toEqual({ h: 23, m: 59 });
  });

  it('rejects an out-of-range hour', () => {
    expect(() => parseHhmm('24:00')).toThrow(
      "Invalid HH:MM time value: '24:00'",
    );
  });

  it('rejects an out-of-range minute', () => {
    expect(() => parseHhmm('9:60')).toThrow(
      "Invalid HH:MM time value: '9:60'",
    );
  });

  it('rejects a missing colon', () => {
    expect(() => parseHhmm('0900')).toThrow(
      "Invalid HH:MM time value: '0900'",
    );
  });

  it('rejects extra segments', () => {
    expect(() => parseHhmm('9:00:00')).toThrow(
      "Invalid HH:MM time value: '9:00:00'",
    );
  });
});

describe('parseIsoOrNull', () => {
  it('returns null for non-string / empty input', () => {
    expect(parseIsoOrNull(null)).toBeNull();
    expect(parseIsoOrNull(undefined)).toBeNull();
    expect(parseIsoOrNull('')).toBeNull();
    expect(parseIsoOrNull(123 as unknown)).toBeNull();
  });

  it('returns null for an unparseable string', () => {
    expect(parseIsoOrNull('not-a-date')).toBeNull();
  });

  it('keeps a naive timestamp as a civil wall-clock Date', () => {
    const parsed = parseIsoOrNull('2026-11-06T09:00:00');
    expect(parsed).not.toBeNull();
    expect(parsed!.getTime()).toBe(wallMs(2026, 11, 6, 9, 0));
  });

  it('collapses a Z timestamp to a real instant', () => {
    const parsed = parseIsoOrNull('2026-11-06T01:00:00Z');
    expect(parsed!.getTime()).toBe(wallMs(2026, 11, 6, 1, 0));
  });

  it('collapses a +08:00 timestamp to a real instant', () => {
    const parsed = parseIsoOrNull('2026-11-06T09:00:00+08:00');
    expect(parsed!.getTime()).toBe(wallMs(2026, 11, 6, 1, 0));
  });

  it('accepts a space separator and fractional seconds (naive)', () => {
    const parsed = parseIsoOrNull('2026-11-06 09:00:00.5');
    expect(parsed!.getTime()).toBe(wallMs(2026, 11, 6, 9, 0) + 500);
  });
});

describe('normalizeDt / toLocalWall (Intl-backed, explicit tz)', () => {
  it('maps a Shanghai wall clock to the UTC instant', () => {
    const inst = normalizeDt(wall(2026, 11, 6, 9, 0), 'Asia/Shanghai');
    expect(inst.toISOString()).toBe('2026-11-06T01:00:00.000Z');
    expect(inst.getTime()).toBe(1793926800000);
  });

  it('handles the Shanghai midnight cross-day boundary', () => {
    const inst = normalizeDt(wall(2026, 11, 6, 0, 0), 'Asia/Shanghai');
    expect(inst.toISOString()).toBe('2026-11-05T16:00:00.000Z');
    expect(inst.getTime()).toBe(1793894400000);
  });

  it('handles the Shanghai 23:59 cross-day boundary', () => {
    const inst = normalizeDt(wall(2026, 11, 5, 23, 59), 'Asia/Shanghai');
    expect(inst.toISOString()).toBe('2026-11-05T15:59:00.000Z');
  });

  it('uses the summer (EDT) offset for New York', () => {
    const inst = normalizeDt(wall(2026, 7, 1, 12, 0), 'America/New_York');
    expect(inst.toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(inst.getTime()).toBe(1782921600000);
  });

  it('uses the winter (EST) offset for New York', () => {
    const inst = normalizeDt(wall(2026, 1, 15, 12, 0), 'America/New_York');
    expect(inst.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    expect(inst.getTime()).toBe(1768496400000);
  });

  it('handles a half-hour offset (Asia/Kolkata)', () => {
    const inst = normalizeDt(wall(2026, 11, 6, 9, 0), 'Asia/Kolkata');
    expect(inst.toISOString()).toBe('2026-11-06T03:30:00.000Z');
    expect(inst.getTime()).toBe(1793935800000);
  });

  it('is the inverse of normalizeDt (instant -> wall)', () => {
    const wallClock = toLocalWall(new Date('2026-11-06T01:00:00Z'), 'Asia/Shanghai');
    expect(wallClock.getTime()).toBe(wallMs(2026, 11, 6, 9, 0));
  });

  it('round-trips wall -> instant -> wall', () => {
    const start = wall(2026, 7, 1, 12, 0);
    const roundTripped = toLocalWall(normalizeDt(start, 'America/New_York'), 'America/New_York');
    expect(roundTripped.getTime()).toBe(start.getTime());
  });

  it('supports the Task-2 recipe: instant -> local wall -> daily fire', () => {
    // 2026-11-07T02:00:00Z == 10:00 in Asia/Shanghai.
    const nowInstant = new Date('2026-11-07T02:00:00Z');
    const nowLocal = toLocalWall(nowInstant, 'Asia/Shanghai');
    expect(nowLocal.getTime()).toBe(wallMs(2026, 11, 7, 10, 0));
    const target = computeDailyFire(nowLocal, '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 8, 9, 0));
  });
});

describe('computeDailyFire', () => {
  it('returns today when the time is still ahead', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 8, 0), '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 9, 0));
  });

  it('rolls to tomorrow when the time has passed', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 10, 0), '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 7, 9, 0));
  });

  it('rolls to tomorrow on an exact equality (target <= now)', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 9, 0), '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 7, 9, 0));
  });

  it('crosses the next-day boundary for a midnight target', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 23, 59), '00:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 7, 0, 0));
  });

  it('stays on the same day for a 23:59 target from 00:00', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 0, 0), '23:59');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 23, 59));
  });

  it('rolls a 23:59 target when now is exactly 23:59', () => {
    const target = computeDailyFire(wall(2026, 11, 6, 23, 59), '23:59');
    expect(target.getTime()).toBe(wallMs(2026, 11, 7, 23, 59));
  });
});

describe('computeWeeklyFire (Python weekday: Monday = 0)', () => {
  it('fires this Friday when now is Wed', () => {
    const target = computeWeeklyFire(wall(2026, 11, 4, 10, 0), 4, '16:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 16, 0));
  });

  it('fires next Friday when now is Saturday', () => {
    const target = computeWeeklyFire(wall(2026, 11, 7, 10, 0), 4, '16:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 13, 16, 0));
  });

  it('fires today when Friday 16:00 is still ahead', () => {
    const target = computeWeeklyFire(wall(2026, 11, 6, 9, 0), 4, '16:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 16, 0));
  });

  it('rolls a full week on exact equality (target <= now)', () => {
    const target = computeWeeklyFire(wall(2026, 11, 6, 16, 0), 4, '16:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 13, 16, 0));
  });

  it('crosses the week boundary from Sunday to Monday (weekday=0)', () => {
    const target = computeWeeklyFire(wall(2026, 11, 8, 10, 0), 0, '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 9, 9, 0));
  });

  it('rejects an out-of-range weekday', () => {
    expect(() => computeWeeklyFire(wall(2026, 11, 6, 9, 0), 7, '09:00')).toThrow(
      'weekday must be in 0..6',
    );
  });
});

describe('currentPeriodTarget', () => {
  it('daily: today\'s occurrence even when already past', () => {
    const target = currentPeriodTarget(wall(2026, 11, 6, 10, 0), 1, '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 9, 0));
  });

  it('daily: today\'s occurrence when still ahead', () => {
    const target = currentPeriodTarget(wall(2026, 11, 6, 8, 0), 1, '09:00');
    expect(target.getTime()).toBe(wallMs(2026, 11, 6, 9, 0));
  });

  it('weekly: this week\'s Monday from a Friday', () => {
    const target = currentPeriodTarget(wall(2026, 11, 6, 10, 0), 7, '09:00', 0);
    expect(target.getTime()).toBe(wallMs(2026, 11, 2, 9, 0));
  });

  it('weekly: this week\'s Monday from a Sunday', () => {
    const target = currentPeriodTarget(wall(2026, 11, 8, 10, 0), 7, '09:00', 0);
    expect(target.getTime()).toBe(wallMs(2026, 11, 2, 9, 0));
  });

  it('weekly: this week\'s Monday from Monday before 09:00', () => {
    const target = currentPeriodTarget(wall(2026, 11, 2, 8, 0), 7, '09:00', 0);
    expect(target.getTime()).toBe(wallMs(2026, 11, 2, 9, 0));
  });
});

describe('shouldRun', () => {
  const now = wall(2026, 11, 6, 10, 0);

  it('is always due when lastRunAt is null', () => {
    expect(shouldRun(null, now, 600)).toBe(true);
  });

  it('is not due before the interval has elapsed', () => {
    expect(shouldRun(new Date(now.getTime() - 9 * 60_000), now, 600)).toBe(false);
  });

  it('is due exactly at the interval boundary (>=)', () => {
    expect(shouldRun(new Date(now.getTime() - 10 * 60_000), now, 600)).toBe(true);
  });

  it('is due after the interval has elapsed', () => {
    expect(shouldRun(new Date(now.getTime() - 11 * 60_000), now, 600)).toBe(true);
  });

  it('treats a zero interval as always due', () => {
    expect(shouldRun(now, now, 0)).toBe(true);
  });

  it('treats a negative interval as always due', () => {
    expect(shouldRun(now, now, -5)).toBe(true);
  });

  it('is not due when lastRunAt is in the future', () => {
    expect(shouldRun(new Date(now.getTime() + 5 * 60_000), now, 600)).toBe(false);
  });
});

describe('isReportDue', () => {
  const now = wall(2026, 11, 6, 10, 0);

  it('is due for a null lastRunAt with a non-future target', () => {
    expect(isReportDue(now, null, wall(2026, 11, 6, 9, 0))).toBe(true);
  });

  it('is due for a null lastRunAt when target equals now', () => {
    expect(isReportDue(now, null, wall(2026, 11, 6, 10, 0))).toBe(true);
  });

  it('is not due for a null lastRunAt with a future target', () => {
    expect(isReportDue(now, null, wall(2026, 11, 6, 11, 0))).toBe(false);
  });

  it('is due when lastRunAt is before the past target', () => {
    expect(
      isReportDue(now, wall(2026, 11, 6, 8, 0), wall(2026, 11, 6, 9, 0)),
    ).toBe(true);
  });

  it('is not due when lastRunAt equals the target', () => {
    expect(
      isReportDue(now, wall(2026, 11, 6, 9, 0), wall(2026, 11, 6, 9, 0)),
    ).toBe(false);
  });

  it('is not due when lastRunAt is after the target', () => {
    expect(
      isReportDue(now, wall(2026, 11, 6, 9, 30), wall(2026, 11, 6, 9, 0)),
    ).toBe(false);
  });

  it('is not due when the target is in the future', () => {
    expect(
      isReportDue(now, wall(2026, 11, 6, 8, 0), wall(2026, 11, 6, 11, 0)),
    ).toBe(false);
  });
});

describe('catch-up after downtime (fires only once)', () => {
  it('catches up the single missed occurrence, then stays quiet', () => {
    // Last ran 2026-11-03 09:00; the machine was down for three days.
    const last = wall(2026, 11, 3, 9, 0);
    const now = wall(2026, 11, 6, 10, 0);

    // The occurrence derived from the last run is 2026-11-04 09:00.
    const missedTarget = computeDailyFire(last, '09:00');
    expect(missedTarget.getTime()).toBe(wallMs(2026, 11, 4, 9, 0));
    expect(isReportDue(now, last, missedTarget)).toBe(true);

    // After the catch-up run at `now`, the next target is 2026-11-07 09:00,
    // and the very same `now` no longer considers it due (only one catch-up).
    const nextTarget = computeDailyFire(now, '09:00');
    expect(nextTarget.getTime()).toBe(wallMs(2026, 11, 7, 9, 0));
    expect(isReportDue(now, now, nextTarget)).toBe(false);
  });
});
