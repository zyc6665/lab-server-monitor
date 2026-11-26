import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import type { ConnectConfig, SyncHostVerifier } from 'ssh2';

import { nowIsoUtc } from '../storage/time';
import type { CommandResult } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type HostKeyPolicy = 'tofu' | 'strict' | 'insecure';

export interface SshConnectConfig {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  privateKeyPath?: string;
  keyPassphrase?: string;
  connectTimeoutSec: number;
  hostKeyPolicy: HostKeyPolicy;
  knownHostsPath?: string;
}

export interface KnownHostsEntry {
  fingerprint: string;
  added_at: string;
}

/**
 * Minimal structural surface of an `ssh2` client that this module relies on.
 * Tests inject a fake implementation; production uses `new (require('ssh2').Client)()`.
 */
export interface Ssh2ChannelLike {
  write(data: string | Buffer): unknown;
  end(): unknown;
  close(): unknown;
  destroy(): unknown;
  setWindow(rows: number, cols: number, height: number, width: number): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  stderr: { on(event: string, listener: (...args: any[]) => void): unknown };
}

export interface Ssh2ClientLike {
  connect(config: ConnectConfig): unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  exec(command: string, callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void): unknown;
  shell(
    window: { term?: string; cols?: number; rows?: number },
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): unknown;
  end(): unknown;
  destroy(): unknown;
}

export interface SshClientDeps {
  clientFactory?: () => Ssh2ClientLike;
  connectTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  /** Backoff between the sole transient-connect retry; exposed for tests. */
  retryBackoffMs?: number;
}

/** Handle returned by {@link SshClient.openShell}. */
export interface ShellChannel {
  write(data: string): void;
  onData(callback: (data: string) => void): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SudoAuthError extends Error {
  constructor(message = 'sudo authentication failed') {
    super(message);
    this.name = 'SudoAuthError';
  }
}

export class SudoUnavailable extends Error {
  constructor(message = 'sudo is not available') {
    super(message);
    this.name = 'SudoUnavailable';
  }
}

export class HostKeyMismatch extends Error {
  constructor(message = 'host key mismatch') {
    super(message);
    this.name = 'HostKeyMismatch';
  }
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * Compute the OpenSSH-style fingerprint `"<algo> SHA256:<base64-no-padding>"`
 * from a raw host-key blob (the wire format `uint32 nameLen | algo | key`).
 */
export function computeHostKeyFingerprint(key: Buffer): string {
  if (key.length < 4) {
    throw new Error('invalid host key: too short');
  }
  const nameLength = key.readUInt32BE(0);
  if (nameLength <= 0 || 4 + nameLength > key.length) {
    throw new Error('invalid host key: bad algorithm length');
  }
  const algorithm = key.subarray(4, 4 + nameLength).toString('ascii');
  const digest = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  return `${algorithm} SHA256:${digest}`;
}

// ---------------------------------------------------------------------------
// Known hosts store
// ---------------------------------------------------------------------------

/**
 * Persisted trust-on-first-use store. Entries are keyed `"<host>:<port>"` and
 * written atomically (temp file + rename), mirroring the Python `_write_store`.
 */
export class KnownHostsStore {
  constructor(private readonly filePath: string) {}

  private static key(host: string, port: number): string {
    return `${host}:${port}`;
  }

  private read(): Record<string, KnownHostsEntry> {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, KnownHostsEntry>;
      }
      return {};
    } catch {
      return {};
    }
  }

  private write(entries: Record<string, KnownHostsEntry>): void {
    const parent = dirname(this.filePath);
    if (parent) {
      mkdirSync(parent, { recursive: true });
    }
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
    renameSync(temp, this.filePath);
  }

  verify(host: string, port: number, fingerprint: string): 'ok' | 'mismatch' | 'unknown' {
    const entry = this.read()[KnownHostsStore.key(host, port)];
    if (!entry) {
      return 'unknown';
    }
    return entry.fingerprint === fingerprint ? 'ok' : 'mismatch';
  }

  trust(host: string, port: number, fingerprint: string): void {
    const entries = this.read();
    entries[KnownHostsStore.key(host, port)] = { fingerprint, added_at: nowIsoUtc() };
    this.write(entries);
  }

  forget(host: string): boolean {
    const entries = this.read();
    let removed = false;
    for (const key of Object.keys(entries)) {
      if (key === host || key.startsWith(`${host}:`)) {
        delete entries[key];
        removed = true;
      }
    }
    if (removed) {
      this.write(entries);
    }
    return removed;
  }

  static forgetStatic(filePath: string, host: string): boolean {
    return new KnownHostsStore(filePath).forget(host);
  }

  list(): Record<string, KnownHostsEntry> {
    return this.read();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Mirrors Python `_is_transient_connect_error`: authentication/parse failures
 * are terminal; socket/timeout failures are worth one retry.
 */
export function isTransientConnectError(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  const message = typeof err?.message === 'string' ? err.message : '';
  if (/all configured authentication methods failed/i.test(message)) {
    return false;
  }
  if (/cannot parse privatekey/i.test(message)) {
    return false;
  }
  if (TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }
  return /timeout|timed out|connection lost|banner timeout/i.test(message);
}

const SUDO_AUTH_MARKERS = ['incorrect password', 'sorry, try again'];
const SUDO_UNAVAILABLE_MARKERS = [
  'not in the sudoers',
  'sudo: command not found',
  'a password is required',
  'no tty present',
  'askpass',
  'is not allowed to',
  'may not run sudo',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function expandUser(input: string): string {
  if (input === '~') {
    return homedir();
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return resolve(homedir(), input.slice(2));
  }
  return input;
}

function defaultClientFactory(): Ssh2ClientLike {
  // Lazy require so that test runs that inject a fake never load ssh2.
  const ssh2 = require('ssh2') as { Client: new () => unknown };
  return new ssh2.Client() as unknown as Ssh2ClientLike;
}

// ---------------------------------------------------------------------------
// SshClient
// ---------------------------------------------------------------------------

export class SshClient {
  private readonly clientFactory: () => Ssh2ClientLike;
  private readonly connectTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private readonly retryBackoffMs: number;
  private readonly knownHosts: KnownHostsStore | null;
  private readonly effectiveHostKeyPolicy: HostKeyPolicy;

  private client: Ssh2ClientLike | null = null;
  private pendingHostKeyError: Error | null = null;

  constructor(
    private readonly cfg: SshConnectConfig,
    deps: SshClientDeps = {},
  ) {
    this.clientFactory = deps.clientFactory ?? defaultClientFactory;
    this.connectTimeoutMs = deps.connectTimeoutMs ?? Math.round(cfg.connectTimeoutSec * 1000);
    this.keepaliveIntervalMs = deps.keepaliveIntervalMs ?? 30_000;
    this.retryBackoffMs = deps.retryBackoffMs ?? 1000;

    if (cfg.hostKeyPolicy !== 'insecure' && cfg.knownHostsPath) {
      this.knownHosts = new KnownHostsStore(cfg.knownHostsPath);
      this.effectiveHostKeyPolicy = cfg.hostKeyPolicy;
    } else {
      // No store configured: fall back to insecure, like the Python client when
      // configure_host_keys() was never called.
      this.knownHosts = null;
      this.effectiveHostKeyPolicy = 'insecure';
    }
  }

  // -- connection ----------------------------------------------------------

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }
    this.client = await this.openConnection();
  }

  private async openConnection(): Promise<Ssh2ClientLike> {
    const config = this.buildConnectConfig();
    this.pendingHostKeyError = null;

    let client = this.clientFactory();
    try {
      await this.connectOnce(client, config);
      return client;
    } catch (error) {
      const hostKeyError = this.takePendingHostKeyError();
      this.safeDestroy(client);
      if (hostKeyError) {
        throw hostKeyError;
      }
      if (!isTransientConnectError(error)) {
        throw error;
      }
    }

    await sleep(this.retryBackoffMs);
    client = this.clientFactory();
    try {
      await this.connectOnce(client, config);
      return client;
    } catch (error) {
      const hostKeyError = this.takePendingHostKeyError();
      this.safeDestroy(client);
      throw hostKeyError ?? error;
    }
  }

  private connectOnce(client: Ssh2ClientLike, config: ConnectConfig): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      let settled = false;
      const onReady = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolveConnect();
      };
      const onError = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        rejectConnect(error);
      };

      client.once('ready', onReady);
      client.once('error', onError);

      try {
        client.connect(config);
      } catch (error) {
        if (!settled) {
          settled = true;
          rejectConnect(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
  }

  private buildConnectConfig(): ConnectConfig {
    const config: ConnectConfig = {
      host: this.cfg.host,
      port: this.cfg.port,
      username: this.cfg.username,
      readyTimeout: this.connectTimeoutMs,
      keepaliveInterval: this.keepaliveIntervalMs,
      keepaliveCountMax: 3,
    };

    if (this.cfg.password !== undefined) {
      config.password = this.cfg.password;
    }
    if (this.cfg.privateKey !== undefined) {
      config.privateKey = this.cfg.privateKey;
    } else if (this.cfg.privateKeyPath !== undefined) {
      config.privateKey = readFileSync(expandUser(this.cfg.privateKeyPath));
    }
    if (this.cfg.keyPassphrase !== undefined) {
      config.passphrase = this.cfg.keyPassphrase;
    }

    if (this.effectiveHostKeyPolicy !== 'insecure' && this.knownHosts) {
      // Do not set `hostHash`: ssh2 then hands the hostVerifier the raw key blob,
      // which lets us derive the OpenSSH SHA256 fingerprint ourselves.
      const verifier: SyncHostVerifier = (key: Buffer) => this.verifyHostKey(key);
      config.hostVerifier = verifier;
    }

    return config;
  }

  private verifyHostKey(key: Buffer | string): boolean {
    if (!this.knownHosts) {
      return true;
    }
    if (typeof key === 'string') {
      // Defensive: a hex digest would mean hostHash was configured upstream.
      return true;
    }

    const fingerprint = computeHostKeyFingerprint(key);
    const verdict = this.knownHosts.verify(this.cfg.host, this.cfg.port, fingerprint);
    if (verdict === 'ok') {
      return true;
    }
    if (verdict === 'unknown') {
      if (this.effectiveHostKeyPolicy === 'tofu') {
        this.knownHosts.trust(this.cfg.host, this.cfg.port, fingerprint);
        return true;
      }
      // strict: an unknown key is rejected (ssh2 will surface a handshake error).
      return false;
    }

    const known = this.knownHosts.list()[`${this.cfg.host}:${this.cfg.port}`];
    this.pendingHostKeyError = new HostKeyMismatch(
      `host key mismatch for ${this.cfg.host}:${this.cfg.port}: ` +
        `known ${known ? known.fingerprint : '<none>'}, presented ${fingerprint}`,
    );
    return false;
  }

  private takePendingHostKeyError(): Error | null {
    const error = this.pendingHostKeyError;
    this.pendingHostKeyError = null;
    return error;
  }

  private safeDestroy(client: Ssh2ClientLike): void {
    try {
      client.destroy();
    } catch {
      // ignore teardown errors
    }
  }

  // -- commands ------------------------------------------------------------

  async run(command: string, timeoutMs: number): Promise<CommandResult> {
    await this.connect();
    return this.execInternal(command, timeoutMs);
  }

  async runSudo(command: string, password: string, timeoutMs: number): Promise<CommandResult> {
    await this.connect();
    const result = await this.execInternal(`sudo -S -p '' ${command}`, timeoutMs, password + '\n');

    if (result.exitStatus !== 0) {
      const haystack = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (SUDO_AUTH_MARKERS.some((marker) => haystack.includes(marker))) {
        throw new SudoAuthError('sudo rejected the supplied password');
      }
      if (SUDO_UNAVAILABLE_MARKERS.some((marker) => haystack.includes(marker))) {
        throw new SudoUnavailable('sudo is unavailable for this user');
      }
    }
    return result;
  }

  private execInternal(command: string, timeoutMs: number, stdin?: string): Promise<CommandResult> {
    return new Promise<CommandResult>((resolveExec, rejectExec) => {
      const client = this.client;
      if (!client) {
        rejectExec(new Error('SSH client is not connected'));
        return;
      }

      client.exec(command, (error, channel) => {
        if (error) {
          rejectExec(error);
          return;
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const finish = (result: CommandResult): void => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          resolveExec(result);
        };

        channel.on('data', (chunk: Buffer | string) => {
          stdout += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        channel.stderr.on('data', (chunk: Buffer | string) => {
          stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        channel.on('close', (code?: number | null) => {
          finish({ stdout, stderr, exitStatus: typeof code === 'number' ? code : 0 });
        });
        channel.on('error', (streamError: Error) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
          }
          rejectExec(streamError);
        });

        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            if (settled) {
              return;
            }
            try {
              channel.destroy();
            } catch {
              // ignore
            }
            finish({ stdout: '', stderr: 'command timed out', exitStatus: 124 });
          }, timeoutMs);
        }

        if (stdin !== undefined) {
          try {
            channel.write(stdin);
          } catch {
            // Channel already closed; the close/error handler will settle.
          }
        }
      });
    });
  }

  // -- interactive shell ---------------------------------------------------

  async openShell(cols = 120, rows = 30): Promise<ShellChannel> {
    await this.connect();
    const client = this.client;
    if (!client) {
      throw new Error('SSH client is not connected');
    }

    const channel = await new Promise<Ssh2ChannelLike>((resolveShell, rejectShell) => {
      client.shell({ term: 'xterm-256color', cols, rows }, (error, opened) => {
        if (error) {
          rejectShell(error);
        } else {
          resolveShell(opened);
        }
      });
    });

    const listeners: Array<(data: string) => void> = [];
    channel.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const listener of listeners) {
        listener(text);
      }
    });

    return {
      write: (data: string): void => {
        channel.write(data);
      },
      onData: (callback: (data: string) => void): void => {
        listeners.push(callback);
      },
      resize: (nextCols: number, nextRows: number): void => {
        channel.setWindow(nextRows, nextCols, 0, 0);
      },
      close: (): void => {
        try {
          channel.close();
        } catch {
          // ignore
        }
      },
    };
  }

  // -- teardown ------------------------------------------------------------

  close(): void {
    const client = this.client;
    this.client = null;
    if (!client) {
      return;
    }
    try {
      client.end();
    } catch {
      // ignore
    }
  }
}
