/**
 * Startup self-checks for the desktop main process (M11 / v0.3.3).
 *
 * `main.ts` calls {@link runStartupChecks} once after `app.whenReady()` and,
 * when it reports failures, shows a single `dialog.showErrorBox`. All heavy
 * lifting is pure logic with injected probes so the checks are unit-testable
 * in plain Node:
 * - {@link checkDataDirWritable} proves the data directory accepts a real
 *   write/delete round-trip (access(2) alone lies on Windows/ACL setups).
 * - {@link checkPortAvailable} probes a TCP port by listening on loopback.
 *   Port 0 ("let the OS pick") is always available.
 * - {@link runStartupChecks} aggregates the above plus a retrying backend
 *   health probe and returns Chinese failure reasons for the dialog.
 *
 * Nothing here shows UI or imports Electron.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';

/** Result of a directory writability probe. */
export interface DataDirCheck {
  ok: boolean;
  /** Chinese reason when `ok === false`. */
  error?: string;
}

/** Input for {@link runStartupChecks} — every dependency is injected. */
export interface StartupCheckInput {
  /** Directory the backend stores its database/runtime files in. */
  dataDir: string;
  /** Backend TCP port to probe; `0` / omitted means "OS-assigned, skip". */
  port?: number;
  /** Backend liveness probe (typically `GET /api/system/health`). */
  health: () => Promise<boolean>;
  /** Logs directory (reported by the caller; also writability-probed). */
  logDir: string;
  /** Health attempts before giving up (default 3, minimum 1). */
  retries?: number;
  /** Delay between health attempts in ms (default 500). */
  delayMs?: number;
}

/** Aggregate result consumed by `main.ts`. */
export interface StartupCheckResult {
  ok: boolean;
  /** Chinese failure reasons, one per line in the error dialog. */
  failures: string[];
}

/** Default number of backend health attempts. */
export const DEFAULT_HEALTH_RETRIES = 3;
/** Default delay between backend health attempts (ms). */
export const DEFAULT_HEALTH_DELAY_MS = 500;

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function probeWritable(dir: string, label: string): DataDirCheck {
  const target = typeof dir === 'string' ? dir.trim() : '';
  if (target === '') {
    return { ok: false, error: `${label}未配置（路径为空）` };
  }
  const probeFile = path.join(
    target,
    `.startup-check-${process.pid}-${Date.now().toString(36)}.tmp`,
  );
  try {
    mkdirSync(target, { recursive: true });
    writeFileSync(probeFile, 'ok', 'utf8');
    rmSync(probeFile, { force: true });
    return { ok: true };
  } catch (error) {
    try {
      rmSync(probeFile, { force: true });
    } catch {
      /* best effort */
    }
    return { ok: false, error: `${label}不可写：${target}（${toMessage(error)}）` };
  }
}

/**
 * Probe `dir` by writing and deleting a temporary file. Missing directories are
 * created (the backend creates them itself, so a missing dir is not a failure).
 * Never throws.
 */
export function checkDataDirWritable(dir: string): DataDirCheck {
  return probeWritable(dir, '数据目录');
}

/**
 * True when `port` can be bound on loopback (i.e. nothing is listening on it).
 *
 * Port 0 (or any non-positive / invalid port) is reported as available: the
 * bundled backend is started with `--port 0` and lets the OS choose, so there is
 * nothing to collide with. Only `EADDRINUSE` means "occupied"; other listen
 * errors (e.g. `EACCES`) are not treated as a port conflict.
 */
export function checkPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(available);
    };
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      try {
        server.close();
      } catch {
        /* not listening */
      }
      settle(error.code !== 'EADDRINUSE');
    });
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      try {
        server.close(() => settle(true));
      } catch {
        settle(true);
      }
    });
  });
}

function normaliseRetries(retries: number | undefined): number {
  if (typeof retries !== 'number' || !Number.isFinite(retries)) {
    return DEFAULT_HEALTH_RETRIES;
  }
  return Math.min(10, Math.max(1, Math.trunc(retries)));
}

function normaliseDelay(delayMs: number | undefined): number {
  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
    return DEFAULT_HEALTH_DELAY_MS;
  }
  return Math.max(0, Math.trunc(delayMs));
}

/**
 * Run every startup check once and collect Chinese failure reasons.
 *
 * Order: data dir → logs dir → port (when a concrete port is supplied) →
 * backend health with retries. All checks run even if an earlier one failed, so
 * the dialog lists everything the user needs to fix.
 */
export async function runStartupChecks(input: StartupCheckInput): Promise<StartupCheckResult> {
  const failures: string[] = [];

  const dataCheck = checkDataDirWritable(input.dataDir);
  if (!dataCheck.ok) {
    failures.push(dataCheck.error ?? `数据目录不可写：${input.dataDir}`);
  }

  const logCheck = probeWritable(input.logDir, '日志目录');
  if (!logCheck.ok) {
    failures.push(logCheck.error ?? `日志目录不可写：${input.logDir}`);
  }

  if (typeof input.port === 'number' && input.port > 0) {
    const available = await checkPortAvailable(input.port);
    if (!available) {
      failures.push(`端口 ${input.port} 已被占用`);
    }
  }

  const retries = normaliseRetries(input.retries);
  const delayMs = normaliseDelay(input.delayMs);
  let healthy = false;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      if (await input.health()) {
        healthy = true;
        break;
      }
    } catch {
      /* a throwing probe is simply an unhealthy attempt */
    }
    if (attempt < retries) {
      await sleep(delayMs);
    }
  }
  if (!healthy) {
    failures.push(`后端健康检查失败（已重试 ${retries} 次）`);
  }

  return { ok: failures.length === 0, failures };
}