import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfigError } from '../../src/config/errors';
import {
  buildServers,
  copyHost,
  deleteHost,
  getHost,
  hostGroups,
  importHosts,
  listHosts,
  parseSshConfig,
  previewHostImport,
  previewSshConfigImport,
  testHostsBatch,
  upsertHost,
  HostSettingsError,
  type HostRunner,
  type HostSecretStore,
  type HostsOptions,
} from '../../src/config/hosts';
import { loadAppSettings, saveAppSettings } from '../../src/storage/settings';
import { cleanupStorageTests, freshDb } from '../storage-helpers';

function memoryStore(): HostSecretStore {
  const map = new Map<string, string>();
  return {
    has: (name) => map.has(name),
    read: (name) => map.get(name) ?? null,
    write: (name, value) => {
      map.set(name, value);
    },
    delete: (name) => {
      map.delete(name);
    },
  };
}

function options(secrets: HostSecretStore = memoryStore()): HostsOptions {
  return { writable: true, secrets };
}

function passwordHost(secrets: HostSecretStore = memoryStore()) {
  return {
    opts: options(secrets),
    payload: {
      name: 'h1',
      host: '10.0.0.1',
      username: 'root',
      auth_type: 'password',
      password: 's3cret',
    },
  };
}

afterEach(() => cleanupStorageTests());

describe('listHosts / upsertHost basics', () => {
  it('returns an empty list on a fresh database', () => {
    const { db } = freshDb();
    expect(listHosts(db, options())).toEqual([]);
  });

  it('creates a host with Python-compatible defaults', () => {
    const { db } = freshDb();
    const { opts, payload } = passwordHost();
    const result = upsertHost(db, payload, opts);

    expect(result).toHaveLength(1);
    const host = result[0];
    expect(host.name).toBe('h1');
    expect(host.host).toBe('10.0.0.1');
    expect(host.port).toBe(22);
    expect(host.username).toBe('root');
    expect(host.auth_type).toBe('password');
    expect(host.key_path).toBeNull();
    expect(host.tags).toEqual([]);
    expect(host.disk_mounts).toEqual(['/', '/data']);
    expect(host.group).toBe('未分组');
    expect(host.owner).toBe('');
    expect(host.location).toBe('');
    expect(host.notes).toBe('');
    expect(host.user_monitoring).toBeNull();
    expect(host.allow_user_write).toBe(false);
    expect(host.checks).toEqual([]);
    expect(host.alert_rules).toBeNull();
    expect(host.disk_health).toBeNull();
    expect(host.password_configured).toBe(true);
    expect(host.key_configured).toBe(false);
    expect(host.passphrase_configured).toBe(false);
    expect(host.sudo_configured).toBe(false);
  });

  it('persists the inventory under the app_settings hosts section', () => {
    const { db } = freshDb();
    const { opts, payload } = passwordHost();
    upsertHost(db, payload, opts);
    const section = loadAppSettings(db)['hosts'] as { hosts: Record<string, unknown>[] };
    expect(Array.isArray(section.hosts)).toBe(true);
    expect(section.hosts[0].name).toBe('h1');
    // The write-only password value must never leak into app_settings.
    expect(JSON.stringify(section)).not.toContain('s3cret');
  });

  it('updates an existing host in place', () => {
    const { db } = freshDb();
    const { opts, payload } = passwordHost();
    upsertHost(db, payload, opts);
    const updated = upsertHost(db, { ...payload, host: '10.0.0.2', port: '2200' }, opts);
    expect(updated).toHaveLength(1);
    expect(updated[0].host).toBe('10.0.0.2');
    expect(updated[0].port).toBe(2200);
  });

  it('preserves checks / alert_rules / tri-state flags when omitted on update', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const opts = options(secrets);
    const base = {
      name: 'h1',
      host: '10.0.0.1',
      username: 'root',
      auth_type: 'key' as const,
      key_path: '/home/u/.ssh/id_rsa',
    };
    upsertHost(
      db,
      {
        ...base,
        user_monitoring: true,
        allow_user_write: true,
        checks: [{ name: 'tcp-80', type: 'tcp', target: '127.0.0.1:80' }],
        alert_rules: { cpu_percent: 80 },
      },
      opts,
    );
    const updated = upsertHost(db, base, opts);
    expect(updated[0].user_monitoring).toBe(true);
    expect(updated[0].allow_user_write).toBe(true);
    expect(updated[0].checks).toEqual([
      { name: 'tcp-80', type: 'tcp', target: '127.0.0.1:80', timeout_seconds: 5, expected: null, enabled: true },
    ]);
    expect(updated[0].alert_rules).toEqual({ cpu_percent: 80 });
  });

  it('sanitises nested checks and alert rules', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const opts = options(secrets);
    const host = upsertHost(
      db,
      {
        name: 'h1',
        host: '10.0.0.1',
        username: 'root',
        auth_type: 'key',
        key_path: '/k',
        checks: [{ name: 'web', type: 'HTTP', target: 'http://example.com/', timeout_seconds: 10, expected: '200-299' }],
        alert_rules: { disk_temperature_c: 70, consecutive_periods: 3 },
      },
      opts,
    )[0];
    expect(host.checks).toEqual([
      { name: 'web', type: 'http', target: 'http://example.com/', timeout_seconds: 10, expected: '200-299', enabled: true },
    ]);
    expect(host.alert_rules).toEqual({ disk_temperature_c: 70, consecutive_periods: 3 });
  });

  it('getHost returns the masked host or null', () => {
    const { db } = freshDb();
    const { opts, payload } = passwordHost();
    upsertHost(db, payload, opts);
    expect(getHost(db, 'h1', opts)?.name).toBe('h1');
    expect(getHost(db, 'nope', opts)).toBeNull();
  });
});

describe('upsertHost validation', () => {
  const base = { name: 'h1', host: '10.0.0.1', username: 'root', auth_type: 'key', key_path: '/k' };

  function throws(db: ReturnType<typeof freshDb>['db'], payload: unknown, opts: HostsOptions, message: string) {
    expect(() => upsertHost(db, payload, opts)).toThrowError(message);
  }

  it('rejects a non-object payload', () => {
    const { db } = freshDb();
    throws(db, 'nope', options(), 'host payload must be an object');
  });

  it('requires the host name', () => {
    const { db } = freshDb();
    throws(db, { ...base, name: '' }, options(), 'name 不能为空');
  });

  it('rejects a name that does not match the URL name', () => {
    const { db } = freshDb();
    throws(db, base, { ...options(), name: 'other' }, 'host name in payload does not match the URL name');
  });

  it('requires host / username / auth_type', () => {
    const { db } = freshDb();
    throws(db, { ...base, host: '' }, options(), 'host 不能为空');
    throws(db, { ...base, username: '' }, options(), 'username 不能为空');
    throws(db, { ...base, auth_type: '' }, options(), 'auth_type 不能为空');
  });

  it('rejects unsupported auth types', () => {
    const { db } = freshDb();
    throws(db, { ...base, auth_type: 'agent' }, options(), 'unsupported auth_type: agent');
  });

  it('validates the port', () => {
    const { db } = freshDb();
    throws(db, { ...base, port: 'abc' }, options(), 'port 必须是整数');
    throws(db, { ...base, port: 70000 }, options(), 'port 超出范围');
  });

  it('validates checks', () => {
    const { db } = freshDb();
    throws(db, { ...base, checks: 'nope' }, options(), 'checks 必须是列表');
    throws(db, { ...base, checks: [{ name: 'x', type: 'bogus', target: 'y' }] }, options(), 'checks[0].type 必须是 tcp/http/process/service 之一');
    throws(
      db,
      { ...base, checks: [{ name: 'x', type: 'tcp', target: 'bad host:80' }] },
      options(),
      'checks[0].target 非法: TCP 目标包含空白或控制字符',
    );
  });

  it('validates alert rules', () => {
    const { db } = freshDb();
    throws(db, { ...base, alert_rules: 'nope' }, options(), 'alert_rules 必须是对象');
    throws(db, { ...base, alert_rules: { cpu_percent: 200 } }, options(), 'alert_rules.cpu_percent 必须在 1 到 100 之间');
    throws(
      db,
      { ...base, alert_rules: { consecutive_periods: 11 } },
      options(),
      'alert_rules.consecutive_periods 必须在 1 到 10 之间',
    );
  });

  it('validates tri-state user_monitoring and boolean allow_user_write', () => {
    const { db } = freshDb();
    throws(db, { ...base, user_monitoring: 'bogus' }, options(), 'user_monitoring 必须是 true/false 或留空: ' + "'bogus'");
    throws(db, { ...base, allow_user_write: 1 }, options(), 'allow_user_write必须是 true 或 false');
  });

  it('requires credentials for the chosen auth type', () => {
    const { db } = freshDb();
    throws(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'password' }, options(), 'SSH 密码未设置');
    throws(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key' }, options(), 'SSH 私钥未设置');
  });

  it('refuses writes when settings are not writable', () => {
    const { db } = freshDb();
    expect(() => upsertHost(db, base, { ...options(), writable: false })).toThrowError('settings are not writable on this platform');
  });
});

describe('secret handling', () => {
  it('stores the password in the secret store only and supports clearing it', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const { opts, payload } = passwordHost(secrets);
    upsertHost(db, payload, opts);
    expect(secrets.has('host:h1:ssh_password')).toBe(true);
    expect(secrets.read('host:h1:ssh_password')).toBe('s3cret');
    // Clearing without a replacement credential fails.
    expect(() => upsertHost(db, { ...payload, password: undefined, clear_secrets: ['password'] }, opts)).toThrowError(
      'SSH 密码未设置',
    );
  });

  it('stores key material and passphrase as secrets', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const opts = options(secrets);
    upsertHost(
      db,
      { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', private_key: 'PRIVATE', passphrase: 'pp' },
      opts,
    );
    expect(secrets.read('host:h1:ssh_key')).toBe('PRIVATE');
    expect(secrets.read('host:h1:ssh_passphrase')).toBe('pp');
    expect(secrets.has('host:h1:ssh_password')).toBe(false);
  });

  it('stores a validated sudo password', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const opts = options(secrets);
    upsertHost(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k', sudo_password: 'sudo-pw' }, opts);
    expect(secrets.read('host:h1:sudo_password')).toBe('sudo-pw');
    expect(() =>
      upsertHost(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k', sudo_password: 'a\nb' }, opts),
    ).toThrowError('sudo 密码不能包含换行符');
  });
});

describe('deleteHost / copyHost / hostGroups', () => {
  it('deletes a host and its secrets', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const { opts, payload } = passwordHost(secrets);
    upsertHost(db, payload, opts);
    upsertHost(db, { name: 'h2', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k' }, opts);
    const rest = deleteHost(db, 'h1', opts);
    expect(rest.map((h) => h.name)).toEqual(['h2']);
    expect(secrets.has('host:h1:ssh_password')).toBe(false);
  });

  it('copies a host and its secrets', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const { opts, payload } = passwordHost(secrets);
    upsertHost(db, payload, opts);
    const hosts = copyHost(db, 'h1', 'h1-copy', opts);
    expect(hosts.map((h) => h.name)).toEqual(['h1', 'h1-copy']);
    expect(secrets.read('host:h1-copy:ssh_password')).toBe('s3cret');
    expect(() => copyHost(db, 'h1', 'h1', opts)).toThrowError('目标主机已存在: h1');
    expect(() => copyHost(db, 'missing', 'x', opts)).toThrowError('源主机不存在: missing');
  });

  it('lists groups with the default bucket', () => {
    const { db } = freshDb();
    const opts = options();
    expect(hostGroups(db, opts)).toEqual(['未分组']);
    upsertHost(db, { name: 'a', host: '1.1.1.1', username: 'u', auth_type: 'key', key_path: '/k', group: '生产' }, opts);
    upsertHost(db, { name: 'b', host: '2.2.2.2', username: 'u', auth_type: 'key', key_path: '/k', group: '  ' }, opts);
    expect(hostGroups(db, opts)).toEqual(['未分组', '生产'].sort());
  });
});

describe('importHosts', () => {
  const candidate = { name: 'a', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k' };

  it('creates candidates', () => {
    const { db } = freshDb();
    const result = importHosts(db, [candidate], options());
    expect(result.created).toEqual(['a']);
    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(listHosts(db, options()).map((h) => h.name)).toEqual(['a']);
  });

  it('skips existing names unless overwrite is set', () => {
    const { db } = freshDb();
    const opts = options();
    importHosts(db, [candidate], opts);
    expect(importHosts(db, [candidate], opts).skipped).toEqual(['a']);
    const overwritten = importHosts(db, [candidate], { ...opts, overwrite: true });
    expect(overwritten.updated).toEqual(['a']);
  });

  it('skips duplicates inside the candidate list', () => {
    const { db } = freshDb();
    const result = importHosts(db, [candidate, { ...candidate }], options());
    expect(result.created).toEqual(['a']);
    expect(result.skipped).toEqual(['a']);
  });

  it('reports invalid candidates without aborting the batch', () => {
    const { db } = freshDb();
    const result = importHosts(
      db,
      ['nope', { name: 'b', host: '1.2.3.4' }, { name: 'c', host: '1.2.3.4', username: 'u', valid: false, error: '坏' }, candidate],
      options(),
    );
    expect(result.created).toEqual(['a']);
    expect(result.failed[0]).toEqual({ name: '', error: '主机条目必须是对象' });
    expect(result.failed).toContainEqual({ name: 'b', error: 'username 不能为空' });
    expect(result.failed).toContainEqual({ name: 'c', error: '坏' });
  });

  it('requires credentials unless allowMissingCredentials is set', () => {
    const { db } = freshDb();
    const noKey = { name: 'a', host: '1.2.3.4', username: 'root', auth_type: 'key' };
    expect(importHosts(db, [noKey], options()).failed).toEqual([{ name: 'a', error: 'SSH 私钥未设置' }]);
    const ok = importHosts(db, [noKey], { ...options(), allowMissingCredentials: true });
    expect(ok.created).toEqual(['a']);
  });

  it('rejects a non-list candidate payload', () => {
    const { db } = freshDb();
    expect(() => importHosts(db, candidate as unknown as unknown[], options())).toThrowError('candidates 必须是列表');
  });
});

describe('previewHostImport', () => {
  it('parses CSV content', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, { format: 'csv', content: 'name,host,port,username\nweb,10.0.0.5,2222,root\n' });
    expect(preview.candidates).toHaveLength(1);
    const c = preview.candidates[0];
    expect(c).toMatchObject({ name: 'web', host: '10.0.0.5', port: 2222, username: 'root', auth_type: 'key', group: '未分组' });
    expect(c.disk_mounts).toEqual(['/', '/data']);
  });

  it('parses CSV with Chinese headers', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, 'csv', '名称,地址,端口\n库,10.0.0.6,22\n');
    expect(preview.candidates[0]).toMatchObject({ name: '库', host: '10.0.0.6', port: 22 });
  });

  it('reports missing required CSV columns', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, { format: 'csv', content: 'host,port\n10.0.0.1,22\n' });
    expect(preview.candidates).toEqual([]);
    expect(preview.errors).toEqual([{ row: 1, error: '缺少必需列: name, host' }]);
  });

  it('parses YAML as a root list', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, { format: 'yaml', content: '- name: a\n  host: 10.0.0.1\n  port: 22\n- name: b\n  host: 10.0.0.2\n' });
    expect(preview.candidates.map((c) => c.name)).toEqual(['a', 'b']);
    expect(preview.candidates[0].host).toBe('10.0.0.1');
  });

  it('parses YAML with a hosts mapping', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, {
      format: 'yml',
      content: 'hosts:\n  - name: a\n    host: 10.0.0.1\n    tags: [prod, db]\n',
    });
    expect(preview.candidates[0].name).toBe('a');
    expect(preview.candidates[0].tags).toEqual(['prod', 'db']);
  });

  it('parses ssh config content', () => {
    const { db } = freshDb();
    const preview = previewHostImport(db, { format: 'ssh', content: 'Host web\n  HostName 10.0.0.1\n  User root\n' });
    expect(preview.candidates[0]).toMatchObject({ name: 'web', host: '10.0.0.1', username: 'root' });
  });

  it('rejects unsupported formats and non-string content', () => {
    const { db } = freshDb();
    expect(() => previewHostImport(db, { format: 'xml', content: '' })).toThrowError(/unsupported_format/);
    expect(() => previewHostImport(db, { format: 'csv', content: 42 })).toThrowError(/invalid_payload/);
  });
});

describe('parseSshConfig', () => {
  const text = [
    'Host web1',
    '  HostName 10.0.0.1',
    '  User root',
    '  Port 2200',
    '  IdentityFile ~/.ssh/id_web',
    '',
    'Host *',
    '  User fallback',
    '',
    'Host behind',
    '  ProxyJump jumpbox',
    '',
    'Match all',
    '  User x',
    '',
    'Include other',
    '',
  ].join('\n');

  it('parses aliases, skips wildcards and warns about Match/Include', () => {
    const result = parseSshConfig(text, { home: '/home/tester', fileExists: () => false });
    expect(result.candidates.map((c) => c.name)).toEqual(['web1', 'behind']);

    const web = result.candidates[0];
    expect(web.host).toBe('10.0.0.1');
    expect(web.port).toBe(2200);
    expect(web.username).toBe('root');
    expect(web.key_path).toBe(path.join('/home/tester', '.ssh', 'id_web'));
    expect(web.valid).toBe(true);

    const behind = result.candidates[1];
    expect(behind.valid).toBe(false);
    expect(behind.error).toBe('需要代理跳转，工具暂不支持');

    expect(result.warnings).toContain('跳过通配符 Host: *');
    expect(result.warnings).toContain('跳过 Match 配置块: all');
    expect(result.warnings).toContain('跳过 Include 指令: other');
  });

  it('warns about an invalid port and defaults to 22', () => {
    const result = parseSshConfig('Host x\n  HostName h\n  Port abc\n', { home: '/home/tester' });
    expect(result.candidates[0].port).toBe(22);
    expect(result.candidates[0].port_explicit).toBe(true);
    expect(result.warnings).toContain('无效端口 abc，使用默认 22');
  });

  it('falls back to the alias when no HostName is present', () => {
    const result = parseSshConfig('Host myalias\n  User root\n', { home: '/home/tester' });
    expect(result.candidates[0].host).toBe('myalias');
  });
});

describe('previewSshConfigImport', () => {
  it('returns an empty result when the config file is missing', () => {
    const preview = previewSshConfigImport({
      home: '/home/tester',
      configPath: '/home/tester/.ssh/config',
      defaultUsername: 'tester',
      fileExists: () => false,
    });
    expect(preview.exists).toBe(false);
    expect(preview.path).toBe('/home/tester/.ssh/config');
    expect(preview.default_username).toBe('tester');
    expect(preview.candidates).toEqual([]);
  });

  it('reads, parses and applies defaults', () => {
    const content = 'Host web\n  HostName 10.0.0.1\n';
    const preview = previewSshConfigImport({
      home: '/home/tester',
      configPath: '/home/tester/.ssh/config',
      defaultUsername: 'tester',
      fileExists: (p) => p === '/home/tester/.ssh/config' || p === path.join('/home/tester', '.ssh', 'config'),
      readFile: () => content,
    });
    expect(preview.exists).toBe(true);
    const c = preview.candidates[0];
    expect(c.name).toBe('web');
    expect(c.host).toBe('10.0.0.1');
    expect(c.username).toBe('tester');
    expect(c.warnings).toContain('未指定 IdentityFile，导入后需补私钥或密码');
  });

  it('reads bytes and honours home when FileExists is not supplied', () => {
    const preview = previewSshConfigImport({
      home: '/home/tester',
      configPath: '/home/tester/.ssh/config',
      defaultUsername: 'tester',
      readFile: () => Buffer.from('Host web\n  HostName 10.0.0.1\n', 'utf8'),
      fileExists: () => true,
    });
    expect(preview.candidates[0].name).toBe('web');
  });
});

describe('testHostsBatch', () => {
  it('runs the injected runner per host and maps exit status', async () => {
    const { db } = freshDb();
    const opts = options();
    upsertHost(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k' }, opts);

    const runner: HostRunner = vi.fn(async (server) => {
      if (server.host === '1.2.3.4') return { exitStatus: 0, stdout: 'ok\n' };
      return { exitStatus: 1, stderr: 'boom' };
    });
    const { results } = await testHostsBatch(db, ['h1', 'missing'], runner, opts);
    expect(results).toEqual([
      { name: 'h1', ok: true, detail: 'ok' },
      { name: 'missing', ok: false, detail: '主机不存在' },
    ]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('captures runner failures and thrown errors', async () => {
    const { db } = freshDb();
    const opts = options();
    upsertHost(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k' }, opts);
    const failing: HostRunner = () => {
      throw new Error('network down');
    };
    const { results } = await testHostsBatch(db, ['h1'], failing, opts);
    expect(results).toEqual([{ name: 'h1', ok: false, detail: 'network down' }]);
  });

  it('rejects a non-string name list', async () => {
    const { db } = freshDb();
    await expect(testHostsBatch(db, [1 as unknown as string], () => ({ exitStatus: 0 }), options())).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('buildServers', () => {
  it('builds HostConfig entries with defaults', () => {
    const { db } = freshDb();
    const opts = options();
    upsertHost(db, { name: 'h1', host: '1.2.3.4', username: 'root', auth_type: 'key', key_path: '/k', group: 'prod' }, opts);
    const servers = buildServers(db, opts);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'h1',
      host: '1.2.3.4',
      port: 22,
      username: 'root',
      auth: { type: 'key', key_path: '/k' },
      disk_mounts: ['/', '/data'],
      group: 'prod',
      checks: [],
      allow_user_write: false,
    });
  });

  it('reads the password secret into the auth config', () => {
    const { db } = freshDb();
    const secrets = memoryStore();
    const { opts, payload } = passwordHost(secrets);
    upsertHost(db, payload, opts);
    const servers = buildServers(db, opts);
    expect(servers[0].auth).toEqual({ type: 'password', password: 's3cret' });
  });

  it('throws for an invalid stored entry', () => {
    const { db } = freshDb();
    // Directly seed an invalid entry into the section.
    saveAppSettings(db, 'hosts', { hosts: [{ name: '', host: '', username: '', auth_type: 'key' }] });
    expect(() => buildServers(db, options())).toThrowError(
      'host entry is invalid: <unnamed> (host/auth_type/username missing or unsupported)',
    );
  });
});

describe('HostSettingsError', () => {
  it('is a ConfigError with a code', () => {
    const err = new HostSettingsError('boom', { code: 'invalid_payload', status: 400 });
    expect(err).toBeInstanceOf(ConfigError);
    expect(err.code).toBe('invalid_payload');
    expect(err.status).toBe(400);
  });
});
