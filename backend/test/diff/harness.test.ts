/**
 * Unit tests for the §9.1 normalisation primitives that power the diff harness.
 * These do not touch Python and always run.
 */
import { describe, expect, it } from 'vitest';

import { applyMask, diffValues, instantMicros, normalizeValue, type Diff } from './harness';

describe('normalizeValue (§9.1)', () => {
  it('renders floats with six decimals regardless of int/float origin', () => {
    expect(normalizeValue(10)).toBe('10.000000');
    expect(normalizeValue(10.0)).toBe('10.000000');
    expect(normalizeValue(1 / 3)).toBe('0.333333');
  });

  it('parses timestamps to the same UTC instant across offsets', () => {
    expect(instantMicros('2026-01-15T10:00:00+00:00')).toBe(instantMicros('2026-01-15T18:00:00+08:00'));
    expect(instantMicros('2026-01-15T10:00:00.123456+00:00')).toBe(
      instantMicros('2026-01-15T10:00:00.123456Z'),
    );
    // Microsecond precision is preserved.
    expect(instantMicros('2026-01-15T10:00:00.123456+00:00')).not.toBe(
      instantMicros('2026-01-15T10:00:00.123457+00:00'),
    );
  });

  it('leaves plain strings and non-ISO values untouched', () => {
    expect(normalizeValue('hello')).toBe('hello');
    expect(normalizeValue('2026-01-10')).toBe('2026-01-10');
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(true)).toBe(true);
  });

  it('sorts object keys and recurses into arrays', () => {
    expect(normalizeValue({ b: 2, a: 1 })).toEqual({ a: '1.000000', b: '2.000000' });
    expect(normalizeValue([1, 'x', null])).toEqual(['1.000000', 'x', null]);
  });
});

describe('applyMask', () => {
  it('masks volatile keys recursively (pid/port) leaving structure intact', () => {
    const masked = applyMask(
      { host: 'h1', runtime: { pid: 4242, port: 8080, uptime: 5 }, rows: [{ port: 1 }] },
      ['pid', 'port'],
    );
    expect(masked).toEqual({
      host: 'h1',
      runtime: { pid: '<masked>', port: '<masked>', uptime: 5 },
      rows: [{ port: '<masked>' }],
    });
  });
});

describe('diffValues', () => {
  it('returns no differences for equal normalised values', () => {
    const out: Diff[] = [];
    diffValues(normalizeValue({ a: 1, t: '2026-01-15T10:00:00+00:00' }), normalizeValue({ t: '2026-01-15T18:00:00+08:00', a: 1.0 }), 'root', out);
    expect(out).toEqual([]);
  });

  it('reports value, missing-key and array-length differences', () => {
    const out: Diff[] = [];
    diffValues(
      normalizeValue({ a: 1, b: [1, 2], c: 'x' }),
      normalizeValue({ a: 2, b: [1], d: 'y' }),
      'root',
      out,
    );
    const paths = out.map((diff) => diff.path).sort();
    expect(paths).toEqual(['root.a', 'root.b (length)', 'root.c', 'root.d']);
  });
});
