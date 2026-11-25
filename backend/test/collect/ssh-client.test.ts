import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  HostKeyMismatch,
  KnownHostsStore,
  SshClient,
  SudoAuthError,
  SudoUnavailable,
  computeHostKeyFingerprint,
} from '../../src/collect/ssh-client';
import type { Ssh2ChannelLike, Ssh2ClientLike, SshConnectConfig } from '../../src/collect/ssh-client';

// ---------------------------------------------------------------------------
// Fake ssh2 surface. Nothing here touches the network.
// ---------------------------------------------------------------------------

class FakeChannel extends EventEmitter implements Ssh2ChannelLike {
  written: string[] = [];
  stderr = new EventEmitter();
  destroyed = false;
  closed = false;
  windowSize: { rows: number; cols: number } | null = null;

  write(data: string | Buffer): boolean {
    this.written.push(String(data));
    return true;
  }

  end(): this {
    return this;
  }

  close(): this {
    this.closed = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  setWindow(rows: number, cols: number): this {
    this.windowSize = { rows, cols };
    return this;
  }
}

interface FakeBehavior {
  connect?: (client: FakeClient, config: Record<string, unknown>) => void;
  exec?: (command: string) => FakeChannel;
  shell?: (window: Record<string, unknown>) => FakeChannel;
}

class FakeClient extends EventEmitter implements Ssh2ClientLike {
  connectCalls = 0;
  lastConfig: Record<string, unknown> | null = null;
  execCalls: Array<{ command: string; channel: FakeChannel }> = [];
  shellCalls: Array<{ window: Record<string, unknown>; channel: FakeChannel }> = [];
  ended = false;
  destroyed = false;

  constructor(private readonly behavior: FakeBehavior = {}) {
    super();
  }

  connect(config: Record<string, unknown>): this {
    this.connectCalls += 1;
    this.lastConfig = config;
    if (this.behavior.connect) {
      this.behavior.connect(this, config);
    } else {
      queueMicrotask(() => this.emit('ready'));
    }
    return this;
  }

  exec(command: string, callback: (err: Error | undefined, channel: FakeChannel) => void): this {
    const channel = this.behavior.exec ? this.behavior.exec(command) : new FakeChannel();
    this.execCalls.push({ command, channel });
    queueMicrotask(() => callback(undefined, channel));
    return this;
  }

  shell(window: Record<string, unknown>, callback: (err: Error | undefined, channel: FakeChannel) => void): this {
    const channel = this.behavior.shell ? this.behavior.shell(window) : new FakeChannel();
    this.shellCalls.push({ window, channel });
    queueMicrotask(() => callback(undefined, channel));
    return this;
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

const tempDirs: string[] = [];

function tempKnownHostsPath(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssh-client-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'known_hosts.json');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(overrides: Partial<SshConnectConfig> = {}): SshConnectConfig {
  return {
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    connectTimeoutSec: 2,
    hostKeyPolicy: 'insecure',
    ...overrides,
  };
}

function hostKeyBlob(algo: string, payload: Buffer): Buffer {
  const name = Buffer.from(algo, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length, 0);
  return Buffer.concat([length, name, payload]);
}

function ssha256(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

// A fake connect that feeds the ssh2 hostVerifier (as ssh2 itself would) and
// either emits `ready` or `error`.
function verifierConnect(rawKey: Buffer) {
  return (client: FakeClient, config: Record<string, unknown>): void => {
    const verifier = config.hostVerifier as ((key: Buffer) => boolean) | undefined;
    if (!verifier) {
      queueMicrotask(() => client.emit('ready'));
      return;
    }
    let ok: boolean;
    try {
      ok = verifier(rawKey);
    } catch (err) {
      throw err;
    }
    if (ok === false) {
      queueMicrotask(() => client.emit('error', new Error('Host denied (verification failed)')));
    } else {
      queueMicrotask(() => client.emit('ready'));
    }
  };
}

// ---------------------------------------------------------------------------
// connect(): transient retry / auth non-retry
// ---------------------------------------------------------------------------

describe('SshClient.connect', () => {
  it('retries exactly once after a transient ETIMEDOUT, then succeeds', async () => {
    const transient = new FakeClient({
      connect: () => {
        const err = Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' });
        throw err;
      },
    });
    const healthy = new FakeClient();
    let created = 0;
    const client = new SshClient(makeConfig(), {
      clientFactory: (): Ssh2ClientLike => {
        created += 1;
        return created === 1 ? transient : healthy;
      },
      retryBackoffMs: 0,
    });

    await client.connect();

    expect(created).toBe(2);
    expect(transient.connectCalls).toBe(1);
    expect(healthy.connectCalls).toBe(1);
  });

  it('does not retry authentication failures', async () => {
    const auth = new FakeClient({
      connect: () => {
        throw new Error('All configured authentication methods failed');
      },
    });
    let created = 0;
    const client = new SshClient(makeConfig(), {
      clientFactory: (): Ssh2ClientLike => {
        created += 1;
        return auth;
      },
      retryBackoffMs: 0,
    });

    await expect(client.connect()).rejects.toThrow(/authentication methods failed/);
    expect(created).toBe(1);
    expect(auth.connectCalls).toBe(1);
  });

  it('propagates a second consecutive transient failure', async () => {
    const make = (): FakeClient =>
      new FakeClient({
        connect: () => {
          const err = Object.assign(new Error('Connection lost'), { code: 'ECONNRESET' });
          throw err;
        },
      });
    const client = new SshClient(makeConfig(), { clientFactory: make, retryBackoffMs: 0 });
    await expect(client.connect()).rejects.toThrow(/Connection lost/);
  });

  it('builds ssh2 params: readyTimeout, keepalive, auth, passphrase', async () => {
    const fake = new FakeClient();
    const client = new SshClient(
      makeConfig({ username: 'ops', password: 'secret', keyPassphrase: 'kp', connectTimeoutSec: 7 }),
      { clientFactory: () => fake, keepaliveIntervalMs: 12345 },
    );
    await client.connect();

    expect(fake.lastConfig?.readyTimeout).toBe(7000);
    expect(fake.lastConfig?.keepaliveInterval).toBe(12345);
    expect(fake.lastConfig?.keepaliveCountMax).toBe(3);
    expect(fake.lastConfig?.username).toBe('ops');
    expect(fake.lastConfig?.password).toBe('secret');
    expect(fake.lastConfig?.passphrase).toBe('kp');
  });
});

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

describe('SshClient.run', () => {
  it('collects stdout, stderr and exit status', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({ exec: () => channel });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    const pending = client.run('echo hi', 1000);
    setImmediate(() => {
      channel.emit('data', Buffer.from('hello\n'));
      channel.stderr.emit('data', Buffer.from('warn\n'));
      channel.emit('close', 0);
    });
    const result = await pending;

    expect(result).toEqual({ stdout: 'hello\n', stderr: 'warn\n', exitStatus: 0 });
    expect(fake.execCalls[0].command).toBe('echo hi');
  });

  it('returns exit 124 on timeout', async () => {
    const channel = new FakeChannel(); // never emits close
    const fake = new FakeClient({ exec: () => channel });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    const result = await client.run('sleep 99', 25);

    expect(result).toEqual({ stdout: '', stderr: 'command timed out', exitStatus: 124 });
    expect(channel.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runSudo()
// ---------------------------------------------------------------------------

describe('SshClient.runSudo', () => {
  it('writes the password to stdin and keeps it out of argv', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({
      exec: () => {
        setImmediate(() => channel.emit('close', 0));
        return channel;
      },
    });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    const result = await client.runSudo('id -u', 'hunter2', 1000);

    const issued = fake.execCalls[0].command;
    expect(issued).toBe("sudo -S -p '' id -u");
    expect(issued).not.toContain('hunter2');
    expect(channel.written.join('')).toContain('hunter2');
    expect(result.exitStatus).toBe(0);
  });

  it('maps a wrong password to SudoAuthError', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({
      exec: () => {
        setImmediate(() => {
          channel.stderr.emit('data', Buffer.from('Sorry, try again.\n'));
          channel.emit('close', 1);
        });
        return channel;
      },
    });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    await expect(client.runSudo('id', 'wrong', 1000)).rejects.toBeInstanceOf(SudoAuthError);
  });

  it('maps "not in the sudoers" to SudoUnavailable', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({
      exec: () => {
        setImmediate(() => {
          channel.stderr.emit('data', Buffer.from('user is not in the sudoers file.\n'));
          channel.emit('close', 1);
        });
        return channel;
      },
    });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    await expect(client.runSudo('id', 'pw', 1000)).rejects.toBeInstanceOf(SudoUnavailable);
  });

  it('maps "sudo: command not found" to SudoUnavailable', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({
      exec: () => {
        setImmediate(() => {
          channel.stderr.emit('data', Buffer.from('sudo: command not found\n'));
          channel.emit('close', 127);
        });
        return channel;
      },
    });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    await expect(client.runSudo('id', 'pw', 1000)).rejects.toBeInstanceOf(SudoUnavailable);
  });
});

// ---------------------------------------------------------------------------
// KnownHostsStore
// ---------------------------------------------------------------------------

describe('KnownHostsStore', () => {
  it('records tofu fingerprints, detects mismatch, persists atomically', () => {
    const file = tempKnownHostsPath();
    const store = new KnownHostsStore(file);

    expect(store.verify('h', 22, 'fp1')).toBe('unknown');
    store.trust('h', 22, 'fp1');
    expect(store.verify('h', 22, 'fp1')).toBe('ok');
    expect(store.verify('h', 22, 'fp2')).toBe('mismatch');
    expect(store.verify('other', 22, 'fp1')).toBe('unknown');

    const list = store.list();
    expect(list['h:22'].fingerprint).toBe('fp1');
    expect(typeof list['h:22'].added_at).toBe('string');

    // persisted as valid JSON, no leftover temp file
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['h:22']);
    expect(existsSync(`${file}.tmp`)).toBe(false);

    // survives a fresh instance
    expect(new KnownHostsStore(file).verify('h', 22, 'fp1')).toBe('ok');
  });

  it('forgets by host with or without an explicit port', () => {
    const file = tempKnownHostsPath();
    const store = new KnownHostsStore(file);
    store.trust('h', 22, 'fp1');
    store.trust('h', 2222, 'fp2');
    store.trust('other', 22, 'fp3');

    expect(store.forget('h')).toBe(true);
    expect(store.verify('h', 22, 'fp1')).toBe('unknown');
    expect(store.verify('h', 2222, 'fp2')).toBe('unknown');
    expect(store.verify('other', 22, 'fp3')).toBe('ok');
    expect(store.forget('h')).toBe(false);

    expect(KnownHostsStore.forgetStatic(file, 'other')).toBe(true);
    expect(new KnownHostsStore(file).list()).toEqual({});
  });

  it('tolerates a missing or corrupt file as empty', () => {
    const file = tempKnownHostsPath();
    expect(new KnownHostsStore(file).list()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Host key policy driven by the ssh2 hostVerifier
// ---------------------------------------------------------------------------

describe('SshClient host key policies', () => {
  it('computeHostKeyFingerprint matches "<algo> SHA256:<base64>"', () => {
    const blob = hostKeyBlob('ssh-ed25519', Buffer.from([1, 2, 3, 4, 5]));
    expect(computeHostKeyFingerprint(blob)).toBe(`ssh-ed25519 SHA256:${ssha256(blob)}`);
  });

  it('tofu trusts an unknown key on first sight', async () => {
    const file = tempKnownHostsPath();
    const blob = hostKeyBlob('ssh-ed25519', Buffer.from([9, 8, 7]));
    const fake = new FakeClient({ connect: verifierConnect(blob) });
    const client = new SshClient(makeConfig({ hostKeyPolicy: 'tofu', knownHostsPath: file }), {
      clientFactory: () => fake,
    });

    await client.connect();

    expect(new KnownHostsStore(file).verify('10.0.0.1', 22, computeHostKeyFingerprint(blob))).toBe('ok');
  });

  it('tofu raises HostKeyMismatch when the key changed', async () => {
    const file = tempKnownHostsPath();
    const blob = hostKeyBlob('ssh-ed25519', Buffer.from([1, 1, 1]));
    new KnownHostsStore(file).trust('10.0.0.1', 22, 'ssh-ed25519 SHA256:DIFFERENT');
    const fake = new FakeClient({ connect: verifierConnect(blob) });
    const client = new SshClient(makeConfig({ hostKeyPolicy: 'tofu', knownHostsPath: file }), {
      clientFactory: () => fake,
    });

    await expect(client.connect()).rejects.toBeInstanceOf(HostKeyMismatch);
  });

  it('strict rejects an unknown host', async () => {
    const file = tempKnownHostsPath();
    const blob = hostKeyBlob('ssh-ed25519', Buffer.from([4, 4, 4]));
    const fake = new FakeClient({ connect: verifierConnect(blob) });
    const client = new SshClient(makeConfig({ hostKeyPolicy: 'strict', knownHostsPath: file }), {
      clientFactory: () => fake,
    });

    await expect(client.connect()).rejects.toThrow();
    expect(new KnownHostsStore(file).list()).toEqual({});
  });

  it('insecure does not verify the host key', async () => {
    const fake = new FakeClient();
    const client = new SshClient(makeConfig({ hostKeyPolicy: 'insecure' }), { clientFactory: () => fake });
    await client.connect();
    expect(fake.lastConfig?.hostVerifier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// openShell / close
// ---------------------------------------------------------------------------

describe('SshClient.openShell', () => {
  it('opens an xterm-256color PTY and wires data/resize/write/close', async () => {
    const channel = new FakeChannel();
    const fake = new FakeClient({ shell: () => channel });
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });

    const shell = await client.openShell(100, 40);
    expect(fake.shellCalls[0].window).toMatchObject({ term: 'xterm-256color', cols: 100, rows: 40 });

    const received: string[] = [];
    shell.onData((data) => received.push(data));
    channel.emit('data', Buffer.from('prompt$ '));
    expect(received).toEqual(['prompt$ ']);

    shell.write('ls\n');
    expect(channel.written).toContain('ls\n');

    shell.resize(80, 24);
    expect(channel.windowSize).toEqual({ rows: 24, cols: 80 });

    shell.close();
    expect(channel.closed).toBe(true);
  });

  it('defaults to 120x30', async () => {
    const fake = new FakeClient();
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });
    await client.openShell();
    expect(fake.shellCalls[0].window).toMatchObject({ cols: 120, rows: 30 });
  });

  it('close() ends the underlying client', async () => {
    const fake = new FakeClient();
    const client = new SshClient(makeConfig(), { clientFactory: () => fake });
    await client.connect();
    client.close();
    expect(fake.ended).toBe(true);
  });
});
