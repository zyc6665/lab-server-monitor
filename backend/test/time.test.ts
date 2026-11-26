import { describe, it, expect } from 'vitest';

import { nowIsoUtc } from '../src/storage/time';

// YYYY-MM-DDTHH:MM:SS.ffffff+00:00 — exactly six fractional digits, +00:00.
const STRICT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;

describe('nowIsoUtc', () => {
  it('matches the strict six-digit microsecond UTC format', () => {
    expect(nowIsoUtc()).toMatch(STRICT);
  });

  it('formats the fixed-date example as ...123000+00:00', () => {
    expect(nowIsoUtc(new Date('2026-01-02T03:04:05.123Z'))).toBe(
      '2026-01-02T03:04:05.123000+00:00',
    );
  });

  it('always emits six fractional digits even when milliseconds are zero', () => {
    expect(nowIsoUtc(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000000+00:00',
    );
  });

  it('converts an offset input to UTC components', () => {
    // 2026-01-02T11:04:05.123+08:00 == 2026-01-02T03:04:05.123Z
    expect(nowIsoUtc(new Date('2026-01-02T11:04:05.123+08:00'))).toBe(
      '2026-01-02T03:04:05.123000+00:00',
    );
  });

  it('never uses the toISOString shape (no trailing Z)', () => {
    expect(nowIsoUtc(new Date('2026-01-02T03:04:05.123Z'))).not.toContain('Z');
  });

  it('ends with the explicit +00:00 UTC offset (Python isoformat shape)', () => {
    expect(nowIsoUtc()).toMatch(/\+00:00$/);
  });
});
