import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startServer } from '../src/server';

describe('runtime handshake file', () => {
  it('writes {url,port,pid} after listen and removes it on close', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sm-runtime-'));
    const runtimePath = path.join(dir, 'nested', 'runtime.json');
    const s = await startServer({ port: 0, runtimePath });
    try {
      const raw = await readFile(runtimePath, 'utf8');
      const info = JSON.parse(raw) as { url: string; port: number; pid: number };
      expect(info.url).toBe(s.url);
      expect(info.port).toBe(s.port);
      expect(info.pid).toBe(process.pid);
    } finally {
      await s.close();
    }
    await expect(stat(runtimePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(dir, { recursive: true, force: true });
  });
});
