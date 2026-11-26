/**
 * Unit tests for the per-IP login throttle and client-address resolver.
 *
 * Time is driven by an injected clock so the 60s window is exercised without
 * sleeping. Semantics mirror `servermanage/web/routes/auth.py`.
 */
import { describe, expect, it } from 'vitest';

import {
  LOGIN_FAILURE_LIMIT,
  LOGIN_FAILURE_MAX_ENTRIES,
  LOGIN_FAILURE_WINDOW_SECONDS,
  LoginRateLimiter,
  clientIp,
  isLoopback,
} from '../../../src/web/security/ratelimit';

describe('constants', () => {
  it('match the Python oracle', () => {
    expect(LOGIN_FAILURE_LIMIT).toBe(5);
    expect(LOGIN_FAILURE_WINDOW_SECONDS).toBe(60);
    expect(LOGIN_FAILURE_MAX_ENTRIES).toBe(4096);
  });
});

describe('LoginRateLimiter', () => {
  function make(maxEntries?: number) {
    let now = 1_000_000;
    const limiter = new LoginRateLimiter({
      maxEntries,
      now: () => now,
    });
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('allows up to 5 failures then blocks the 6th attempt', () => {
    const { limiter } = make();
    for (let i = 0; i < 4; i += 1) {
      limiter.recordFailure('1.2.3.4');
    }
    expect(limiter.count('1.2.3.4')).toBe(4);
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    limiter.recordFailure('1.2.3.4');
    expect(limiter.count('1.2.3.4')).toBe(5);
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
  });

  it('tracks addresses independently', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure('1.1.1.1');
    }
    expect(limiter.isLimited('1.1.1.1')).toBe(true);
    expect(limiter.isLimited('2.2.2.2')).toBe(false);
  });

  it('expires failures after the rolling window', () => {
    const { limiter, advance } = make();
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure('1.2.3.4');
    }
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    advance(60_000);
    // `now - failures[0] == window` is NOT strictly greater, so still counted.
    expect(limiter.count('1.2.3.4')).toBe(5);
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    advance(1);
    expect(limiter.count('1.2.3.4')).toBe(0);
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
  });

  it('clears the bucket after a successful login', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i += 1) {
      limiter.recordFailure('1.2.3.4');
    }
    expect(limiter.isLimited('1.2.3.4')).toBe(true);
    limiter.clear('1.2.3.4');
    expect(limiter.isLimited('1.2.3.4')).toBe(false);
    expect(limiter.count('1.2.3.4')).toBe(0);
  });

  it('caps the tracked-address table and evicts the oldest', () => {
    const { limiter, advance } = make(3);
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      limiter.recordFailure(ip);
      advance(1);
    }
    expect(limiter.size).toBe(3);
    expect(limiter.count('10.0.0.1')).toBe(0); // least-recently failed, evicted
    expect(limiter.count('10.0.0.2')).toBe(1);
    expect(limiter.count('10.0.0.4')).toBe(1);
  });

  it('drops fully expired buckets while pruning', () => {
    const { limiter, advance } = make();
    limiter.recordFailure('9.9.9.9');
    expect(limiter.size).toBe(1);
    advance(61_000);
    limiter.recordFailure('8.8.8.8');
    expect(limiter.size).toBe(1);
    expect(limiter.count('8.8.8.8')).toBe(1);
  });
});

describe('isLoopback', () => {
  it('recognises the oracle loopback set', () => {
    for (const ip of ['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']) {
      expect(isLoopback(ip)).toBe(true);
    }
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback(null)).toBe(false);
  });
});

describe('clientIp', () => {
  it('trusts X-Forwarded-For only from a loopback socket', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      }),
    ).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For from a remote socket', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '203.0.113.9' },
        socket: { remoteAddress: '198.51.100.7' },
      }),
    ).toBe('198.51.100.7');
  });

  it('falls back to the socket when no header is present', () => {
    expect(
      clientIp({
        headers: {},
        socket: { remoteAddress: '::1' },
      }),
    ).toBe('::1');
  });

  it('ignores an empty first hop', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '  , 10.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
      }),
    ).toBe('127.0.0.1');
  });

  it('honours a custom trusted-proxy set', () => {
    expect(
      clientIp(
        {
          headers: { 'x-forwarded-for': '203.0.113.9' },
          socket: { remoteAddress: '10.0.0.5' },
        },
        { trustedProxies: ['10.0.0.5'] },
      ),
    ).toBe('203.0.113.9');
  });

  it('handles array-valued forwarded headers', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': ['203.0.113.9', '10.0.0.1'] },
        socket: { remoteAddress: '127.0.0.1' },
      }),
    ).toBe('203.0.113.9');
  });
});
