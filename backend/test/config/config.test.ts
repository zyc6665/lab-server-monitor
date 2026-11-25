import { describe, it, expect } from 'vitest';
import * as path from 'node:path';

import {
  loadConfig,
  normalizeHost,
  normalizeServers,
  ConfigError,
} from '../../src/config/config';
import { APP_VERSION } from '../../src/version';

const DATA = path.join(path.sep + 'tmp', 'smdata');

function passwordAuth(envName: string) {
  return { type: 'password', password_env: envName };
}

const PW_ENV = { env: { SSH_PW: 'secret' } };

describe('loadConfig', () => {
  it('uses the oracle defaults when nothing is configured', () => {
    const cfg = loadConfig({ SERVERMONITOR_DATA_DIR: DATA });

    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.port).toBe(8080);
    expect(cfg.dataDir).toBe(DATA);
    expect(cfg.dbPath).toBe(path.join(DATA, 'servermonitor.db'));
    expect(cfg.logDir).toBe(path.join(DATA, 'logs'));
    expect(cfg.servers).toEqual([]);
    expect(cfg.tls).toBeUndefined();
    expect(cfg.appVersion).toBe(APP_VERSION);
  });

  it('applies environment overrides for host/port/log/tls/version', () => {
    const cfg = loadConfig({
      SERVERMONITOR_DATA_DIR: DATA,
      SERVERMONITOR_LOG_DIR: path.join(DATA, 'mylogs'),
      SERVERMONITOR_HOST: '127.0.0.1',
      SERVERMONITOR_PORT: '9001',
      SERVERMONITOR_APP_VERSION: '9.9.9',
      SERVERMONITOR_TLS_CERT: 'C:/certs/cert.pem',
      SERVERMONITOR_TLS_KEY: 'C:/certs/key.pem',
    });

    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.port).toBe(9001);
    expect(cfg.logDir).toBe(path.join(DATA, 'mylogs'));
    expect(cfg.appVersion).toBe('9.9.9');
    expect(cfg.tls).toEqual({ cert: 'C:/certs/cert.pem', key: 'C:/certs/key.pem' });
  });

  it('rejects a non-integer SERVERMONITOR_PORT', () => {
    expect(() =>
      loadConfig({ SERVERMONITOR_DATA_DIR: DATA, SERVERMONITOR_PORT: 'abc' }),
    ).toThrow(ConfigError);
  });

  it('normalises servers supplied in a parsed config object', () => {
    const cfg = loadConfig(
      { SERVERMONITOR_DATA_DIR: DATA, SSH_SECRET: 's3cr3t' },
      {
        servers: [
          {
            name: 'web-1',
            host: '10.0.0.5',
            username: 'root',
            auth: passwordAuth('SSH_SECRET'),
          },
        ],
      },
    );

    expect(cfg.servers).toHaveLength(1);
    expect(cfg.servers[0].name).toBe('web-1');
    expect(cfg.servers[0].auth.password).toBe('s3cr3t');
  });

  it('lets the parsed config dashboard section drive host/port like config.py', () => {
    const cfg = loadConfig(
      { SERVERMONITOR_DATA_DIR: DATA },
      { dashboard: { host: '192.168.1.9', port: 7000 }, servers: [] },
    );

    expect(cfg.host).toBe('192.168.1.9');
    expect(cfg.port).toBe(7000);
  });
});

describe('normalizeHost', () => {
  it('fills oracle defaults for a password-auth host', () => {
    const host = normalizeHost(
      {
        name: 'web-1',
        host: '10.0.0.5',
        username: 'root',
        auth: passwordAuth('SSH_PW'),
      },
      { env: { SSH_PW: 'hunter2' } },
    );

    expect(host.port).toBe(22);
    expect(host.auth.type).toBe('password');
    expect(host.auth.password_env).toBe('SSH_PW');
    expect(host.auth.password).toBe('hunter2');
    expect(host.tags).toEqual([]);
    expect(host.disk_mounts).toEqual(['/', '/data']);
    expect(host.group).toBe('未分组');
    expect(host.owner).toBe('');
    expect(host.location).toBe('');
    expect(host.notes).toBe('');
    expect(host.checks).toEqual([]);
    expect(host.alert_rules).toBeUndefined();
    expect(host.user_monitoring).toBeUndefined();
    expect(host.allow_user_write).toBe(false);
    expect(host.sudo_password).toBeUndefined();
  });

  it('keeps inline key_data and resolves passphrase_env', () => {
    const host = normalizeHost(
      {
        name: 'db-1',
        host: '10.0.0.6',
        username: 'dba',
        auth: { type: 'key', key_data: '-----BEGIN KEY-----', passphrase_env: 'KP' },
      },
      { env: { KP: 'phrase' } },
    );

    expect(host.auth.type).toBe('key');
    expect(host.auth.key_data).toBe('-----BEGIN KEY-----');
    expect(host.auth.passphrase_env).toBe('KP');
    expect(host.auth.passphrase).toBe('phrase');
  });

  it('accepts an inline passphrase (superset of config.py)', () => {
    const host = normalizeHost({
      name: 'db-2',
      host: '10.0.0.7',
      username: 'dba',
      auth: { type: 'key', key_data: 'k', passphrase: 'inline' },
    });

    expect(host.auth.passphrase).toBe('inline');
  });

  it('rejects key auth without key_path or key_data', () => {
    expect(() =>
      normalizeHost({
        name: 'db-3',
        host: '10.0.0.8',
        username: 'dba',
        auth: { type: 'key' },
      }),
    ).toThrow(/SSH key path does not exist/);
  });

  it('resolves sudo_password from its *_env name', () => {
    const host = normalizeHost(
      {
        name: 'web-1',
        host: '10.0.0.5',
        username: 'root',
        auth: passwordAuth('SSH_PW'),
        sudo_password_env: 'SUDO_PW',
      },
      { env: { SSH_PW: 'secret', SUDO_PW: 'sudo-secret' } },
    );

    expect(host.sudo_password).toBe('sudo-secret');
  });

  it('copies tags, group, location, notes and disk mounts', () => {
    const host = normalizeHost({
      name: 'web-1',
      host: '10.0.0.5',
      username: 'root',
      auth: passwordAuth('SSH_PW'),
      tags: ['prod', 'web'],
      group: '生产',
      location: '机房A',
      notes: 'primary',
      disk_mounts: ['/'],
    }, PW_ENV);

    expect(host.tags).toEqual(['prod', 'web']);
    expect(host.group).toBe('生产');
    expect(host.location).toBe('机房A');
    expect(host.notes).toBe('primary');
    expect(host.disk_mounts).toEqual(['/']);
  });

  it('parses checks with defaults, expected ranges and per-check timeout', () => {
    const host = normalizeHost({
      name: 'web-1',
      host: '10.0.0.5',
      username: 'root',
      auth: passwordAuth('SSH_PW'),
      checks: [
        { name: 'HTTP', type: 'http', target: 'http://localhost/health' },
        { name: 'DNS', type: 'dns', target: 'example.com', timeout_seconds: 10, expected: '200-299', enabled: false },
      ],
    }, PW_ENV);

    expect(host.checks).toHaveLength(2);
    expect(host.checks[0]).toEqual({
      name: 'HTTP',
      type: 'http',
      target: 'http://localhost/health',
      timeout_seconds: 5,
      expected: undefined,
      enabled: true,
    });
    expect(host.checks[1].timeout_seconds).toBe(10);
    expect(host.checks[1].expected).toBe('200-299');
    expect(host.checks[1].enabled).toBe(false);
  });

  it('rejects duplicate check names case-insensitively', () => {
    expect(() =>
      normalizeHost({
        name: 'web-1',
        host: '10.0.0.5',
        username: 'root',
        auth: passwordAuth('SSH_PW'),
        checks: [
          { name: 'HTTP', type: 'http', target: 'http://a' },
          { name: 'http', type: 'http', target: 'http://b' },
        ],
      }, PW_ENV),
    ).toThrow(/duplicates another check/);
  });

  it('rejects out-of-range check timeout and bad expected status', () => {
    const base = {
      name: 'web-1',
      host: '10.0.0.5',
      username: 'root',
      auth: passwordAuth('SSH_PW'),
    };

    expect(() =>
      normalizeHost({ ...base, checks: [{ name: 'A', type: 'http', target: 't', timeout_seconds: 0 }] }, PW_ENV),
    ).toThrow(/between 1 and 30/);
    expect(() =>
      normalizeHost({ ...base, checks: [{ name: 'A', type: 'http', target: 't', expected: 'abc' }] }, PW_ENV),
    ).toThrow(/status code or range/);
  });

  it('rejects more than 20 checks', () => {
    const checks = Array.from({ length: 21 }, (_, i) => ({ name: `c${i}`, type: 'http', target: 't' }));
    expect(() =>
      normalizeHost({
        name: 'web-1',
        host: '10.0.0.5',
        username: 'root',
        auth: passwordAuth('SSH_PW'),
        checks,
      }, PW_ENV),
    ).toThrow(/at most 20 entries/);
  });

  it('parses alert_rules overrides and enforces ranges', () => {
    const host = normalizeHost({
      name: 'web-1',
      host: '10.0.0.5',
      username: 'root',
      auth: passwordAuth('SSH_PW'),
      alert_rules: { cpu_percent: 85, consecutive_periods: 5 },
    }, PW_ENV);

    expect(host.alert_rules).toEqual({
      cpu_percent: 85,
      memory_percent: undefined,
      disk_percent: undefined,
      gpu_memory_percent: undefined,
      disk_temperature_c: undefined,
      consecutive_periods: 5,
    });

    expect(() =>
      normalizeHost({
        name: 'web-1',
        host: '10.0.0.5',
        username: 'root',
        auth: passwordAuth('SSH_PW'),
        alert_rules: { cpu_percent: 101 },
      }, PW_ENV),
    ).toThrow(/between 1 and 100/);
  });

  it('parses disk_health overrides and flags', () => {
    const host = normalizeHost({
      name: 'web-1',
      host: '10.0.0.5',
      username: 'root',
      auth: passwordAuth('SSH_PW'),
      disk_health: { enabled: false, storcli_path: '/usr/bin/storcli', use_sudo: true },
      user_monitoring: false,
      allow_user_write: true,
    }, PW_ENV);

    expect(host.disk_health).toEqual({ enabled: false, storcli_path: '/usr/bin/storcli', use_sudo: true });
    expect(host.user_monitoring).toBe(false);
    expect(host.allow_user_write).toBe(true);
  });

  it('rejects a non-mapping host entry', () => {
    expect(() => normalizeHost('nope')).toThrow(/must be a mapping/);
  });

  it('requires name/host/username', () => {
    expect(() => normalizeHost({ host: 'h', username: 'u', auth: passwordAuth('P') })).toThrow(
      /servers\[\]\.name is required/,
    );
    expect(() => normalizeHost({ name: 'n', username: 'u', auth: passwordAuth('P') })).toThrow(
      /servers\[\]\.host is required/,
    );
    expect(() => normalizeHost({ name: 'n', host: 'h', auth: passwordAuth('P') })).toThrow(
      /servers\[\]\.username is required/,
    );
  });

  it('rejects an unsupported auth type', () => {
    expect(() =>
      normalizeHost({ name: 'n', host: 'h', username: 'u', auth: { type: 'agent' } }),
    ).toThrow(/Unsupported auth type: agent/);
  });
});

describe('normalizeServers', () => {
  it('maps an array of raw hosts', () => {
    const servers = normalizeServers(
      [
        { name: 'a', host: '1.1.1.1', username: 'u', auth: passwordAuth('P') },
        { name: 'b', host: '2.2.2.2', username: 'u', auth: passwordAuth('P') },
      ],
      { env: { P: 'x' } },
    );

    expect(servers.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('rejects a non-array servers value', () => {
    expect(() => normalizeServers('nope')).toThrow(/servers must not be empty/);
  });
});
