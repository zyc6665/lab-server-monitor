/**
 * Shared `_to_local_iso` port: render a stored ISO-8601 instant as an
 * offset-qualified ISO string in `timeZone`, preserving microseconds like
 * Python's `datetime.astimezone(tz).isoformat()`.
 *
 * Single implementation so every route formats timestamps identically; the
 * previous per-route copies truncated fractional seconds and diverged from
 * the Python oracle on values such as alert `created_at`.
 */

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

interface ParsedInstant {
  epochMs: number;
  /** Microseconds within the second (0-999999). */
  micro: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

function zoneOffsetMs(epochMs: number, timeZone: string): number {
  if (timeZone === 'UTC') {
    return 0;
  }
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const fields: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') {
      fields[part.type] = part.value;
    }
  }
  const asUtc = Date.UTC(
    Number(fields.year),
    Number(fields.month) - 1,
    Number(fields.day),
    Number(fields.hour) % 24,
    Number(fields.minute),
    Number(fields.second),
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

function parseTimestamp(raw: string): ParsedInstant | null {
  const text = raw.trim();
  const match = ISO_RE.exec(text);
  if (!match) {
    const fallback = Date.parse(text);
    if (Number.isNaN(fallback)) {
      return null;
    }
    return { epochMs: fallback, micro: ((fallback % 1000) + 1000) % 1000 * 1000 };
  }
  const [, y, mo, d, h, mi, s, frac, offset] = match;
  const micro = frac ? Number((frac + '000000').slice(0, 6)) : 0;
  let epochMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Math.floor(micro / 1000),
  );
  if (offset && offset !== 'Z') {
    const digits = offset.slice(1).replace(':', '');
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2, 4));
    const sign = offset[0] === '-' ? -1 : 1;
    epochMs -= sign * (hours * 60 + minutes) * 60000;
  }
  return { epochMs, micro };
}

function formatIso(epochMs: number, micro: number, timeZone: string): string {
  const offsetMs = zoneOffsetMs(epochMs, timeZone);
  const wall = new Date(epochMs + offsetMs);
  const fraction = micro !== 0 ? `.${String(micro).padStart(6, '0')}` : '';
  const sign = offsetMs < 0 ? '-' : '+';
  const absMinutes = Math.round(Math.abs(offsetMs) / 60000);
  const offHours = Math.floor(absMinutes / 60);
  const offMinutes = absMinutes % 60;
  return (
    `${wall.getUTCFullYear()}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}` +
    `T${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}:${pad2(wall.getUTCSeconds())}` +
    `${fraction}${sign}${pad2(offHours)}:${pad2(offMinutes)}`
  );
}

/** Port of `_to_local_iso`: offset-qualified local ISO, microseconds preserved. */
export function toLocalIso(value: unknown, timeZone: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const text = String(value);
  const parsed = parseTimestamp(text);
  if (parsed === null) {
    return text;
  }
  return formatIso(parsed.epochMs, parsed.micro, timeZone);
}
