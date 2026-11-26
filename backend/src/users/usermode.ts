/**
 * Helpers for the admin / member (user) viewing modes.
 *
 * The mode decides which surfaces the client exposes.  It is a usability
 * boundary for lab members, not a security boundary: SSH credentials still live
 * on the local machine and the real limits stay on the servers.
 *
 * 1:1 port of `servermanage/usermode.py` (51 lines): same constants, same
 * regex, same default handling and the exact same error messages.
 */

export const MODE_ADMIN = 'admin';
export const MODE_USER = 'user';
export const MODES = [MODE_ADMIN, MODE_USER] as const;

export type Mode = (typeof MODES)[number];

const MEMBER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Raised when a mode or member account value is not acceptable. */
export class ModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeError';
  }
}

export interface NormalizeModeOptions {
  /** Fallback used for `None` / empty input (default `admin`). */
  default?: string;
}

/**
 * Render an arbitrary value the way Python's `str()` would for the scalar types
 * that can realistically reach here, so error text is byte-identical to the
 * oracle (`True` / `False`, not `true` / `false`).
 */
function pyStr(value: unknown): string {
  if (value === true) {
    return 'True';
  }
  if (value === false) {
    return 'False';
  }
  return String(value);
}

/**
 * Return `admin` or `user`; empty/`None` falls back to `default`.
 *
 * Mirrors `normalize_mode`: unknown, non-empty values raise `ModeError` with the
 * raw (untrimmed, original-case) value in the message.
 */
export function normalizeMode(value: unknown, opts: NormalizeModeOptions = {}): string {
  const fallback = opts.default ?? MODE_ADMIN;
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  const text = pyStr(value).trim().toLowerCase();
  if ((MODES as readonly string[]).includes(text)) {
    return text;
  }
  throw new ModeError(`未知使用模式: ${pyStr(value)}（只支持 admin / user）`);
}

/**
 * Return a validated Linux account name, or `''` when unset.
 *
 * Mirrors `normalize_member_account`: `None` / blank becomes `''`; otherwise the
 * value is stringified, trimmed, lowercased and must match the account regex.
 */
export function normalizeMemberAccount(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = pyStr(value).trim().toLowerCase();
  if (!text) {
    return '';
  }
  if (!MEMBER_PATTERN.test(text)) {
    throw new ModeError('账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头');
  }
  return text;
}

/**
 * Validate a mode/member pair and return the normalized values.
 *
 * Mirrors `validate_mode`: a `user` mode without an account name is rejected.
 */
export function validateMode(mode: string, memberAccount: string): [string, string] {
  const normalizedMode = normalizeMode(mode);
  const normalizedMember = normalizeMemberAccount(memberAccount);
  if (normalizedMode === MODE_USER && !normalizedMember) {
    throw new ModeError('用户模式需要填写自己的服务器账号名');
  }
  return [normalizedMode, normalizedMember];
}
