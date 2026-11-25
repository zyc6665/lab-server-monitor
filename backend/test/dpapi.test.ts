import { describe, it, expect } from 'vitest';

import { dpapiAvailable, protect, unprotect, DpapiUnavailableError } from '../src/storage/dpapi';

// DPAPI only exists on Windows. `@primno/dpapi` ships prebuilt N-API binaries,
// so on this Windows machine the round-trip MUST pass; the suite is skipped
// (and documented) only on genuinely unsupported platforms so the cross-platform
// CI matrix stays green.
const supported = dpapiAvailable();

describe('dpapi', () => {
  it('reports platform availability as a boolean', () => {
    expect(typeof dpapiAvailable()).toBe('boolean');
  });

  it.skipIf(!supported)('round-trips plaintext through protect/unprotect', () => {
    const plain = Buffer.from('top-secret', 'utf8');
    const blob = protect(plain);

    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(blob.length).toBeGreaterThan(0);
    // Ciphertext must not equal the plaintext.
    expect(Buffer.compare(blob, plain)).not.toBe(0);
    expect(Buffer.compare(unprotect(blob), plain)).toBe(0);
  });

  it.skipIf(!supported)('round-trips non-ASCII and binary payloads', () => {
    const payloads = [
      Buffer.from('管理员密码 / unicode ✓', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
      Buffer.alloc(0),
    ];

    for (const payload of payloads) {
      const blob = protect(payload);
      expect(Buffer.compare(unprotect(blob), payload)).toBe(0);
    }
  });

  it.skipIf(!supported)('produces a fresh ciphertext each time (random IV)', () => {
    const plain = Buffer.from('same input');
    const first = protect(plain);
    const second = protect(plain);

    expect(Buffer.compare(first, second)).not.toBe(0);
    expect(Buffer.compare(unprotect(first), unprotect(second))).toBe(0);
  });

  it.skipIf(!supported)('throws when asked to unprotect garbage', () => {
    expect(() => unprotect(Buffer.from('not-a-dpapi-blob'))).toThrow();
  });
});

// When DPAPI is unavailable, verify that the wrapper fails loudly instead of
// silently returning wrong data.
describe.skipIf(supported)('dpapi unavailable', () => {
  it('throws DpapiUnavailableError', () => {
    expect(() => protect(Buffer.from('x'))).toThrow(DpapiUnavailableError);
  });
});
