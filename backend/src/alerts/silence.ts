/**
 * Alert-silence lookup, a port of `SilenceRegistry` in
 * `servermanage/alerts.py` (lines 586-656).
 *
 * A silence is a maintenance window: while `starts_at <= now < ends_at` any
 * alert inside its scope is suppressed.  The registry is deliberately
 * stateless — it reads `alert_silences` through {@link listSilences} on
 * **every** call, so a window created or deleted elsewhere (e.g. from the web
 * settings page) takes effect on the very next polling cycle without a
 * restart.
 *
 * Scope precedence is `all` → `group` → `host`, broadest first: when several
 * windows cover a host the broadest one wins, so a global window cannot be
 * overridden by a narrower one.  On top of the Python scopes this module also
 * understands `category` and `fingerprint` scopes (narrowest, consulted last)
 * so the scheduler can silence one metric family or one exact condition; the
 * storage layer accepts them and the web form simply never creates them.
 */
import { listSilences, type SilenceRow } from '../storage/alerts';

type SqliteDatabase = import('better-sqlite3').Database;

/** Group label used for hosts without an explicit group (`DEFAULT_GROUP`). */
export const DEFAULT_GROUP = '未分组';

/**
 * Scope types from broadest to narrowest.  `all`/`group`/`host` mirror the
 * Python `_SILENCE_PRECEDENCE`; `category`/`fingerprint` are the extra
 * narrower scopes supported by {@link SilenceRegistry.activeFor}.
 */
export const SILENCE_PRECEDENCE = [
  'all',
  'group',
  'host',
  'category',
  'fingerprint',
] as const;

export type SilenceScopeType = (typeof SILENCE_PRECEDENCE)[number];

/** What the caller wants to know is silenced. */
export interface SilenceQuery {
  /** Host name to test (preferred spelling). */
  hostName?: string;
  /** Alias for {@link hostName}, matching the plan's shorter spelling. */
  host?: string;
  /** The host's group; `undefined`/empty falls back to {@link DEFAULT_GROUP}. */
  group?: string | null;
  /** Alert category, used by `category` scoped windows. */
  category?: string | null;
  /** Alert fingerprint, used by `fingerprint` scoped windows. */
  fingerprint?: string | null;
}

/** Result of {@link SilenceRegistry.activeFor}. */
export interface SilenceMatch {
  silenced: boolean;
  /** The matched window's reason, when silenced. */
  reason?: string;
}

function rowMatches(
  row: SilenceRow,
  hostName: string,
  group: string,
  query: SilenceQuery,
): boolean {
  switch (row.scope_type) {
    case 'all':
      return true;
    case 'group':
      return row.scope === group;
    case 'host':
      return row.scope === hostName;
    case 'category':
      return query.category !== null
        && query.category !== undefined
        && row.scope === query.category;
    case 'fingerprint':
      return query.fingerprint !== null
        && query.fingerprint !== undefined
        && row.scope === query.fingerprint;
    default:
      return false;
  }
}

/**
 * Looks up the active maintenance silence covering a host.
 *
 * ```ts
 * const silences = new SilenceRegistry(db);
 * silences.activeFor({ hostName: 'web-1', group: 'prod' }, new Date());
 * // -> { silenced: true, reason: 'migration' } or { silenced: false }
 * ```
 */
export class SilenceRegistry {
  constructor(private readonly db: SqliteDatabase) {}

  /**
   * Returns the first active window matching the query under the scope
   * precedence, or `{silenced: false}` when nothing matches.
   *
   * `now` is explicit so callers (and tests) can pin the clock; the database
   * is re-read on every call, never cached.
   */
  activeFor(query: SilenceQuery, now: Date): SilenceMatch {
    const hostName = query.hostName !== undefined && query.hostName !== ''
      ? query.hostName
      : (query.host ?? '');
    const group = query.group === null || query.group === undefined || query.group === ''
      ? DEFAULT_GROUP
      : query.group;

    const rows = listSilences(this.db, { activeOnly: true, now });

    for (const scopeType of SILENCE_PRECEDENCE) {
      for (const row of rows) {
        if (row.scope_type !== scopeType) {
          continue;
        }
        if (rowMatches(row, hostName, group, query)) {
          return { silenced: true, reason: row.reason };
        }
      }
    }
    return { silenced: false };
  }
}
