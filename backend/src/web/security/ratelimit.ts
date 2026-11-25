/**
 * Per-IP login-failure throttle and client-address resolver.
 *
 * Mirrors `servermanage/web/routes/auth.py` and the shared constants in
 * `servermanage/web/routes/_core.py`:
 *
 *   - `_LOGIN_FAILURE_LIMIT = 5`, `_LOGIN_FAILURE_WINDOW_SECONDS = 60`
 *   - a rolling 60s window tolerates 5 failures; when the bucket already holds
 *     the limit, the next (6th) attempt from that address is rejected
 *     (`len(failures) >= limit`)
 *   - a successful login clears the address' bucket
 *   - `_prune_failure_map` caps the map at 4096 entries, evicting the least
 *     recently failing address on overflow
 *
 * Time is injected so tests never sleep; the default is wall-clock `Date.now`.
 */
import type { IncomingHttpHeaders } from 'node:http';

/** Failures tolerated per address inside the window (`_LOGIN_FAILURE_LIMIT`). */
export const LOGIN_FAILURE_LIMIT = 5;

/** Rolling window length in seconds (`_LOGIN_FAILURE_WINDOW_SECONDS`). */
export const LOGIN_FAILURE_WINDOW_SECONDS = 60;

/** Hard upper bound on tracked addresses (`_LOGIN_FAILURE_MAX_ENTRIES`). */
export const LOGIN_FAILURE_MAX_ENTRIES = 4096;

/** Addresses treated as loopback / a co-located reverse proxy (`_LOOPBACK_ADDRESSES`). */
export const LOOPBACK_ADDRESSES: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '::1',
  'localhost',
  '::ffff:127.0.0.1',
]);

/** Options for {@link LoginRateLimiter}. */
export interface LoginRateLimiterOptions {
  /** Max failures per address inside the window (default {@link LOGIN_FAILURE_LIMIT}). */
  limit?: number;
  /** Window length in milliseconds (default 60s). */
  windowMs?: number;
  /** Map capacity (default {@link LOGIN_FAILURE_MAX_ENTRIES}). */
  maxEntries?: number;
  /** Monotonic clock in milliseconds (default `Date.now`). */
  now?: () => number;
}

/**
 * Tracks failed login attempts per client address in a rolling window.
 *
 * Not thread-safe in the JS sense — Node runs handlers on one thread, so the
 * Python oracle's `threading.Lock` has no analogue here; a map is sufficient.
 */
export class LoginRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Ascending timestamps (ms) of failures inside the current window. */
  private readonly buckets = new Map<string, number[]>();

  constructor(options: LoginRateLimiterOptions = {}) {
    this.limit = options.limit ?? LOGIN_FAILURE_LIMIT;
    this.windowMs = options.windowMs ?? LOGIN_FAILURE_WINDOW_SECONDS * 1000;
    this.maxEntries = options.maxEntries ?? LOGIN_FAILURE_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
  }

  private pruneBucket(bucket: number[], now: number): void {
    while (bucket.length > 0 && now - bucket[0] > this.windowMs) {
      bucket.shift();
    }
  }

  private pruneMap(now: number): void {
    for (const [key, bucket] of this.buckets) {
      this.pruneBucket(bucket, now);
      if (bucket.length === 0) {
        this.buckets.delete(key);
      }
    }
    const overflow = this.buckets.size - this.maxEntries;
    if (overflow > 0) {
      const ordered = [...this.buckets.entries()].sort(
        (a, b) => a[1][a[1].length - 1] - b[1][b[1].length - 1],
      );
      for (let i = 0; i < overflow; i += 1) {
        this.buckets.delete(ordered[i][0]);
      }
    }
  }

  /** Whether `ip` has already reached the failure limit inside the window. */
  isLimited(ip: string): boolean {
    const now = this.now();
    const bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      return false;
    }
    this.pruneBucket(bucket, now);
    if (bucket.length === 0) {
      this.buckets.delete(ip);
      return false;
    }
    return bucket.length >= this.limit;
  }

  /** Record one failed attempt for `ip` (prunes the window and map). */
  recordFailure(ip: string): void {
    const now = this.now();
    let bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(ip, bucket);
    }
    this.pruneBucket(bucket, now);
    bucket.push(now);
    this.pruneMap(now);
  }

  /** Clear `ip`'s failures after a successful login. */
  clear(ip: string): void {
    this.buckets.delete(ip);
  }

  /** Number of tracked addresses (observability / tests). */
  get size(): number {
    return this.buckets.size;
  }

  /** In-window failure count for `ip` (0 when absent or fully expired). */
  count(ip: string): number {
    const now = this.now();
    const bucket = this.buckets.get(ip);
    if (bucket === undefined) {
      return 0;
    }
    this.pruneBucket(bucket, now);
    if (bucket.length === 0) {
      this.buckets.delete(ip);
      return 0;
    }
    return bucket.length;
  }
}

/** True when `address` is one of {@link LOOPBACK_ADDRESSES}. */
export function isLoopback(address: string | null | undefined): boolean {
  return LOOPBACK_ADDRESSES.has(address ?? '');
}

/** Minimal Express-request shape needed by {@link clientIp} (structurally `express.Request`). */
export interface ClientIpRequest {
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string | null } | null;
  /** Direct socket address override (tests / non-Express callers). */
  remoteAddr?: string | null;
}

/** Options for {@link clientIp}. */
export interface ClientIpOptions {
  /**
   * Addresses allowed to set `X-Forwarded-For`. Defaults to the loopback set,
   * matching the oracle: the header is trusted only when the direct socket is
   * loopback (a co-located reverse proxy).
   */
  trustedProxies?: Iterable<string>;
}

function firstForwardedFor(value: IncomingHttpHeaders['x-forwarded-for']): string {
  if (value === undefined) {
    return '';
  }
  const raw = Array.isArray(value) ? value.join(',') : value;
  return raw.split(',', 1)[0].trim();
}

/**
 * Best-effort client address used to key the login throttle.
 *
 * Behind a local reverse proxy the direct socket is loopback and the first hop
 * of `X-Forwarded-For` carries the real client; only then is the header
 * honoured, so a remote client cannot spoof its way out of the throttle.
 */
export function clientIp(req: ClientIpRequest, options: ClientIpOptions = {}): string {
  const remote = req.remoteAddr ?? req.socket?.remoteAddress ?? '';
  const trusted = options.trustedProxies !== undefined
    ? new Set(options.trustedProxies)
    : LOOPBACK_ADDRESSES;
  if (trusted.has(remote)) {
    const first = firstForwardedFor(req.headers['x-forwarded-for']);
    if (first) {
      return first;
    }
  }
  return remote;
}
