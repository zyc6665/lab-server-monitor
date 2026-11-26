/**
 * Dashboard admin password hashing.
 *
 * Byte-for-byte compatible with the Python oracle
 * `servermanage/security.py::hash_password` /
 * `verify_password`:
 *
 *   salt = os.urandom(16)
 *   digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
 *   return digest.hex(), salt.hex()
 *
 * The stored JSON document (see `servermanage/settings/admin.py` and the
 * `SECRET_ADMIN` blob) is `{username, hash, salt, iterations}` — a hex-encoded
 * SHA-256 PBKDF2 digest and a hex-encoded 16-byte salt, exactly as produced
 * here. A credential hashed by this module therefore verifies on the Python
 * side and a Python-generated hash verifies here.
 *
 * `crypto.pbkdf2` uses the SHA-256 digest size (32 bytes) as the derived-key
 * length when none is given in Python, so we pass `keylen = 32` explicitly.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/** PBKDF2 iteration count (matches `DashboardAuthConfig.password_iterations`). */
export const PBKDF2_ITERATIONS = 200000;

/** Random salt length in bytes (`os.urandom(16)`). */
export const SALT_BYTES = 16;

/** HMAC digest used by the KDF (`hashlib.pbkdf2_hmac("sha256", ...)`). */
export const PBKDF2_DIGEST = 'sha256';

/** Derived-key length for SHA-256 (Python's `digest_size` = 32 bytes). */
export const PBKDF2_KEY_BYTES = 32;

/**
 * Identifier recorded next to a hash. Python does not persist an algorithm
 * field (its storage is `{hash, salt, iterations, username}`), so this only
 * documents the KDF for Node-side consumers.
 */
export const PBKDF2_ALGORITHM = 'PBKDF2-SHA256';

/** A freshly derived password record, as returned by {@link hashPassword}. */
export interface PasswordHash {
  /** Hex-encoded PBKDF2-HMAC-SHA256 digest. */
  hash: string;
  /** Hex-encoded random salt. */
  salt: string;
  /** Iteration count used to derive {@link hash}. */
  iterations: number;
  /** KDF identifier (see {@link PBKDF2_ALGORITHM}). */
  algorithm: string;
}

/**
 * A stored credential. Matches the Python JSON document; `username` and any
 * other keys are tolerated so a blob produced by Python round-trips here.
 */
export interface StoredPassword {
  hash: string;
  salt: string;
  iterations: number;
  username?: string;
  [extra: string]: unknown;
}

/** Options for {@link hashPassword} (mostly for deterministic tests). */
export interface HashPasswordOptions {
  /** Override the iteration count (defaults to {@link PBKDF2_ITERATIONS}). */
  iterations?: number;
  /** Fixed salt, for fixtures; defaults to {@link SALT_BYTES} random bytes. */
  salt?: Buffer;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** True for an even-length hex string (what `bytes.fromhex` accepts, minus spaces). */
function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(value);
}

/**
 * Derive a PBKDF2-HMAC-SHA256 password hash.
 *
 * @param plain cleartext password (UTF-8 encoded, like `str.encode("utf-8")`)
 * @param options optional iteration/salt overrides
 * @returns `{hash, salt, iterations, algorithm}` with hex-encoded hash+salt
 * @throws {TypeError} when `plain` is not a string (mirrors the oracle)
 */
export function hashPassword(plain: string, options: HashPasswordOptions = {}): PasswordHash {
  if (typeof plain !== 'string') {
    throw new TypeError('password must be a string');
  }
  const iterations = options.iterations ?? PBKDF2_ITERATIONS;
  if (!isPositiveInteger(iterations)) {
    throw new RangeError('iterations must be a positive integer');
  }
  const salt = options.salt ?? randomBytes(SALT_BYTES);
  if (!Buffer.isBuffer(salt) || salt.length === 0) {
    throw new TypeError('salt must be a non-empty Buffer');
  }
  const digest = pbkdf2Sync(plain, salt, iterations, PBKDF2_KEY_BYTES, PBKDF2_DIGEST);
  return {
    hash: digest.toString('hex'),
    salt: salt.toString('hex'),
    iterations,
    algorithm: PBKDF2_ALGORITHM,
  };
}

/**
 * Constant-time check of `plain` against a stored `{hash, salt, iterations}`.
 *
 * Mirrors `security.verify_password`: malformed hex, a non-string
 * password, an invalid iteration count, or a bad KDF all yield `false` instead
 * of throwing. The digest length is compared before {@link timingSafeEqual}
 * (which throws on mismatched lengths) so an oddly-sized stored hash fails
 * cleanly, exactly as `hmac.compare_digest` returns `False`.
 */
export function verifyPassword(plain: string, stored: StoredPassword | null | undefined): boolean {
  if (typeof plain !== 'string') {
    return false;
  }
  if (stored === null || typeof stored !== 'object') {
    return false;
  }
  const { hash, salt, iterations } = stored;
  if (!isHex(hash) || !isHex(salt)) {
    return false;
  }
  const parsed = typeof iterations === 'number' ? iterations : Number.NaN;
  if (!isPositiveInteger(parsed)) {
    return false;
  }
  const saltBuf = Buffer.from(salt, 'hex');
  const expected = Buffer.from(hash, 'hex');
  let actual: Buffer;
  try {
    actual = pbkdf2Sync(plain, saltBuf, parsed, PBKDF2_KEY_BYTES, PBKDF2_DIGEST);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
