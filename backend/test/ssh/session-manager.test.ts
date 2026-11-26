/**
 * Unit tests for the SSH terminal session manager (`src/ssh/session-manager.ts`).
 *
 * Everything is in-memory: a fake shell client/channel replaces ssh2, a fake
 * clock drives the idle sweep and a fake audit sink records start/end calls.
 * No real host is contacted.
 */
import { describe, expect, it } from 'vitest';

import type { HostConfig } from '../../src/config/config';
import type { ShellChannel } from '../../src/collect/ssh-client';
import {
  SessionClosedError,
  SessionNotFoundError,
  SshTerminalManager,
  TerminalLimitError,
  type SshAuditStartInput,
  type SshSessionCreateContext,
  type SshShellClient,
} from '../../src/ssh/session-manager';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeShellChannel implements ShellChannel {
  readonly written: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closed = false;

  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly closeListeners: Array<(error?: Error) => void> = [];

  write(data: string): void {
    this.written.push(data);
  }

  onData(callback: (data: string) => void): void {
    this.dataListeners.push(callback);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  close(): void {
    this.closed = true;
  }

  onClose(callback: (error?: Error) => void): void {
    this.closeListeners.push(callback);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) {
      listener(data);
    }
  }

  emitClose(error?: Error): void {
    for (const listener of this.closeListeners) {
      listener(error);
    }
  }
}

class FakeShellClient implements SshShellClient {
  readonly channel = new FakeShellChannel();
  opened: { cols: number; rows: number } | null = null;
  closed = false;

  async openShell(cols: number, rows: number): Promise<ShellChannel> {
    this.opened = { cols, rows };
    return this.channel;
  }

  close(): void {
    this.closed = true;
  }
}

function makeHost(overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    name: 'alpha',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    auth: { type: 'password' } as never,
    tags: [],
    disk_mounts: ['/'],
    group: '',
    owner: '',
    location: '',
    notes: '',
    checks: [],
    allow_user_write: false,
    ...overrides,
  };
}

interface Harness {
  manager: SshTerminalManager;
  clients: FakeShellClient[];
  auditStarts: SshAuditStartInput[];
  auditEnds: Array<{ id: number; status: string; error?: string }>;
  advance: (ms: number) => void;
}

function createHarness(options: {
  maxSessions?: number;
  outputQueueSize?: number;
  idleTimeoutMs?: number;
  keepaliveMs?: number;
  closedSessionRetention?: number;
} = {}): Harness {
  const clients: FakeShellClient[] = [];
  const auditStarts: SshAuditStartInput[] = [];
  const auditEnds: Array<{ id: number; status: string; error?: string }> = [];
  let auditSeq = 0;
  let now = 1_000;

  const manager = new SshTerminalManager({
    maxSessions: options.maxSessions,
    outputQueueSize: options.outputQueueSize,
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    keepaliveMs: options.keepaliveMs ?? 50,
    closedSessionRetention: options.closedSessionRetention,
    sweepIntervalMs: 0, // drive the sweep manually in tests
    clock: () => now,
    clientFactory: () => {
      const client = new FakeShellClient();
      clients.push(client);
      return client;
    },
    audit: {
      recordStart: (input) => {
        auditStarts.push(input);
        return ++auditSeq;
      },
      recordEnd: (id, status, error) => {
        auditEnds.push({ id, status, error });
      },
    },
  });

  return {
    manager,
    clients,
    auditStarts,
    auditEnds,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** Drains an async iterable, optionally stopping after `limit` chunks. */
async function collect(
  iterable: AsyncIterable<Uint8Array | string>,
  limit?: number,
): Promise<Array<Uint8Array | string>> {
  const out: Array<Uint8Array | string> = [];
  for await (const chunk of iterable) {
    out.push(chunk);
    if (limit !== undefined && out.length >= limit) {
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SshTerminalManager — create', () => {
  it('opens a PTY shell, returns a random id and records the audit start', async () => {
    const harness = createHarness();
    const context: SshSessionCreateContext = { username: 'alice', remoteAddr: '10.9.8.7' };

    const id = await harness.manager.create(makeHost(), 100, 40, context);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(20);
    expect(harness.manager.getSession(id)).toBe(true);
    expect(harness.clients).toHaveLength(1);
    expect(harness.clients[0].opened).toEqual({ cols: 100, rows: 40 });
    expect(harness.auditStarts).toEqual([
      {
        hostName: 'alpha',
        username: 'alice',
        serverUsername: 'root',
        remoteAddr: '10.9.8.7',
      },
    ]);
  });

  it('defaults the audit username/remote addr like the oracle', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    expect(harness.manager.getSession(id)).toBe(true);
    expect(harness.auditStarts[0]).toMatchObject({ username: 'admin', remoteAddr: '127.0.0.1' });
  });

  it('enforces the concurrent-session limit with TerminalLimitError', async () => {
    const harness = createHarness({ maxSessions: 1 });
    await harness.manager.create(makeHost(), 80, 24, { username: 'a' });

    await expect(harness.manager.create(makeHost(), 80, 24)).rejects.toBeInstanceOf(
      TerminalLimitError,
    );
    expect(harness.auditStarts).toHaveLength(1);
  });

  it('releases the reserved slot when the shell fails to open', async () => {
    let attempts = 0;
    const manager = new SshTerminalManager({
      maxSessions: 1,
      sweepIntervalMs: 0,
      clientFactory: () => {
        attempts += 1;
        return {
          openShell: async () => {
            throw new Error('connect failed');
          },
          close: () => undefined,
        };
      },
    });

    await expect(manager.create(makeHost(), 80, 24)).rejects.toThrow('connect failed');
    expect(attempts).toBe(1);
    // Slot freed, so a second attempt is allowed to try again.
    await expect(manager.create(makeHost(), 80, 24)).rejects.toThrow('connect failed');
    expect(attempts).toBe(2);
  });
});

describe('SshTerminalManager — input / resize', () => {
  it('forwards input and resize to the shell channel', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    const channel = harness.clients[0].channel;

    harness.manager.sendInput(id, 'ls\\r');
    harness.manager.resize(id, 120, 50);

    expect(channel.written).toEqual(['ls\\r']);
    expect(channel.resizes).toEqual([{ cols: 120, rows: 50 }]);
  });

  it('throws SessionNotFoundError for an unknown id', () => {
    const harness = createHarness();
    expect(() => harness.manager.sendInput('missing', 'x')).toThrow(SessionNotFoundError);
    expect(() => harness.manager.resize('missing', 80, 24)).toThrow(SessionNotFoundError);
  });

  it('throws SessionClosedError after the session is closed', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    harness.manager.close(id);

    expect(() => harness.manager.sendInput(id, 'x')).toThrow(SessionClosedError);
    expect(() => harness.manager.resize(id, 80, 24)).toThrow(SessionClosedError);
  });
});

describe('SshTerminalManager — output streaming', () => {
  it('yields buffered output as Buffers', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    harness.clients[0].channel.emitData('hello ');
    harness.clients[0].channel.emitData('world');

    const chunks = await collect(harness.manager.stream(id), 2);
    expect(chunks.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual([
      'hello ',
      'world',
    ]);
  });

  it('emits an empty keepalive chunk on queue timeout and ends when closed', async () => {
    const harness = createHarness({ keepaliveMs: 5 });
    const id = await harness.manager.create(makeHost(), 80, 24);
    const iterator = harness.manager.stream(id)[Symbol.asyncIterator]();

    // Nothing queued yet → keepalive.
    const first = await iterator.next();
    expect(first.done).toBe(false);
    expect(first.value).toBe('');

    harness.clients[0].channel.emitData('data');
    const second = await iterator.next();
    expect(second.done).toBe(false);
    expect(Buffer.from(second.value as Uint8Array).toString('utf8')).toBe('data');

    harness.manager.close(id);
    const third = await iterator.next();
    expect(third.done).toBe(true);
  });

  it('drops the oldest chunks when the output queue overflows', async () => {
    const harness = createHarness({ outputQueueSize: 2 });
    const id = await harness.manager.create(makeHost(), 80, 24);
    harness.clients[0].channel.emitData('one');
    harness.clients[0].channel.emitData('two');
    harness.clients[0].channel.emitData('three');

    const chunks = await collect(harness.manager.stream(id), 2);
    expect(chunks.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual(['two', 'three']);
  });

  it('ends the stream when the remote side closes the channel', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    harness.clients[0].channel.emitData('bye');
    harness.clients[0].channel.emitClose();

    const chunks = await collect(harness.manager.stream(id));
    expect(chunks.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual(['bye']);
  });

  it('throws SessionNotFoundError when streaming an unknown id', async () => {
    const harness = createHarness();
    await expect(collect(harness.manager.stream('missing'))).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });
});

describe('SshTerminalManager — close + audit', () => {
  it('closes the channel/client, finalises the audit and retains the id', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);

    expect(harness.manager.close(id)).toBe(true);
    expect(harness.clients[0].channel.closed).toBe(true);
    expect(harness.clients[0].closed).toBe(true);
    expect(harness.auditEnds).toEqual([{ id: 1, status: 'closed', error: undefined }]);
    // Python retains closed ids so late requests still resolve (then 404 on action).
    expect(harness.manager.getSession(id)).toBe(true);
    // A second close is a no-op.
    expect(harness.manager.close(id)).toBe(false);
    expect(harness.auditEnds).toHaveLength(1);
  });

  it('records an error outcome when the remote channel errored', async () => {
    const harness = createHarness();
    const id = await harness.manager.create(makeHost(), 80, 24);
    harness.clients[0].channel.emitClose(new Error('connection reset'));

    harness.manager.close(id);
    expect(harness.auditEnds).toEqual([
      { id: 1, status: 'error', error: 'connection reset' },
    ]);
  });

  it('reaps idle sessions via the clock', async () => {
    const harness = createHarness({ idleTimeoutMs: 1_000 });
    const first = await harness.manager.create(makeHost(), 80, 24, { username: 'a' });
    const second = await harness.manager.create(makeHost({ name: 'beta' }), 80, 24, {
      username: 'b',
    });
    expect(harness.manager.getSession(first)).toBe(true);
    expect(harness.manager.getSession(second)).toBe(true);

    harness.advance(1_500);
    // Keep the second session active so only the first is reaped.
    harness.clients[1].channel.emitData('still here');
    harness.manager.reapIdle();

    expect(harness.auditEnds).toEqual([{ id: 1, status: 'closed', error: undefined }]);
    expect(harness.clients[0].closed).toBe(true);
    expect(harness.clients[1].closed).toBe(false);
  });
});
