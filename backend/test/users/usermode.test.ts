import { describe, it, expect } from 'vitest';

import {
  MODE_ADMIN,
  MODE_USER,
  MODES,
  ModeError,
  normalizeMode,
  normalizeMemberAccount,
  validateMode,
} from '../../src/users/usermode';

describe('constants', () => {
  it('exposes admin/user modes like the Python oracle', () => {
    expect(MODE_ADMIN).toBe('admin');
    expect(MODE_USER).toBe('user');
    expect(MODES).toEqual(['admin', 'user']);
  });
});

describe('normalizeMode', () => {
  it('defaults to admin when value is undefined', () => {
    expect(normalizeMode(undefined)).toBe('admin');
  });

  it('defaults to admin for null and empty string', () => {
    expect(normalizeMode(null)).toBe('admin');
    expect(normalizeMode('')).toBe('admin');
  });

  it('honours a custom default for empty / null input', () => {
    expect(normalizeMode('', { default: 'user' })).toBe('user');
    expect(normalizeMode(null, { default: MODE_USER })).toBe('user');
  });

  it('trims and lowercases known modes', () => {
    expect(normalizeMode('  ADMIN ')).toBe('admin');
    expect(normalizeMode('User')).toBe('user');
  });

  it('rejects an unknown mode with the verbatim Python message', () => {
    expect(() => normalizeMode('guest')).toThrow(ModeError);
    expect(() => normalizeMode('guest')).toThrow('未知使用模式: guest（只支持 admin / user）');
  });

  it('keeps the raw (untrimmed) value in the unknown-mode message', () => {
    expect(() => normalizeMode('  Guest ')).toThrow('未知使用模式:   Guest （只支持 admin / user）');
  });

  it('treats whitespace-only strings as unknown (not as the default)', () => {
    expect(() => normalizeMode('   ')).toThrow('未知使用模式:    （只支持 admin / user）');
  });

  it('reports non-string values in the message using Python str() spelling', () => {
    expect(() => normalizeMode(123)).toThrow('未知使用模式: 123（只支持 admin / user）');
    expect(() => normalizeMode(true)).toThrow('未知使用模式: True（只支持 admin / user）');
  });

  it('ModeError is a named Error subclass', () => {
    try {
      normalizeMode('nope');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(ModeError);
      expect((err as ModeError).name).toBe('ModeError');
    }
  });
});

describe('normalizeMemberAccount', () => {
  it('returns empty string for null / undefined / blank values', () => {
    expect(normalizeMemberAccount(null)).toBe('');
    expect(normalizeMemberAccount(undefined)).toBe('');
    expect(normalizeMemberAccount('')).toBe('');
    expect(normalizeMemberAccount('   ')).toBe('');
  });

  it('trims and lowercases a valid account name', () => {
    expect(normalizeMemberAccount('  Alice_01 ')).toBe('alice_01');
    expect(normalizeMemberAccount('bob-smith')).toBe('bob-smith');
    expect(normalizeMemberAccount('_svc')).toBe('_svc');
  });

  it('accepts the 32-character boundary and rejects 33 characters', () => {
    const max = 'a'.repeat(32);
    expect(normalizeMemberAccount(max)).toBe(max);
    expect(() => normalizeMemberAccount('a'.repeat(33))).toThrow(
      '账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头',
    );
  });

  it('rejects account names that start with a digit or contain illegal characters', () => {
    const message = '账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头';
    expect(() => normalizeMemberAccount('1abc')).toThrow(message);
    expect(() => normalizeMemberAccount('bad name')).toThrow(message);
    expect(() => normalizeMemberAccount('user@host')).toThrow(message);
    expect(() => normalizeMemberAccount(123)).toThrow(message);
  });
});

describe('validateMode', () => {
  it('returns the normalized pair for admin mode', () => {
    expect(validateMode('admin', '')).toEqual(['admin', '']);
    expect(validateMode(' ADMIN ', ' Alice ')).toEqual(['admin', 'alice']);
  });

  it('returns the normalized pair for a user with an account', () => {
    expect(validateMode('user', 'Alice')).toEqual(['user', 'alice']);
  });

  it('falls back to admin when mode is empty', () => {
    expect(validateMode('', '')).toEqual(['admin', '']);
  });

  it('rejects user mode without an account name with the verbatim message', () => {
    expect(() => validateMode('user', '')).toThrow('用户模式需要填写自己的服务器账号名');
    expect(() => validateMode('user', '   ')).toThrow('用户模式需要填写自己的服务器账号名');
  });

  it('propagates an invalid mode error', () => {
    expect(() => validateMode('guest', 'alice')).toThrow(
      '未知使用模式: guest（只支持 admin / user）',
    );
  });
});
