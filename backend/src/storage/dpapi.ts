/**
 * Windows DPAPI wrapper for {@link protect} / {@link unprotect}, mirroring
 * `servermanage/security.py::protect_secret` / `unprotect_secret`.
 *
 * The Python oracle calls `CryptProtectData` / `CryptUnprotectData` with:
 * - **current-user scope** (no `CRYPTPROTECT_LOCAL_MACHINE`),
 * - **no optional entropy**,
 * - `CRYPTPROTECT_UI_FORBIDDEN`.
 *
 * `@primno/dpapi` is a pre-built N-API binding (ships x64/arm64 `.node`
 * binaries, no MSVC toolchain needed) that calls the same APIs with the same
 * scope, so blobs are interchangeable with the Python process in both
 * directions.
 */
import { Dpapi, isPlatformSupported } from '@primno/dpapi';

/** Thrown when DPAPI is not available (e.g. running on non-Windows). */
export class DpapiUnavailableError extends Error {
  constructor(message = 'Windows DPAPI is not available on this platform') {
    super(message);
    this.name = 'DpapiUnavailableError';
  }
}

/** Matches `security.dpapi_available()`: true only where DPAPI can run. */
export function dpapiAvailable(): boolean {
  return isPlatformSupported;
}

function requireDpapi(): void {
  if (!isPlatformSupported) {
    throw new DpapiUnavailableError();
  }
}

/**
 * A zero-length view over a real 1-byte backing store.
 *
 * `CryptProtectData` rejects a NULL `pbData` even when `cbData == 0`
 * (`ERROR_INVALID_PARAMETER`, code 87). The Python oracle works around this in
 * `_make_in_blob` by passing a valid 1-byte buffer with `cbData = 0`; giving
 * the addon a zero-length typed-array *view* over allocated memory reproduces
 * that: the length is 0 but the data pointer is non-NULL, so empty secrets
 * protect/unprotect exactly like Python's.
 */
const EMPTY_BACKING = new ArrayBuffer(1);

function asDpapiInput(data: Buffer): Uint8Array {
  if (data.length === 0) {
    return new Uint8Array(EMPTY_BACKING, 0, 0);
  }
  return data;
}

/**
 * Encrypts `plain` with the current Windows user's DPAPI key and returns the
 * opaque ciphertext blob. Matches `security.protect_secret`.
 */
export function protect(plain: Buffer): Buffer {
  requireDpapi();
  const encrypted = Dpapi.protectData(asDpapiInput(plain), null, 'CurrentUser');
  return Buffer.from(encrypted);
}

/**
 * Decrypts a blob produced by {@link protect} (or by Python's
 * `protect_secret`) for the current Windows user. Matches
 * `security.unprotect_secret`.
 */
export function unprotect(blob: Buffer): Buffer {
  requireDpapi();
  const decrypted = Dpapi.unprotectData(asDpapiInput(blob), null, 'CurrentUser');
  return Buffer.from(decrypted);
}
