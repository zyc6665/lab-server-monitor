import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  DEFAULT_HEALTH_RETRIES,
  checkDataDirWritable,
  checkPortAvailable,
  runStartupChecks,
} from '../src/main/startup-check';

let dir = '';
const openServers = new Set<Server>();

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sm-startup-check-'));
});

afterEach(async () => {
  await closeServers();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function closeServers(): Promise<void> {
  for (const server of openServers) {
    await closeServer(server);
  }
  openServers.clear();
}

/** Listen on 127.0.0.1:0 and report the assigned port (server stays open). */
function listenEphemeral(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('no TCP address assigned'));
        return;
      }
      openServers.add(server);
      resolve({ server, port: address.port });
    });
  });
}

/** Reserve a port, then free it — the address is very likely still unused. */
async function freePort(): Promise<number> {
  const { server, port } = await listenEphemeral();
  openServers.delete(server);
  await closeServer(server);
  return port;
}

describe('checkDataDirWritable', () => {
  it('accepts an existing writable directory', () => {
    expect(checkDataDirWritable(dir)).toEqual({ ok: true });
  });

  it('creates a missing directory (backend does the same) and then writes', () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    expect(checkDataDirWritable(nested).ok).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it('reports a Chinese reason when the path is not a directory', () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'file, not a directory', 'utf8');

    const result = checkDataDirWritable(path.join(blocker, 'child'));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('数据目录不可写');
    expect(result.error).toContain('child');
  });

  it('rejects an empty path without throwing', () => {
    const result = checkDataDirWritable('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('未配置');
  });

  it('does not leave its probe file behind', () => {
    expect(checkDataDirWritable(dir).ok).toBe(true);
    const leftovers = readdirSync(dir).filter((name) => name.startsWith('.startup-check-'));
    expect(leftovers).toEqual([]);
  });
});

describe('checkPortAvailable', () => {
  it('treats port 0 and invalid ports as available (OS-assigned)', async () => {
    expect(await checkPortAvailable(0)).toBe(true);
    expect(await checkPortAvailable(-1)).toBe(true);
    expect(await checkPortAvailable(Number.NaN)).toBe(true);
    expect(await checkPortAvailable(1.5)).toBe(true);
    expect(await checkPortAvailable(70000)).toBe(true);
  });

  it('detects a free port', async () => {
    const port = await freePort();
    expect(await checkPortAvailable(port)).toBe(true);
  });

  it('detects an occupied port and releases it afterwards', async () => {
    const { server, port } = await listenEphemeral();

    expect(await checkPortAvailable(port)).toBe(false);

    await closeServer(server);
    openServers.delete(server);
    expect(await checkPortAvailable(port)).toBe(true);
  });
});

describe('runStartupChecks', () => {
  const baseInput = () => ({
    dataDir: dir,
    logDir: path.join(dir, 'logs'),
    delayMs: 0,
  });

  it('reports ok when the data dir, logs dir and backend are healthy', async () => {
    const health = vi.fn(async () => true);

    const result = await runStartupChecks({ ...baseInput(), health });

    expect(result).toEqual({ ok: true, failures: [] });
    expect(health).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dir, 'logs'))).toBe(true);
  });

  it('treats port 0 as "OS-assigned" and does not flag it', async () => {
    const health = vi.fn(async () => true);
    const result = await runStartupChecks({ ...baseInput(), port: 0, health });
    expect(result.ok).toBe(true);
  });

  it('fails after exactly 3 health attempts by default', async () => {
    const health = vi.fn(async () => false);

    const result = await runStartupChecks({ ...baseInput(), health });

    expect(result.ok).toBe(false);
    expect(health).toHaveBeenCalledTimes(DEFAULT_HEALTH_RETRIES);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('后端健康检查失败');
    expect(result.failures[0]).toContain('已重试 3 次');
  });

  it('counts a throwing health probe as an unhealthy attempt', async () => {
    const health = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const result = await runStartupChecks({ ...baseInput(), retries: 3, health });

    expect(result.ok).toBe(false);
    expect(health).toHaveBeenCalledTimes(3);
    expect(result.failures.join('\n')).toContain('已重试 3 次');
  });

  it('stops retrying as soon as the backend answers', async () => {
    let calls = 0;
    const health = vi.fn(async () => {
      calls += 1;
      return calls >= 3;
    });

    const result = await runStartupChecks({ ...baseInput(), retries: 3, health });

    expect(result).toEqual({ ok: true, failures: [] });
    expect(health).toHaveBeenCalledTimes(3);
  });

  it('honours a custom retry count', async () => {
    const health = vi.fn(async () => false);

    const result = await runStartupChecks({ ...baseInput(), retries: 2, health });

    expect(health).toHaveBeenCalledTimes(2);
    expect(result.failures[0]).toContain('已重试 2 次');
  });

  it('reports an occupied port with a Chinese reason', async () => {
    const { port } = await listenEphemeral();
    const health = vi.fn(async () => true);

    const result = await runStartupChecks({ ...baseInput(), port, health });

    expect(result.ok).toBe(false);
    expect(result.failures).toContain(`端口 ${port} 已被占用`);
  });

  it('reports an unusable data dir while still checking the backend', async () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'file, not a directory', 'utf8');
    const health = vi.fn(async () => true);

    const result = await runStartupChecks({
      dataDir: path.join(blocker, 'child'),
      logDir: path.join(dir, 'logs'),
      health,
      retries: 1,
      delayMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.failures[0]).toContain('数据目录不可写');
    expect(health).toHaveBeenCalledTimes(1);
  });

  it('collects every failure instead of stopping at the first', async () => {
    const blocker = path.join(dir, 'blocker');
    writeFileSync(blocker, 'file, not a directory', 'utf8');
    const { port } = await listenEphemeral();
    const health = vi.fn(async () => false);

    const result = await runStartupChecks({
      dataDir: path.join(blocker, 'child'),
      logDir: path.join(dir, 'logs'),
      port,
      health,
      retries: 1,
      delayMs: 0,
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(3);
    expect(result.failures[0]).toContain('数据目录不可写');
    expect(result.failures[1]).toContain('端口');
    expect(result.failures[2]).toContain('后端健康检查失败');
  });
});