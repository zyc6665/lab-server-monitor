import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from '../../src/config/errors';
import {
  assertReportSmtpReady,
  databaseSecretWriter,
  isSmtpReady,
  mergeSections,
  sanitizeSection,
  SectionsError,
  type SecretWriter,
} from '../../src/config/sections';
import {
  SECRET_SMTP_PASSWORD,
  SECRET_WEBHOOK_URL,
  publicSettings,
  saveSection,
  SettingsServiceError,
} from '../../src/config/service';
import { getSecret } from '../../src/storage/secrets';
import { loadAppSettings } from '../../src/storage/settings';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

/** In-memory {@link SecretWriter} (values stored in clear, as the oracle does). */
function memoryStore(): SecretWriter & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    has: (name) => map.has(name),
    write: (name, value) => {
      map.set(name, value);
    },
  };
}

/** Reversible stand-in for DPAPI so tests never need the real platform API. */
const protectStub = (plain: Buffer): Buffer => Buffer.concat([Buffer.from('enc:'), plain]);
const unprotectStub = (blob: Buffer): Buffer => blob.subarray(4);

function errorFrom(fn: () => unknown): SettingsServiceError {
  try {
    fn();
  } catch (err) {
    return err as SettingsServiceError;
  }
  throw new Error('expected a throw');
}

describe('mergeSections', () => {
  it('deep-merges nested objects and replaces arrays/scalars', () => {
    const base = {
      host: 'a',
      nested: { a: 1, b: 2 },
      list: [1, 2, 3],
    };
    const override = {
      nested: { b: 20, c: 30 },
      list: [9],
      extra: true,
    };
    expect(mergeSections(base, override)).toEqual({
      host: 'a',
      nested: { a: 1, b: 20, c: 30 },
      list: [9],
      extra: true,
    });
  });

  it('does not mutate the inputs', () => {
    const base = { nested: { a: 1 } };
    const override = { nested: { b: 2 } };
    mergeSections(base, override);
    expect(base).toEqual({ nested: { a: 1 } });
    expect(override).toEqual({ nested: { b: 2 } });
  });
});

describe('databaseSecretWriter', () => {
  it('encrypts through the injected protect and stores a ciphertext blob', () => {
    const { db } = freshDb();
    const writer = databaseSecretWriter(db, { protect: protectStub });
    expect(writer.has(SECRET_SMTP_PASSWORD)).toBe(false);

    writer.write(SECRET_SMTP_PASSWORD, 'hunter2');

    expect(writer.has(SECRET_SMTP_PASSWORD)).toBe(true);
    const blob = getSecret(db, SECRET_SMTP_PASSWORD);
    expect(blob).not.toBeNull();
    expect(blob!.toString('utf8')).toBe('enc:hunter2');
    // The stored value is ciphertext, never the plaintext.
    expect(blob!.toString('utf8')).not.toBe('hunter2');
  });
});

describe('sanitizeSection — smtp', () => {
  it('keeps schema fields, stores the password and strips it from the payload', () => {
    const store = memoryStore();
    const out = sanitizeSection(
      'smtp',
      {
        host: 'smtp.local',
        port: 587,
        username: 'bot',
        password: 'hunter2',
        use_ssl: false,
        from_addr: 'a@example.test',
        to_addrs: 'a@example.test, b@example.test;c@example.test',
        // Unknown key must not survive.
        injected: 'x',
      },
      { secrets: store, writable: true },
    );

    expect(store.map.get(SECRET_SMTP_PASSWORD)).toBe('hunter2');
    expect(out).not.toHaveProperty('password');
    expect(out).not.toHaveProperty('injected');
    expect(out).not.toHaveProperty('password_configured');
    expect(out.to_addrs).toEqual(['a@example.test', 'b@example.test', 'c@example.test']);
    expect(out.host).toBe('smtp.local');
  });

  it('normalizes an array of recipients and drops empties', () => {
    const store = memoryStore();
    const out = sanitizeSection(
      'smtp',
      { host: 'h', to_addrs: ['  a@x ', '', 'b@x'] },
      { secrets: store, writable: true },
    );
    expect(out.to_addrs).toEqual(['a@x', 'b@x']);
    expect(store.map.size).toBe(0);
  });

  it('throws when a secret must be stored but settings are not writable', () => {
    const store = memoryStore();
    expect(() =>
      sanitizeSection('smtp', { host: 'h', password: 'x' }, { secrets: store, writable: false }),
    ).toThrow('settings are not writable on this platform');
  });
});

describe('sanitizeSection — alerts', () => {
  it('moves a webhook url into secrets and drops url/url_env', () => {
    const store = memoryStore();
    const out = sanitizeSection(
      'alerts',
      {
        enabled: true,
        consecutive_periods: 3,
        webhook: { enabled: true, type: 'wecom', url: 'https://hook.test/x', url_env: 'HOOK' },
      },
      { secrets: store, writable: true },
    );

    expect(store.map.get(SECRET_WEBHOOK_URL)).toBe('https://hook.test/x');
    const webhook = out.webhook as Record<string, unknown>;
    expect(webhook).not.toHaveProperty('url');
    expect(webhook).not.toHaveProperty('url_env');
    expect(webhook).not.toHaveProperty('url_configured');
    expect(out.consecutive_periods).toBe(3);
  });

  it('validates consecutive_periods with the oracle messages', () => {
    const store = memoryStore();
    expect(() =>
      sanitizeSection('alerts', { consecutive_periods: true }, { secrets: store, writable: true }),
    ).toThrow('alerts.consecutive_periods 必须是整数');
    expect(() =>
      sanitizeSection('alerts', { consecutive_periods: 11 }, { secrets: store, writable: true }),
    ).toThrow('alerts.consecutive_periods 必须在 1 到 10 之间');
  });

  it('does not write a webhook secret when no url is supplied', () => {
    const store = memoryStore();
    sanitizeSection(
      'alerts',
      { webhook: { enabled: false, type: 'wecom', url_env: 'HOOK' } },
      { secrets: store, writable: true },
    );
    expect(store.map.size).toBe(0);
  });
});

describe('sanitizeSection — dashboard', () => {
  it('drops nested auth credentials but keeps the safe fields', () => {
    const out = sanitizeSection(
      'dashboard',
      {
        host: '0.0.0.0',
        port: 8080,
        session_lifetime_hours: 12,
        auth: {
          enabled: true,
          username: 'admin',
          password_env: 'DASHBOARD_PASSWORD',
          password: 'hunter2',
          password_hash: 'deadbeef',
          password_salt: 'salty',
        },
        rogue: true,
      },
      { writable: true },
    );
    expect(out).toEqual({
      host: '0.0.0.0',
      port: 8080,
      session_lifetime_hours: 12,
      auth: { enabled: true, username: 'admin', password_env: 'DASHBOARD_PASSWORD' },
    });
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('deadbeef');
    expect(out).not.toHaveProperty('rogue');
  });
});

describe('sanitizeSection — passthrough', () => {
  it('returns a deep clone for sections without secrets', () => {
    const payload = { interval: 10, nested: { a: [1, 2] } };
    const out = sanitizeSection('monitoring', payload, { writable: true });
    expect(out).toEqual(payload);
    expect(out).not.toBe(payload);
  });
});

describe('report SMTP gate', () => {
  it('isSmtpReady requires a host and, when a username exists, a stored password', () => {
    const store = memoryStore();
    expect(isSmtpReady({ host: '', username: 'u' }, store)).toBe(false);
    expect(isSmtpReady({ host: 'h', username: '' }, store)).toBe(true);
    expect(isSmtpReady({ host: 'h', username: 'u' }, store)).toBe(false);
    store.write(SECRET_SMTP_PASSWORD, 'pw');
    expect(isSmtpReady({ host: 'h', username: 'u' }, store)).toBe(true);
  });

  it('assertReportSmtpReady only blocks a newly-enabled report without SMTP', () => {
    expect(() =>
      assertReportSmtpReady({ daily_enabled: false }, { daily_enabled: true }, false),
    ).toThrow('启用日报/周报前需要先配置 SMTP 邮件服务器');
    expect(() =>
      assertReportSmtpReady({ daily_enabled: true }, { daily_enabled: true }, false),
    ).not.toThrow();
    expect(() =>
      assertReportSmtpReady({ daily_enabled: false }, { daily_enabled: true }, true),
    ).not.toThrow();
  });
});

describe('saveSection — secret persistence (end to end)', () => {
  it('persists the SMTP password into app_secrets and never into app_settings', () => {
    const { db } = freshDb();
    saveSection(
      db,
      'smtp',
      { host: 'smtp.local', username: 'bot', password: 'hunter2' },
      { protect: protectStub, writable: true },
    );

    const stored = loadAppSettings(db);
    expect(stored.smtp).not.toHaveProperty('password');
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(getSecret(db, SECRET_SMTP_PASSWORD)?.toString('utf8')).toBe('enc:hunter2');
    expect((publicSettings(db).smtp as Record<string, unknown>).password_configured).toBe(true);
  });

  it('persists the webhook url into app_secrets', () => {
    const { db } = freshDb();
    saveSection(
      db,
      'alerts',
      { webhook: { enabled: true, url: 'https://hook.test/x' } },
      { protect: protectStub, writable: true },
    );

    expect(getSecret(db, SECRET_WEBHOOK_URL)?.toString('utf8')).toBe('enc:https://hook.test/x');
    const stored = loadAppSettings(db);
    expect((stored.alerts.webhook as Record<string, unknown>)).not.toHaveProperty('url');
    expect(JSON.stringify(stored)).not.toContain('https://hook.test/x');
  });

  it('never stores a dashboard admin password supplied through save_section', () => {
    const { db } = freshDb();
    saveSection(
      db,
      'dashboard',
      { auth: { username: 'root', password: 'hunter2' } },
      { protect: protectStub, writable: true },
    );
    const stored = loadAppSettings(db);
    expect((stored.dashboard.auth as Record<string, unknown>)).not.toHaveProperty('password');
    expect(JSON.stringify(stored)).not.toContain('hunter2');
  });

  it('blocks enabling the daily report until SMTP is ready', () => {
    const { db } = freshDb();
    saveSection(db, 'smtp', { host: 'smtp.local', username: 'bot' }, { protect: protectStub, writable: true });
    saveSection(db, 'report', { daily_enabled: false }, { protect: protectStub, writable: true });

    const err = errorFrom(() =>
      saveSection(db, 'report', { daily_enabled: true }, { protect: protectStub, writable: true }),
    );
    expect(err).toBeInstanceOf(SettingsServiceError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('SMTP');

    saveSection(
      db,
      'smtp',
      { host: 'smtp.local', username: 'bot', password: 'pw' },
      { protect: protectStub, writable: true },
    );
    expect(() =>
      saveSection(db, 'report', { daily_enabled: true }, { protect: protectStub, writable: true }),
    ).not.toThrow();
  });

  it('surfaces a SectionsError as a 400 SettingsServiceError', () => {
    const { db } = freshDb();
    const err = errorFrom(() =>
      saveSection(db, 'smtp', { host: 'h', password: 'x' }, { writable: false, secrets: memoryStore() }),
    );
    expect(err).toBeInstanceOf(SettingsServiceError);
    expect(err.status).toBe(400);
    expect(err).toBeInstanceOf(ConfigError);
  });
});
