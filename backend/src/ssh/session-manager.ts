/**
 * SSH interactive terminal session manager.
 *
 * Node/TypeScript port of `servermanage/ssh_terminal.py`. It owns the lifecycle
 * of ssh2 shell channels behind the HTTP routes in
 * `backend/src/web/routes/ssh-terminal.ts`:
 *
 *   - `create` opens a PTY shell through an injectable client factory and
 *     returns a random session id (reserving a slot while it connects so the
 *     concurrent-session cap cannot be raced past).
 *   - per-session output is buffered into a bounded queue (oldest chunks are
 *     dropped) that `stream` consumes; a queue timeout yields an empty chunk so
 *     the SSE route can emit `: keepalive`.
 *   - `sendInput` / `resize` write through to the PTY; `close` tears the channel
 *     and client down and finalises the audit row.
 *   - an idle sweep closes sessions whose last activity exceeded the timeout.
 *
 * Audit rows (`ssh_audit_sessions`) are started/ended through injectable hooks so
 * the manager stays decoupled from the storage layer (the composition root binds
 * them to `recordSshSessionStart` / `recordSshSessionEnd`).
 */
import { randomBytes } from 'node:crypto';

import type { HostConfig } from '../config/config';
import { hostToSshConnectConfig } from '../collect/collectors';
import { SshClient, type ShellChannel } from '../collect/ssh-client';

// ---------------------------------------------------------------------------
// Errors (mirror the Python exception hierarchy)
// ---------------------------------------------------------------------------

/** Base class for terminal session errors. */
export class TerminalError extends Error {
  constructor(message = 'terminal error') {
    super(message);
    this.name = 'TerminalError';
  }
}

/** Raised when the concurrent-session limit is reached (route → 429). */
export class TerminalLimitError extends TerminalError {
  constructor(message = 'terminal limit reached') {
    super(message);
    this.name = 'TerminalLimitError';
  }
}

/** Raised when a session id is unknown (route → 404). */
export class SessionNotFoundError extends TerminalError {
  constructor(message = 'session not found') {
    super(message);
    this.name = 'SessionNotFoundError';
  }
}

/** Raised when acting on an already-closed session. */
export class SessionClosedError extends SessionNotFoundError {
  constructor(message = 'session closed') {
    super(message);
    this.name = 'SessionClosedError';
  }
}

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/** Everything needed to open + tear down one shell for a host. */
export interface SshShellClient {
  openShell(cols: number, rows: number): Promise<ShellChannel>;
  close(): void;
}

/** Builds a shell client for a host (defaults to a real {@link SshClient}). */
export type SshShellClientFactory = (host: HostConfig) => SshShellClient;

/** Context supplied by the route when creating a session (audit metadata). */
export interface SshSessionCreateContext {
  /** Logged-in dashboard username (oracle defaults to `admin`). */
  username?: string;
  /** Client address (oracle defaults to `127.0.0.1`). */
  remoteAddr?: string;
}

/** Input for starting an audit row. */
export interface SshAuditStartInput {
  hostName: string;
  username: string;
  serverUsername?: string | null;
  remoteAddr?: string;
}

/** Storage hooks for the `ssh_audit_sessions` table. */
export interface SshAuditHooks {
  /** Insert an `active` row and return its id (or null when unavailable). */
  recordStart?(input: SshAuditStartInput): number | null | undefined;
  /** Finalise a row with a terminal status (`closed` / `error`). */
  recordEnd?(auditId: number, status: 'closed' | 'error', error?: string): void;
}

/** The injectable manager surface used by the SSH terminal routes. */
export interface SshSessionManager {
  /** Allocate a session for `host` and return its id. */
  create(
    host: HostConfig,
    cols: number,
    rows: number,
    context?: SshSessionCreateContext,
  ): string | Promise<string>;
  /** Whether a session id currently exists (live or retained-closed). */
  getSession(sessionId: string): boolean;
  /** Write raw client input to the session's PTY. */
  sendInput(sessionId: string, data: string): void;
  /** Resize the session's PTY. */
  resize(sessionId: string, cols: number, rows: number): void;
  /** Close the session; returns whether a live session was closed. */
  close(sessionId: string): boolean;
  /** Async stream of output chunks (`''`/empty → SSE keepalive comment). */
  stream(sessionId: string): AsyncIterable<Uint8Array | string>;
}

/** Construction options for {@link SshTerminalManager}. */
export interface SshTerminalManagerOptions {
  /** Maximum concurrent live sessions (default 8). */
  maxSessions?: number;
  /** Idle timeout in milliseconds (default 30 min); 0 disables the sweep. */
  idleTimeoutMs?: number;
  /** Per-session output queue depth (default 256; oldest chunks dropped). */
  outputQueueSize?: number;
  /** Retained-closed session ids kept for 404/late-stream accuracy (default 32). */
  closedSessionRetention?: number;
  /** SSH connect timeout in seconds used by the default client factory. */
  connectTimeoutSec?: number;
  /** Host-key policy passed to the default client factory. */
  hostKeyPolicy?: string;
  /** Idle-sweep interval in milliseconds (default 30 s). */
  sweepIntervalMs?: number;
  /** SSE queue-read timeout that emits a keepalive (default 15 s). */
  keepaliveMs?: number;
  /** Clock (ms). Defaults to `Date.now`. */
  clock?: () => number;
  /** Shell client factory; defaults to a real {@link SshClient}. */
  clientFactory?: SshShellClientFactory;
  /** Audit storage hooks (omitted in unit tests). */
  audit?: SshAuditHooks;
}

// ---------------------------------------------------------------------------
// Bounded output queue
// ---------------------------------------------------------------------------

type QueueRead = Buffer | undefined | 'timeout';

/**
 * A bounded async chunk queue. `push` drops the oldest chunk once full; `next`
 * resolves with a chunk, `undefined` once ended+empty, or `'timeout'` after the
 * timeout so the caller can emit a keepalive.
 */
class OutputBuffer {
  private readonly chunks: Buffer[] = [];
  private readonly waiters: Array<(value: QueueRead) => void> = [];
  private ended = false;

  constructor(private readonly maxSize: number) {}

  push(chunk: Buffer): void {
    if (this.ended) {
      return;
    }
    this.chunks.push(chunk);
    while (this.chunks.length > this.maxSize) {
      this.chunks.shift();
    }
    this.flush();
  }

  end(): void {
    this.ended = true;
    this.flush();
  }

  get size(): number {
    return this.chunks.length;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  private flush(): void {
    while (this.waiters.length > 0 && this.chunks.length > 0) {
      const waiter = this.waiters.shift();
      const chunk = this.chunks.shift();
      if (waiter && chunk !== undefined) {
        waiter(chunk);
      }
    }
    if (this.ended && this.chunks.length === 0) {
      while (this.waiters.length > 0) {
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(undefined);
        }
      }
    }
  }

  next(timeoutMs: number): Promise<QueueRead> {
    if (this.chunks.length > 0) {
      return Promise.resolve(this.chunks.shift());
    }
    if (this.ended) {
      return Promise.resolve(undefined);
    }

    return new Promise<QueueRead>((resolve) => {
      let settled = false;
      const waiter = (value: QueueRead): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        resolve('timeout');
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

interface ManagedSession {
  id: string;
  hostName: string;
  serverUsername: string;
  client: SshShellClient;
  channel: ShellChannel;
  buffer: OutputBuffer;
  closed: boolean;
  endStatus: 'closed' | 'error';
  endError?: string;
  auditId: number | null;
  auditFinalised: boolean;
  createdAt: number;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Default shell-client factory backed by {@link SshClient}. */
function defaultShellClientFactory(
  connectTimeoutSec: number,
  hostKeyPolicy?: string,
): SshShellClientFactory {
  return (host: HostConfig): SshShellClient => {
    const client = new SshClient(
      hostToSshConnectConfig(host, connectTimeoutSec, hostKeyPolicy),
    );
    return {
      openShell: (cols: number, rows: number) => client.openShell(cols, rows),
      close: () => client.close(),
    };
  };
}

/**
 * Tracks interactive SSH PTY sessions opened by the terminal routes.
 *
 * Mirrors the Python `SshTerminalManager` defaults: 8 concurrent sessions, a
 * 30-minute idle timeout, a 256-chunk output queue, a 30-second sweep and 32
 * retained-closed ids.
 */
export class SshTerminalManager implements SshSessionManager {
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly outputQueueSize: number;
  private readonly closedSessionRetention: number;
  private readonly keepaliveMs: number;
  private readonly clock: () => number;
  private readonly clientFactory: SshShellClientFactory;
  private readonly audit: SshAuditHooks;

  private readonly sessions = new Map<string, ManagedSession>();
  private readonly closedSessions = new Map<string, ManagedSession>();
  /** Sessions currently connecting (count against the limit). */
  private pending = 0;
  private readonly sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(options: SshTerminalManagerOptions = {}) {
    this.maxSessions = Math.max(1, Math.trunc(options.maxSessions ?? 8));
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 30 * 60 * 1000);
    this.outputQueueSize = Math.max(1, Math.trunc(options.outputQueueSize ?? 256));
    this.closedSessionRetention = Math.max(0, Math.trunc(options.closedSessionRetention ?? 32));
    this.keepaliveMs = Math.max(1, Math.trunc(options.keepaliveMs ?? 15_000));
    this.clock = options.clock ?? Date.now;
    this.clientFactory =
      options.clientFactory ??
      defaultShellClientFactory(options.connectTimeoutSec ?? 10, options.hostKeyPolicy);
    this.audit = options.audit ?? {};

    const sweepIntervalMs = Math.max(0, options.sweepIntervalMs ?? 30_000);
    if (sweepIntervalMs > 0 && this.idleTimeoutMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.reapIdle();
      }, sweepIntervalMs);
      // Never keep the process alive just for the sweep.
      if (typeof this.sweepTimer.unref === 'function') {
        this.sweepTimer.unref();
      }
    } else {
      this.sweepTimer = null;
    }
  }

  // -- lifecycle -----------------------------------------------------------

  async create(
    host: HostConfig,
    cols: number,
    rows: number,
    context: SshSessionCreateContext = {},
  ): Promise<string> {
    if (this.sessions.size + this.pending >= this.maxSessions) {
      throw new TerminalLimitError();
    }

    const id = randomBytes(32).toString('base64url');
    this.pending += 1;

    let client: SshShellClient;
    let channel: ShellChannel;
    try {
      client = this.clientFactory(host);
      channel = await client.openShell(cols, rows);
    } catch (error) {
      this.pending -= 1;
      throw error;
    }

    const now = this.clock();
    const buffer = new OutputBuffer(this.outputQueueSize);
    const session: ManagedSession = {
      id,
      hostName: host.name,
      serverUsername: host.username,
      client,
      channel,
      buffer,
      closed: false,
      endStatus: 'closed',
      auditId: null,
      auditFinalised: false,
      createdAt: now,
      lastActivity: now,
    };

    channel.onData((data: string) => {
      session.lastActivity = this.clock();
      buffer.push(Buffer.from(data, 'utf8'));
    });
    if (typeof channel.onClose === 'function') {
      channel.onClose((error?: Error) => {
        this.handleRemoteClose(session, error);
      });
    }

    this.sessions.set(id, session);
    this.pending -= 1;

    // Record the audit row only once the shell is actually up (oracle order).
    if (this.audit.recordStart) {
      try {
        const auditId = this.audit.recordStart({
          hostName: host.name,
          username: context.username && context.username.length > 0 ? context.username : 'admin',
          serverUsername: host.username,
          remoteAddr: context.remoteAddr && context.remoteAddr.length > 0
            ? context.remoteAddr
            : '127.0.0.1',
        });
        session.auditId = typeof auditId === 'number' ? auditId : null;
      } catch (error) {
        // A failed audit insert must not leak a live shell.
        this.sessions.delete(id);
        this.hardClose(session);
        throw error;
      }
    }

    return id;
  }

  getSession(sessionId: string): boolean {
    return this.sessions.has(sessionId) || this.closedSessions.has(sessionId);
  }

  sendInput(sessionId: string, data: string): void {
    const session = this.requireLive(sessionId);
    session.lastActivity = this.clock();
    session.channel.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireLive(sessionId);
    session.lastActivity = this.clock();
    session.channel.resize(cols, rows);
  }

  close(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    this.sessions.delete(sessionId);
    session.closed = true;
    session.buffer.end();
    this.finaliseAudit(session);
    this.retainClosed(session);
    this.hardClose(session);
    return true;
  }

  async *stream(sessionId: string): AsyncIterable<Uint8Array | string> {
    const session = this.sessions.get(sessionId) ?? this.closedSessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    for (;;) {
      const next = await session.buffer.next(this.keepaliveMs);
      if (next === 'timeout') {
        yield '';
        continue;
      }
      if (next === undefined) {
        return;
      }
      session.lastActivity = this.clock();
      yield next;
    }
  }

  /** Closes sessions whose idle time exceeded the timeout. */
  reapIdle(): void {
    if (this.idleTimeoutMs <= 0) {
      return;
    }
    const now = this.clock();
    for (const [id, session] of [...this.sessions.entries()]) {
      if (now - session.lastActivity >= this.idleTimeoutMs) {
        this.close(id);
      }
    }
  }

  /** Stops the sweep timer and closes every live session (tests / shutdown). */
  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const id of [...this.sessions.keys()]) {
      this.close(id);
    }
  }

  // -- internals -----------------------------------------------------------

  /** Returns a live session or throws the oracle's 404/closed errors. */
  private requireLive(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      if (this.closedSessions.has(sessionId)) {
        throw new SessionClosedError();
      }
      throw new SessionNotFoundError();
    }
    if (session.closed) {
      throw new SessionClosedError();
    }
    return session;
  }

  /** Marks a session closed after the remote side ended the shell. */
  private handleRemoteClose(session: ManagedSession, error?: Error): void {
    if (session.closed) {
      return;
    }
    session.closed = true;
    session.endStatus = error ? 'error' : 'closed';
    if (error) {
      session.endError = error.message;
    }
    session.buffer.end();
  }

  /** Best-effort channel + client teardown; never throws. */
  private hardClose(session: ManagedSession): void {
    try {
      session.channel.close();
    } catch {
      // ignore
    }
    try {
      session.client.close();
    } catch {
      // ignore
    }
  }

  private finaliseAudit(session: ManagedSession): void {
    if (session.auditFinalised || !this.audit.recordEnd || session.auditId === null) {
      session.auditFinalised = true;
      return;
    }
    session.auditFinalised = true;
    try {
      this.audit.recordEnd(session.auditId, session.endStatus, session.endError);
    } catch {
      // Audit finalisation is best-effort during teardown.
    }
  }

  private retainClosed(session: ManagedSession): void {
    if (this.closedSessionRetention <= 0) {
      return;
    }
    this.closedSessions.delete(session.id);
    this.closedSessions.set(session.id, session);
    while (this.closedSessions.size > this.closedSessionRetention) {
      const oldest = this.closedSessions.keys().next();
      if (oldest.done) {
        break;
      }
      this.closedSessions.delete(oldest.value);
    }
  }
}
