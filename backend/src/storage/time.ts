/**
 * UTC timestamp formatting for storage columns.
 *
 * Python's storage layer writes `datetime.now(timezone.utc).isoformat()`,
 * which renders as `YYYY-MM-DDTHH:MM:SS.ffffff+00:00` (always six fractional
 * digits, explicit `+00:00` offset). JavaScript's `Date.prototype.toISOString`
 * produces milliseconds with a trailing `Z` instead, so it must never be used
 * here — the two formats are not byte-compatible.
 */

/** Left-pad a non-negative integer to `width` digits. */
function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Formats `d` as a UTC ISO-8601 string with microsecond precision:
 * `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`.
 *
 * JavaScript `Date` only carries millisecond resolution, so the final three
 * fractional digits are always `000` (e.g. `123` ms -> `.123000`). The result
 * is byte-compatible with Python's `datetime.now(timezone.utc).isoformat()`
 * (except that the fractional part is always present, even when it is zero,
 * which matches the storage contract's strict six-digit requirement).
 */
export function nowIsoUtc(d: Date = new Date()): string {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const milliseconds = d.getUTCMilliseconds();
  // Date has ms precision; microsecond value = ms * 1000, zero-padded to 6.
  const microseconds = milliseconds * 1000;

  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}` +
    `.${pad(microseconds, 6)}+00:00`
  );
}
