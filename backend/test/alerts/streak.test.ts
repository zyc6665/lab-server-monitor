import { describe, it, expect } from 'vitest';

import {
  StreakTracker,
  effectivePeriods,
  clampPeriods,
  DEFAULT_CONSECUTIVE_PERIODS,
  MIN_CONSECUTIVE_PERIODS,
  MAX_CONSECUTIVE_PERIODS,
} from '../../src/alerts/streak';

describe('StreakTracker.observe', () => {
  it('triggers exactly when the present streak reaches the threshold', () => {
    const tracker = new StreakTracker();
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: true,
      recover: false,
      streak: 2,
    });
  });

  it('does not trigger before the threshold is reached', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 3);
    expect(tracker.observe('web-1', 'cpu', true, 3).trigger).toBe(false);
  });

  it('triggers only once, not on every later present observation', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 2);
    expect(tracker.observe('web-1', 'cpu', true, 2).trigger).toBe(true);
    expect(tracker.observe('web-1', 'cpu', true, 2).trigger).toBe(false);
    expect(tracker.observe('web-1', 'cpu', true, 2).trigger).toBe(false);
  });

  it('recovers exactly when the absent streak reaches the threshold', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 2);
    tracker.observe('web-1', 'cpu', true, 2);
    expect(tracker.observe('web-1', 'cpu', false, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
    expect(tracker.observe('web-1', 'cpu', false, 2)).toEqual({
      trigger: false,
      recover: true,
      streak: 2,
    });
  });

  it('recovers only once, not on every later absent observation', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 1);
    expect(tracker.observe('web-1', 'cpu', false, 1).recover).toBe(true);
    expect(tracker.observe('web-1', 'cpu', false, 1).recover).toBe(false);
  });

  it('resets a present streak to 1 after a good interval (bad -> good -> bad)', () => {
    const tracker = new StreakTracker();
    // bad, once
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
    // good: clears the present count
    expect(tracker.observe('web-1', 'cpu', false, 2).streak).toBe(1);
    // bad again: must restart at 1, not resume at 2 and fire immediately
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
    // a genuinely sustained second bad period is what triggers
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: true,
      recover: false,
      streak: 2,
    });
  });

  it('resets an absent streak to 1 after a bad interval', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', false, 2);
    tracker.observe('web-1', 'cpu', true, 2);
    expect(tracker.observe('web-1', 'cpu', false, 2).streak).toBe(1);
  });

  it('keeps streaks independent per fingerprint', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 2);
    expect(tracker.observe('web-1', 'cpu', true, 2).trigger).toBe(true);
    // A different fingerprint on the same host has its own counter.
    expect(tracker.observe('web-1', 'memory', true, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
  });

  it('keeps streaks independent per host', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 2);
    tracker.observe('web-1', 'cpu', true, 2);
    expect(tracker.observe('web-2', 'cpu', true, 2).streak).toBe(1);
  });

  it('reports the running consecutive count in `streak`', () => {
    const tracker = new StreakTracker();
    expect(tracker.observe('web-1', 'cpu', true, 5).streak).toBe(1);
    expect(tracker.observe('web-1', 'cpu', true, 5).streak).toBe(2);
    expect(tracker.observe('web-1', 'cpu', true, 5).streak).toBe(3);
    expect(tracker.observe('web-1', 'cpu', false, 5).streak).toBe(1);
  });

  it('forgets all state on reset()', () => {
    const tracker = new StreakTracker();
    tracker.observe('web-1', 'cpu', true, 2);
    tracker.reset();
    expect(tracker.observe('web-1', 'cpu', true, 2)).toEqual({
      trigger: false,
      recover: false,
      streak: 1,
    });
  });

  it('clamps a bogus effectivePeriods passed to observe', () => {
    const tracker = new StreakTracker();
    // periods 0 is clamped to 1, so the very first present observation fires.
    expect(tracker.observe('web-1', 'cpu', true, 0).trigger).toBe(true);
    const other = new StreakTracker();
    // periods 99 is clamped to 10; nine observations must not fire.
    for (let i = 0; i < 9; i += 1) {
      expect(other.observe('web-1', 'cpu', true, 99).trigger).toBe(false);
    }
    expect(other.observe('web-1', 'cpu', true, 99).trigger).toBe(true);
  });

  it('with periods=1 triggers on the first present and recovers on the first absent', () => {
    const tracker = new StreakTracker();
    expect(tracker.observe('web-1', 'cpu', true, 1).trigger).toBe(true);
    expect(tracker.observe('web-1', 'cpu', false, 1).recover).toBe(true);
  });
});

describe('effectivePeriods', () => {
  it('defaults to 2 when neither host nor global is provided', () => {
    expect(effectivePeriods('web-1', undefined)).toBe(DEFAULT_CONSECUTIVE_PERIODS);
    expect(DEFAULT_CONSECUTIVE_PERIODS).toBe(2);
  });

  it('falls back to the global period count', () => {
    expect(effectivePeriods('web-1', {}, 5)).toBe(5);
    expect(effectivePeriods('web-1', undefined, 3)).toBe(3);
  });

  it('lets a per-host override win over the global value', () => {
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: 4 } }, 5)).toBe(4);
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: 1 } }, 5)).toBe(1);
  });

  it('falls back to the global value when the per-host override is null', () => {
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: null } }, 5)).toBe(5);
  });

  it('accepts a bare number/string per-host entry', () => {
    expect(effectivePeriods('web-1', { 'web-1': 3 }, 5)).toBe(3);
    expect(effectivePeriods('web-1', { 'web-1': '4' }, 5)).toBe(4);
  });

  it('supports a Map of per-host rules', () => {
    const rules = new Map([['web-1', { consecutive_periods: 6 }]]);
    expect(effectivePeriods('web-1', rules, 2)).toBe(6);
    expect(effectivePeriods('web-2', rules, 2)).toBe(2);
  });

  it('supports an AppConfig-style array of host configs', () => {
    const servers = [
      { name: 'web-1', alert_rules: { consecutive_periods: 4 } },
      { name: 'web-2', alert_rules: null },
    ];
    expect(effectivePeriods('web-1', servers, 2)).toBe(4);
    expect(effectivePeriods('web-2', servers, 2)).toBe(2);
    expect(effectivePeriods('web-3', servers, 2)).toBe(2);
  });

  it('clamps a low period count up to 1', () => {
    expect(effectivePeriods('web-1', {}, 0)).toBe(MIN_CONSECUTIVE_PERIODS);
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: -3 } }, 2)).toBe(1);
  });

  it('clamps a high period count down to 10', () => {
    expect(effectivePeriods('web-1', {}, 99)).toBe(MAX_CONSECUTIVE_PERIODS);
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: 42 } }, 2)).toBe(10);
  });

  it('falls back to the global value on an unparseable override', () => {
    expect(effectivePeriods('web-1', { 'web-1': { consecutive_periods: 'abc' } }, 5)).toBe(5);
  });

  it('falls back to the global value on an unparseable global', () => {
    expect(effectivePeriods('web-1', {}, 'nope')).toBe(DEFAULT_CONSECUTIVE_PERIODS);
  });

  it('clampPeriods trims fractions and defaults garbage', () => {
    expect(clampPeriods(3.9)).toBe(3);
    expect(clampPeriods(undefined)).toBe(DEFAULT_CONSECUTIVE_PERIODS);
    expect(clampPeriods(-1)).toBe(1);
    expect(clampPeriods(100)).toBe(10);
  });
});
