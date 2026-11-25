/**
 * Python-compatible JSON encoding for TEXT columns.
 *
 * The Python oracle serialises every JSON column through
 * `servermanage/serialization.py::dump_json`:
 *
 * ```python
 * json.dumps(to_jsonable(obj), ensure_ascii=False)
 * ```
 *
 * `json.dumps` with the default `indent=None` uses the separators
 * `(', ', ': ')` (a space after every comma and colon) and `ensure_ascii=False`
 * keeps non-ASCII characters raw instead of escaping them. JavaScript's
 * `JSON.stringify` uses compact separators (`(',', ':')`) and therefore does
 * *not* produce byte-identical payloads, so this module reproduces Python's
 * default formatting explicitly.
 *
 * Settings/payload values are plain JSON values (objects, arrays, strings,
 * numbers, booleans, null); `to_jsonable` is the identity for those. The few
 * remaining differences are documented on {@link dumpJson}.
 */

/** Values accepted by {@link dumpJson}. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Formats a number the way Python's `repr(float)` / `json.dumps` would for the
 * common cases. JavaScript has a single `number` type, so an integral value is
 * written without a fractional part (`1`, not `1.0`); callers that need the
 * Python `int`/`float` distinction are responsible for supplying the right
 * value.
 */
function formatNumber(value: number): string {
  if (Number.isNaN(value)) {
    // Python's json.dumps defaults to allow_nan=True -> bare NaN / Infinity.
    return 'NaN';
  }
  if (value === Infinity) {
    return 'Infinity';
  }
  if (value === -Infinity) {
    return '-Infinity';
  }

  const text = String(value);
  // JavaScript renders exponents as `1e-7` / `1e+21`; Python as `1e-07` /
  // `1e+21` (always a sign and at least two exponent digits).
  const match = /^(-?\d+(?:\.\d+)?)e([+-])(\d+)$/.exec(text);
  if (!match) {
    return text;
  }
  return `${match[1]}e${match[2]}${match[3].padStart(2, '0')}`;
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) {
    // `undefined` has no Python equivalent; treat it as JSON null so callers
    // never emit the literal token `undefined` (which is invalid JSON).
    return 'null';
  }

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return formatNumber(value);
    case 'string':
      // JSON.stringify produces the same escape sequences as Python's
      // json.dumps for quotes, backslashes and control characters, while
      // leaving non-ASCII raw (the ensure_ascii=False behaviour).
      return JSON.stringify(value);
    case 'bigint':
      // Python has arbitrary-precision ints; emit the decimal digits.
      return value.toString();
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => serialize(item)).join(', ')}]`;
      }
      if (ArrayBuffer.isView(value)) {
        // Byte buffers are not valid JSON; represent them as arrays of bytes.
        return `[${Array.from(value as unknown as Uint8Array)
          .map((byte) => serialize(byte))
          .join(', ')}]`;
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item === undefined) {
          // Match JSON's omission of undefined object properties.
          continue;
        }
        parts.push(`${JSON.stringify(key)}: ${serialize(item)}`);
      }
      return `{${parts.join(', ')}}`;
    }
    default:
      throw new TypeError(`dumpJson: unsupported value of type ${typeof value}`);
  }
}

/**
 * Serialises `value` the way `json.dumps(value, ensure_ascii=False)` does with
 * default separators: `{"a": 1, "b": [1, 2]}`.
 *
 * Known limitations (all irrelevant to the settings payloads this project
 * stores): JavaScript cannot distinguish `1` from `1.0`, object keys that look
 * like array indices are ordered by JavaScript rather than insertion order, and
 * very large integral floats (`1e20`) print in fixed notation rather than
 * Python's exponential form.
 */
export function dumpJson(value: unknown): string {
  return serialize(value);
}

/** Parses a JSON column written by {@link dumpJson} (or by Python). */
export function loadJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}
