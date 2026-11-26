import { describe, it, expect } from 'vitest';

import { dumpJson, loadJson } from '../src/storage/json';

// Reference strings were produced with:
//   python -c 'import json; print(json.dumps(obj, ensure_ascii=False))'
describe('dumpJson (Python json.dumps compatibility)', () => {
  it('uses Python default separators (", " and ": ")', () => {
    expect(dumpJson({ a: 1, b: 2 })).toBe('{"a": 1, "b": 2}');
    expect(dumpJson([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('keeps non-ASCII characters raw (ensure_ascii=False)', () => {
    expect(dumpJson({ u: '中文', e: '🚀' })).toBe('{"u": "中文", "e": "🚀"}');
  });

  it('escapes quotes, backslashes and control characters like Python', () => {
    expect(dumpJson({ q: 'quote"back\\slash', ctrl: 'a\tb\nc\u0001' })).toBe(
      '{"q": "quote\\"back\\\\slash", "ctrl": "a\\tb\\nc\\u0001"}',
    );
  });

  it('renders booleans and null as true/false/null', () => {
    expect(dumpJson({ c: true, d: false, n: null })).toBe('{"c": true, "d": false, "n": null}');
  });

  it('renders nested objects and empty containers', () => {
    expect(dumpJson({ nested: { k: 'v' }, empty: {}, arr: [] })).toBe(
      '{"nested": {"k": "v"}, "empty": {}, "arr": []}',
    );
  });

  it('formats floats and exponents like Python', () => {
    expect(dumpJson({ f: 0.85, g: 1e-7 })).toBe('{"f": 0.85, "g": 1e-07}');
  });

  it('renders NaN and Infinity as Python does (allow_nan=True)', () => {
    expect(dumpJson({ nan: NaN, inf: Infinity, ninf: -Infinity })).toBe(
      '{"nan": NaN, "inf": Infinity, "ninf": -Infinity}',
    );
  });

  it('omits undefined object properties and maps a top-level undefined to null', () => {
    expect(dumpJson({ a: 1, b: undefined })).toBe('{"a": 1}');
    expect(dumpJson(undefined)).toBe('null');
  });

  it('round-trips through loadJson', () => {
    const value = { a: 1, b: ['x', true, null], c: { d: '中文' } };
    expect(loadJson(dumpJson(value))).toEqual(value);
  });
});
