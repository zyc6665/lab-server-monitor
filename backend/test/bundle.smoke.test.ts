import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Regression guard for the packaged layout: the installed bundle lives at
// <install>/resources/backend/main.cjs, with NO package.json beside it. Reading
// package.json at startup used to crash with ENOENT before the server bound a
// port. The version must be injected at build time instead.
describe('packaged layout (no package.json on disk)', () => {
  it('starts from a bare resources/backend/main.cjs and serves /api/system/health', async () => {
    execFileSync('node', ['build.mjs'], { cwd: backendDir, stdio: 'inherit', timeout: 120_000 });

    const root = await mkdtemp(path.join(tmpdir(), 'sm-pkg-'));
    const bundledDir = path.join(root, 'resources', 'backend');
    await mkdir(bundledDir, { recursive: true });
    await copyFile(path.join(backendDir, 'dist', 'main.cjs'), path.join(bundledDir, 'main.cjs'));

    let child: ChildProcess | undefined;
    try {
      child = spawn('node', ['main.cjs', '--port', '0'], {
        cwd: bundledDir,
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
      const body = (await r.json()) as { status: string; version: string };
      expect(body.status).toBe('ok');
      const expectedVersion = JSON.parse(readFileSync(path.join(backendDir, 'package.json'), 'utf8')).version as string;
      expect(body.version).toBe(expectedVersion);
    } finally {
      if (child && !child.killed) {
        child.kill();
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
