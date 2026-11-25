import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// backend/ directory (this test lives in backend/test/).
const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('bundled CLI smoke', () => {
  let child: ChildProcess | undefined;

  // Build the single-file bundle before spawning it.
  beforeAll(() => {
    execFileSync('node', ['build.mjs'], {
      cwd: backendDir,
      stdio: 'inherit',
      timeout: 120_000,
    });
  }, 120_000);

  afterAll(() => {
    if (child && !child.killed) {
      child.kill();
    }
  });

  it('dist/main.cjs --port 0 prints SERVER_URL and serves a healthy /api/system/health', async () => {
    child = spawn('node', ['dist/main.cjs', '--port', '0'], {
      cwd: backendDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(
        () => reject(new Error('timeout waiting for SERVER_URL; output=' + out)),
        20_000,
      );
      child!.stdout!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
        const m = out.match(/SERVER_URL=(http:\/\/\S+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      child!.stderr!.on('data', (chunk: Buffer) => {
        out += chunk.toString();
      });
      child!.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('child exited early code=' + code + '; output=' + out));
      });
    });

    const r = await fetch(url + '/api/system/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: 'ok' });
  }, 30_000);
});
