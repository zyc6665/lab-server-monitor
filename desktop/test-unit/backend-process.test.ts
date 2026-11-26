import { describe, it, expect } from 'vitest';
import {
  waitForRuntime,
  nextRetryDelay,
  BackendStartupTimeout,
  RETRY_DELAYS_MS,
} from '../src/main/backend-process';

describe('nextRetryDelay', () => {
  it('attempt 0 -> 2000', () => expect(nextRetryDelay(0)).toBe(2000));
  it('attempt 2 -> 10000', () => expect(nextRetryDelay(2)).toBe(10000));
  it('attempt 4 -> 30000', () => expect(nextRetryDelay(4)).toBe(30000));
  it('attempt 9 (out of range) -> 30000', () => expect(nextRetryDelay(9)).toBe(30000));
  it('attempt -1 (clamped to 0) -> 2000', () => expect(nextRetryDelay(-1)).toBe(2000));
  it('RETRY_DELAYS_MS is the documented ladder', () =>
    expect(RETRY_DELAYS_MS).toEqual([2000, 5000, 10000, 20000, 30000]));
});

describe('BackendStartupTimeout', () => {
  it('has name BackendStartupTimeout and extends Error', () => {
    const err = new BackendStartupTimeout('boom');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BackendStartupTimeout');
  });
});

describe('waitForRuntime', () => {
  it('rejects with BackendStartupTimeout when runtime never appears', async () => {
    let t = 0;
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    let caught: unknown;
    try {
      await waitForRuntime(() => null, { timeoutMs: 50, intervalMs: 10, now, sleep });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BackendStartupTimeout);
    expect((caught as Error).name).toBe('BackendStartupTimeout');
  });

  it('resolves with the RuntimeInfo returned on the 2nd read', async () => {
    const info = { url: 'http://127.0.0.1:4321', port: 4321, pid: 1234 };
    let calls = 0;
    let t = 0;
    const readRuntime = () => {
      calls += 1;
      return calls === 2 ? info : null;
    };
    const now = () => t;
    const sleep = async (ms: number) => {
      t += ms;
    };
    await expect(
      waitForRuntime(readRuntime, { timeoutMs: 1000, intervalMs: 10, now, sleep }),
    ).resolves.toEqual(info);
    expect(calls).toBe(2);
  });

  it('attempts one read even when timeoutMs <= 0', async () => {
    const info = { url: 'http://127.0.0.1:1', port: 1, pid: 1 };
    await expect(
      waitForRuntime(() => info, { timeoutMs: 0, intervalMs: 10, now: () => 0, sleep: async () => {} }),
    ).resolves.toEqual(info);
  });

  it('sleeps at intervalMs between empty reads', async () => {
    const slept: number[] = [];
    let t = 0;
    let calls = 0;
    const info = { url: 'http://x', port: 9, pid: 9 };
    const readRuntime = () => {
      calls += 1;
      return calls === 3 ? info : null;
    };
    const now = () => t;
    const sleep = async (ms: number) => {
      slept.push(ms);
      t += ms;
    };
    await waitForRuntime(readRuntime, { timeoutMs: 1000, intervalMs: 25, now, sleep });
    expect(slept).toEqual([25, 25]);
  });
});
