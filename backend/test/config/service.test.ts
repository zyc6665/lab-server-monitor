import { describe, it, expect, afterEach } from 'vitest';

import {
  loadEffectiveSettings,
  publicSettings,
  saveSection,
  deleteSection,
  SettingsServiceError,
  type PublicSettings,
} from '../../src/config/service';
import { DEFAULT_SETTINGS } from '../../src/config/defaults';
import { SETTINGS_SCHEMA } from '../../src/config/schema';
import { loadAppSettings, saveAppSettings } from '../../src/storage/settings';
import { setSecret } from '../../src/storage/secrets';
import { dpapiAvailable } from '../../src/storage/dpapi';
import { APP_VERSION } from '../../src/version';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

// Secret names are the ones the Python oracle uses in `app_secrets`.
const SMTP_PASSWORD_SECRET = 'smtp:password';
const WEBHOOK_URL_SECRET = 'webhook:url';
const ADMIN_SECRET = 'dashboard:admin_password';

function errorFrom(fn: () => void): SettingsServiceError {
  try {
    fn();
  } catch (err) {
    return err as SettingsServiceError;
  }
  throw new Error('expected the call to throw');
}

describe('loadEffectiveSettings', () => {
  it('returns the full default tree when the database is empty', () => {
    const { db } = freshDb();
    expect(loadEffectiveSettings(db)).toEqual(DEFAULT_SETTINGS);
  });

  it('deep-merges stored section values over the defaults', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'monitoring', { concurrency: 4 });
    saveAppSettings(db, 'alerts', { thresholds: { cpu_percent: 77 } });

    const settings = loadEffectiveSettings(db);

    expect(settings.monitoring.concurrency).toBe(4);
    // A field the stored payload did not touch keeps its default.
    expect(settings.monitoring.poll_interval_seconds).toBe(600);
    expect((settings.alerts.thresholds as Record<string, unknown>).cpu_percent).toBe(77);
    expect((settings.alerts.thresholds as Record<string, unknown>).memory_percent).toBe(90);
    expect(settings.alerts.cooldown_minutes).toBe(60);
  });

  it('ignores unknown sections and non-object payloads', () => {
    const { db } = freshDb();
    saveAppSettings(db, 'mystery', { x: 1 });
    saveAppSettings(db, 'ssh', [] as unknown as Record<string, unknown>);

    const settings = loadEffectiveSettings(db);

    expect(settings).not.toHaveProperty('mystery');
    expect(settings.ssh).toEqual(DEFAULT_SETTINGS.ssh);
  });
});

describe('saveSection', () => {
  it('persists the coerced section and reports restart_required for dashboard only', () => {
    const { db } = freshDb();

    expect(saveSection(db, 'monitoring', { poll_interval_seconds: '1200' })).toEqual({
      restartRequired: false,
    });
    expect(saveSection(db, 'dashboard', { port: '9090' })).toEqual({ restartRequired: true });

    const stored = loadAppSettings(db);
    expect(stored.monitoring.poll_interval_seconds).toBe(1200);
    expect(stored.dashboard.port).toBe(9090);
  });

  it('uses the section metadata (not a hard-coded list) for restartRequired', () => {
    const { db } = freshDb();
    for (const section of Object.keys(SETTINGS_SCHEMA)) {
      expect(saveSection(db, section, {}).restartRequired).toBe(
        SETTINGS_SCHEMA[section].restartRequired,
      );
    }
  });

  it('keeps previously saved fields when saving a partial section', () => {
    const { db } = freshDb();
    saveSection(db, 'monitoring', { concurrency: 4 });
    saveSection(db, 'monitoring', { poll_interval_seconds: 100 });

    const monitoring = loadEffectiveSettings(db).monitoring;
    expect(monitoring.concurrency).toBe(4);
    expect(monitoring.poll_interval_seconds).toBe(100);
  });

  it('never writes plaintext secrets into app_settings', () => {
    const { db } = freshDb();
    saveSection(db, 'smtp', { host: 'smtp.local', password: 'hunter2' });
    saveSection(db, 'alerts', {
      webhook: { enabled: true, type: 'wecom', url: 'https://example.test/hook' },
    });

    const stored = loadAppSettings(db);
    expect(stored.smtp).not.toHaveProperty('password');
    expect(stored.smtp.host).toBe('smtp.local');
    expect(stored.alerts.webhook as Record<string, unknown>).not.toHaveProperty('url');
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('https://example.test/hook');
  });

  it('throws a 404-coded error for an unknown section', () => {
    const { db } = freshDb();
    const err = errorFrom(() => saveSection(db, 'nope', { a: 1 }));
    expect(err).toBeInstanceOf(SettingsServiceError);
    expect(err.status).toBe(404);
    expect(err.code).toBe('unknown_section');
  });

  it('throws a 400-coded error carrying the validation messages', () => {
    const { db } = freshDb();
    const err = errorFrom(() => saveSection(db, 'monitoring', { host_metrics_max_points: 5 }));
    expect(err).toBeInstanceOf(SettingsServiceError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('validation_failed');
    expect(err.errors).toEqual(['host_metrics_max_points 必须在 10 到 10000 之间']);
  });

  it('rejects a non-object payload with a 400 invalid_payload error', () => {
    const { db } = freshDb();
    const err = errorFrom(() => saveSection(db, 'ssh', [] as unknown as Record<string, unknown>));
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_payload');
  });
});

describe('deleteSection', () => {
  it('removes a stored section so its defaults apply again', () => {
    const { db } = freshDb();
    saveSection(db, 'monitoring', { concurrency: 4 });
    expect(loadEffectiveSettings(db).monitoring.concurrency).toBe(4);

    deleteSection(db, 'monitoring');
    expect(loadEffectiveSettings(db).monitoring.concurrency).toBe(8);
  });

  it('is a no-op for a known section that was never saved', () => {
    const { db } = freshDb();
    expect(() => deleteSection(db, 'ssh')).not.toThrow();
  });

  it('throws a 404-coded error for an unknown section', () => {
    const { db } = freshDb();
    expect(errorFrom(() => deleteSection(db, 'nope')).status).toBe(404);
  });
});

describe('publicSettings', () => {
  it('returns the settings-api envelope with every section and the top-level metadata', () => {
    const { db } = freshDb();
    const pub = publicSettings(db);

    for (const key of [
      'writable',
      'version',
      'desktop_mode',
      'setup_required',
      'monitoring',
      'user_monitoring',
      'dashboard',
      'ssh',
      'smtp',
      'alerts',
      'report',
      'disk_health',
      'hosts',
    ]) {
      expect(pub).toHaveProperty(key);
    }
    expect(pub.version).toBe(APP_VERSION);
    expect(pub.writable).toBe(dpapiAvailable());
    // Hosts are owned by Task 4; this layer serves an empty placeholder list.
    expect(pub.hosts).toEqual([]);
  });

  it('redacts the SMTP password and reports whether one is configured', () => {
    const { db } = freshDb();
    expect(publicSettings(db).smtp).not.toHaveProperty('password');
    expect((publicSettings(db).smtp as Record<string, unknown>).password_configured).toBe(
      false,
    );

    setSecret(db, SMTP_PASSWORD_SECRET, Buffer.from('ciphertext'));
    expect((publicSettings(db).smtp as Record<string, unknown>).password_configured).toBe(
      true,
    );
  });

  it('redacts the webhook URL and exposes url_configured', () => {
    const { db } = freshDb();
    const webhook = (publicSettings(db).alerts as Record<string, unknown>).webhook as Record<
      string,
      unknown
    >;
    expect(webhook).not.toHaveProperty('url');
    expect(webhook).not.toHaveProperty('url_env');
    expect(webhook.url_configured).toBe(false);

    setSecret(db, WEBHOOK_URL_SECRET, Buffer.from('ciphertext'));
    const after = (publicSettings(db).alerts as Record<string, unknown>).webhook as Record<
      string,
      unknown
    >;
    expect(after.url_configured).toBe(true);
  });

  it('flattens the dashboard username and never exposes the auth object', () => {
    const { db } = freshDb();
    const pub: PublicSettings = publicSettings(db);

    expect(pub.dashboard).toEqual({
      host: '0.0.0.0',
      port: 8080,
      username: 'admin',
      session_lifetime_hours: 12,
    });
    expect(pub.dashboard).not.toHaveProperty('auth');
  });

  it('reports email delivery only when SMTP is configured and email alerts are enabled', () => {
    const { db } = freshDb();
    expect((publicSettings(db).alerts as Record<string, unknown>).email).toBe(false);

    saveSection(db, 'smtp', { host: 'smtp.local' });
    expect((publicSettings(db).alerts as Record<string, unknown>).email).toBe(true);

    saveSection(db, 'alerts', { email: false });
    expect((publicSettings(db).alerts as Record<string, unknown>).email).toBe(false);
  });

  it('reflects stored section edits in the read view', () => {
    const { db } = freshDb();
    saveSection(db, 'ssh', { connect_timeout: 30 });
    saveSection(db, 'alerts', { thresholds: { cpu_percent: 80 } });

    const pub = publicSettings(db);
    expect(pub.ssh.connect_timeout).toBe(30);
    expect((pub.alerts.thresholds as Record<string, unknown>).cpu_percent).toBe(80);
  });

  it('computes setup_required from DPAPI availability and the admin secret', () => {
    const { db } = freshDb();
    const writable = dpapiAvailable();
    // No admin secret yet: setup is required exactly when secrets are writable.
    expect(publicSettings(db).setup_required).toBe(writable);

    if (writable) {
      setSecret(db, ADMIN_SECRET, Buffer.from('blob'));
      expect(publicSettings(db).setup_required).toBe(false);
    }
  });
});
