/**
 * Pure lifecycle logic for the backend utilityProcess: startup handshake
 * (polling for a runtime info file) and restart backoff. No real timers are
 * used unless the caller omits `now`/`sleep`, so tests stay instant and
 * deterministic. Task 5 wires this to the actual utilityProcess.
 */

export interface RuntimeInfo {
  url: string;
  port: number;
  pid: number;
}

/** Restart backoff ladder (ms), indexed by zero-based attempt number. */
export const RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000, 20000, 30000];

/**
 * Delay before the next restart attempt. Negative attempts are treated as 0;
 * attempts past the end of the ladder are pinned to the final delay.
 */
export function nextRetryDelay(attempt: number): number {
  const idx = Math.min(attempt < 0 ? 0 : attempt, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[idx];
}

/** Thrown by {@link waitForRuntime} when the backend never reports a runtime. */
export class BackendStartupTimeout extends Error {
  constructor(message = 'Backend did not report a runtime before the startup timeout') {
    super(message);
    this.name = 'BackendStartupTimeout';
  }
}

export interface WaitForRuntimeOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll `readRuntime` until it returns a {@link RuntimeInfo}. The first read is
 * always attempted, even when `timeoutMs <= 0`. Between empty reads it awaits
 * `sleep(intervalMs)` and gives up once `now() - start >= timeoutMs`, throwing
 * {@link BackendStartupTimeout}.
 */
export async function waitForRuntime(
  readRuntime: () => RuntimeInfo | null,
  opts: WaitForRuntimeOptions = {},
): Promise<RuntimeInfo> {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const intervalMs = opts.intervalMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;

  const start = now();
  for (;;) {
    const runtime = readRuntime();
    if (runtime !== null) {
      return runtime;
    }
    if (now() - start >= timeoutMs) {
      throw new BackendStartupTimeout(
        `Backend did not report a runtime within ${timeoutMs}ms`,
      );
    }
    await sleep(intervalMs);
  }
}
