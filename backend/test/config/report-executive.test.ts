/**
 * Tests for the report `executive` (管理层摘要版) settings sub-section.
 *
 * The daily report already knows how to send an executive variant
 * (`src/runtime/wiring.ts`), but the settings schema/template never exposed it.
 * These cases pin the settings contract: coercible `to_addrs`, safe defaults,
 * strict rejection of a non-boolean `enabled`, exposure through
 * `publicSettings`, and — see plan Review Focus #3 — a partial save that only
 * submits `executive.enabled` must not clear the saved `subject_prefix` /
 * `to_addrs`.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { loadEffectiveSettings, publicSettings, saveSection } from '../../src/config/service';
import { validateSection } from '../../src/config/schema';
import { loadAppSettings } from '../../src/storage/settings';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

function executiveOf(value: Record<string, unknown>): Record<string, unknown> {
  return value.executive as Record<string, unknown>;
}

describe('validateSection(report).executive', () => {
  it('accepts the executive sub-section and coerces to_addrs', () => {
    const result = validateSection('report', {
      executive: { enabled: true, subject_prefix: '[Lead]', to_addrs: 'a@x.com; b@x.com' },
    });
    expect(result.errors).toEqual([]);
    expect(executiveOf(result.value).enabled).toBe(true);
    expect(executiveOf(result.value).subject_prefix).toBe('[Lead]');
    expect(executiveOf(result.value).to_addrs).toEqual(['a@x.com', 'b@x.com']);
  });

  it('defaults executive to disabled', () => {
    const result = validateSection('report', {});
    expect(result.errors).toEqual([]);
    expect(executiveOf(result.value).enabled).toBe(false);
    expect(executiveOf(result.value).subject_prefix).toBe('[Leader Summary]');
    expect(executiveOf(result.value).to_addrs).toEqual([]);
  });

  it('rejects a non-boolean executive.enabled', () => {
    const result = validateSection('report', { executive: { enabled: 'yes' } });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('leaves an absent executive sub-section untouched (older payloads)', () => {
    const result = validateSection('report', { daily_enabled: true });
    expect(result.errors).toEqual([]);
    expect(executiveOf(result.value).enabled).toBe(false);
    expect(executiveOf(result.value).subject_prefix).toBe('[Leader Summary]');
  });
});

describe('report.executive persistence + public payload', () => {
  it('exposes the executive defaults through publicSettings', () => {
    const { db } = freshDb();
    expect(publicSettings(db).report.executive).toEqual({
      enabled: false,
      subject_prefix: '[Leader Summary]',
      to_addrs: [],
    });
  });

  it('stores coerced executive values and exposes them through publicSettings', () => {
    const { db } = freshDb();
    saveSection(db, 'report', {
      executive: { enabled: true, subject_prefix: '[Lead]', to_addrs: 'a@x.com; b@x.com' },
    });

    const stored = loadAppSettings(db).report as Record<string, unknown>;
    expect(executiveOf(stored).to_addrs).toEqual(['a@x.com', 'b@x.com']);
    expect(publicSettings(db).report.executive).toEqual({
      enabled: true,
      subject_prefix: '[Lead]',
      to_addrs: ['a@x.com', 'b@x.com'],
    });
  });

  it('keeps saved subject_prefix / to_addrs when only executive.enabled is submitted', () => {
    const { db } = freshDb();
    saveSection(db, 'report', {
      executive: { subject_prefix: '[Lead]', to_addrs: ['a@x.com'] },
    });
    saveSection(db, 'report', { executive: { enabled: true } });

    const executive = executiveOf(loadEffectiveSettings(db).report as Record<string, unknown>);
    expect(executive.enabled).toBe(true);
    expect(executive.subject_prefix).toBe('[Lead]');
    expect(executive.to_addrs).toEqual(['a@x.com']);
  });
});