/**
 * Tests for `backend/src/runtime/instance.ts` (P4 plan, Task 9).
 *
 * Verifies the port of `servermanage/runtime.py:157-216`:
 * - `findAvailablePort` probes `[preferred, preferred + span)`, skips occupied
 *   ports, honours the default span and throws once the window is exhausted;
 * - `writeRuntimeState` produces the exact Python `write_runtime_state` payload
 *   (`{"url": ..., "port": ..., "pid": ...}`, one line, `ensure_ascii=False`)
 *   and replaces the target atomically without leaving temp files;
 * - `readRuntimeState` returns `null` for missing / malformed / non-object JSON.
 *
 * Ports are held with real `net.createServer()` listeners, mirroring the Python
 * test that binds a socket to occupy a port.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findAvailablePort, readRuntimeState, writeRuntimeState } from '../../src/runtime/instance';

const openServers: Server[] = [];
const tempDirs: string[] = [];

/** Starts a listener on `port` (0 = OS-assigned) and tracks it for cleanup. */
function listenOn(port: number, host = '127.0.0.1'): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer();
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      openServers.push(server);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Closes a server and resolves once it is no longer listening. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

/** Grabs an OS-assigned free port, then releases it. */
async function freePort(): Promise<number> {
  const server = await listenOn(0);
  const { port } = server.address() as AddressInfo;
  await closeServer(server);
  return port;
}

/**
 * Reserves `count` consecutive ports. Retries with a fresh base until a whole
 * block is free, so the "skip several occupied ports" cases stay deterministic.
 */
async function reserveConsecutive(count: number): Promise<{ base: number; servers: Server[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    // Stay below the Windows ephemeral range (49152-65535) to reduce clashes.
    const base = 20000 + Math.floor(Math.random() * 20000);
    const servers: Server[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        servers.push(await listenOn(base + index));
      }
      return { base, servers };
    } catch {
      await Promise.all(servers.map((server) => closeServer(server)));
    }
  }
  throw new Error(`unable to reserve ${count} consecutive ports`);
}

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sm-instance-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0, openServers.length).map((server) => closeServer(server)));
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('findAvailablePort', () => {
  it('returns the preferred port when it is free', async () => {
    const preferred = await freePort();
    await expect(findAvailablePort('127.0.0.1', preferred)).resolves.toBe(preferred);
  });

  it('skips a single occupied port', async () => {
    const occupied = await freePort();
    await listenOn(occupied);

    const found = await findAvailablePort('127.0.0.1', occupied, 10);

    expect(found).toBeGreaterThan(occupied);
    expect(found).toBeLessThanOrEqual(occupied + 9);
  });

  it('skips several consecutive occupied ports', async () => {
    const { base } = await reserveConsecutive(2);

    const found = await findAvailablePort('127.0.0.1', base, 10);

    expect(found).toBeGreaterThanOrEqual(base + 2);
    expect(found).toBeLessThan(base + 10);
  });

  it('probes up to the default span of 20 candidates', async () => {
    const { base } = await reserveConsecutive(5);

    // span omitted -> default 20, so it must look past the five held ports.
    const found = await findAvailablePort('127.0.0.1', base);

    expect(found).toBeGreaterThanOrEqual(base + 5);
    expect(found).toBeLessThanOrEqual(base + 19);
  });

  it('returns a port that can actually be bound afterwards', async () => {
    const occupied = await freePort();
    await listenOn(occupied);

    const found = await findAvailablePort('127.0.0.1', occupied, 10);
    // Binding the returned port must succeed (throws on EADDRINUSE otherwise).
    const probe = await listenOn(found);
    await closeServer(probe);
  });

  it('throws when the only probed port is occupied', async () => {
    const occupied = await freePort();
    await listenOn(occupied);

    await expect(findAvailablePort('127.0.0.1', occupied, 1)).rejects.toThrow(
      `No available port in ${occupied}-${occupied} on '127.0.0.1'`,
    );
  });

  it('throws and reports the exhausted window when every candidate is occupied', async () => {
    const { base } = await reserveConsecutive(3);

    await expect(findAvailablePort('127.0.0.1', base, 3)).rejects.toThrow(
      `No available port in ${base}-${base + 2} on '127.0.0.1'`,
    );
  });
});

describe('writeRuntimeState / readRuntimeState', () => {
  it('round-trips url, port and pid', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');

    writeRuntimeState(file, { url: 'http://127.0.0.1:8765', port: 8765, pid: 4242 });

    expect(readRuntimeState(file)).toEqual({
      url: 'http://127.0.0.1:8765',
      port: 8765,
      pid: 4242,
    });
  });

  it('writes Python-compatible single-line JSON with url/port/pid order', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');

    writeRuntimeState(file, { url: 'http://127.0.0.1:8765', port: 8765, pid: 4242 });

    const raw = await readFile(file, 'utf8');
    expect(raw).toBe('{"url": "http://127.0.0.1:8765", "port": 8765, "pid": 4242}');
    expect(raw).not.toContain('\n');
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual(['url', 'port', 'pid']);
  });

  it('defaults a missing pid to null and keeps the key present', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');

    writeRuntimeState(file, { url: 'http://127.0.0.1:9000', port: 9000 });

    const state = readRuntimeState(file);
    expect(state).not.toBeNull();
    expect(state).toMatchObject({ url: 'http://127.0.0.1:9000', port: 9000, pid: null });
    expect(Object.prototype.hasOwnProperty.call(state, 'pid')).toBe(true);
  });

  it('creates missing parent directories', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'a', 'b', 'runtime.json');

    writeRuntimeState(file, { url: 'http://127.0.0.1:1234', port: 1234, pid: null });

    expect(readRuntimeState(file)).toMatchObject({ port: 1234 });
  });

  it('leaves no temporary files behind after an atomic write', async () => {
    const dir = await makeTempDir();
    writeRuntimeState(path.join(dir, 'runtime.json'), {
      url: 'http://127.0.0.1:8765',
      port: 8765,
      pid: 1,
    });

    const entries = await readdir(dir);
    expect(entries).toContain('runtime.json');
    expect(entries.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('atomically replaces an existing runtime file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');
    await writeFile(file, '{"url":"stale","port":1,"pid":1}', 'utf8');

    writeRuntimeState(file, { url: 'http://127.0.0.1:8765', port: 8765, pid: 4242 });

    expect(readRuntimeState(file)).toEqual({
      url: 'http://127.0.0.1:8765',
      port: 8765,
      pid: 4242,
    });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps non-ASCII characters raw (ensure_ascii=False)', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');

    writeRuntimeState(file, { url: 'http://127.0.0.1:8765/状态', port: 8765, pid: 1 });

    const raw = await readFile(file, 'utf8');
    expect(raw).toContain('状态');
    expect(raw).not.toContain('\\u');
  });
});

describe('readRuntimeState failure modes', () => {
  it('returns null for a missing file', async () => {
    const dir = await makeTempDir();
    expect(readRuntimeState(path.join(dir, 'does-not-exist.json'))).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'broken.json');
    await writeFile(file, '{not valid json', 'utf8');

    expect(readRuntimeState(file)).toBeNull();
  });

  it('returns null for an empty file', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'empty.json');
    await writeFile(file, '', 'utf8');

    expect(readRuntimeState(file)).toBeNull();
  });

  it('returns null when the document is not a JSON object', async () => {
    const dir = await makeTempDir();

    const arrayFile = path.join(dir, 'array.json');
    await writeFile(arrayFile, '[1,2,3]', 'utf8');
    expect(readRuntimeState(arrayFile)).toBeNull();

    const scalarFile = path.join(dir, 'scalar.json');
    await writeFile(scalarFile, '"hello"', 'utf8');
    expect(readRuntimeState(scalarFile)).toBeNull();

    const nullFile = path.join(dir, 'null.json');
    await writeFile(nullFile, 'null', 'utf8');
    expect(readRuntimeState(nullFile)).toBeNull();
  });

  it('returns unknown extra keys verbatim', async () => {
    const dir = await makeTempDir();
    const file = path.join(dir, 'runtime.json');
    await writeFile(file, '{"url":"u","port":1,"pid":2,"extra":"kept"}', 'utf8');

    expect(readRuntimeState(file)).toEqual({ url: 'u', port: 1, pid: 2, extra: 'kept' });
  });
});
