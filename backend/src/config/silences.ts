/**
 * Alert-silence management, mirroring `servermanage/settings/silences.py`.
 *
 * A thin, validated wrapper over the P1 silence storage in
 * `../storage/alerts`. On top of the storage layer it reproduces the oracle's
 * error semantics (scope validation, window bounds) and the side effect of
 * resolving the open alerts that fall inside the silenced scope.
 */
import {
  deleteSilence as deleteSilenceRow,
  insertSilence,
  listAlerts,
  listSilences as listSilenceRows,
  updateAlert,
  type SilenceRow,
} from '../storage/alerts';

import { ConfigError } from './errors';

type SqliteDatabase = import('better-sqlite3').Database;

/** Group used for hosts that do not declare one (mirrors `DEFAULT_GROUP`). */
const DEFAULT_GROUP = '未分组';

const SILENCE_SCOPE_TYPES = new Set(['host', 'group', 'all']);
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A configured host, used to map a group scope to its host names. */
export interface SilenceHost {
  name: string;
  group?: string | null;
}

/** Thrown on an invalid silence payload (status 400). */
export class SilencesError extends ConfigError {
  readonly status: number;
  readonly code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = 'SilencesError';
    this.status = options.status ?? 400;
    this.code = options.code ?? 'invalid_silence';
  }
}

export interface AddSilenceOptions {
  /** Whether settings are writable on this platform (defaults to true). */
  writable?: boolean;
  /** Known hosts, so a `group` scope can resolve to concrete host names. */
  hosts?: ReadonlyArray<SilenceHost> | Record<string, string | null | undefined>;
}

export interface ListSilencesOptions {
  activeOnly?: boolean;
  now?: Date | string | null;
}

function coerceDatetime(value: unknown, field: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new SilencesError(`${field} 不是有效时间`);
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = new Date(value.trim());
    if (Number.isNaN(parsed.getTime())) throw new SilencesError(`${field} 不是有效时间`);
    return parsed;
  }
  throw new SilencesError(`${field} 不是有效时间`);
}

function resolveScopeHosts(
  scopeType: string,
  scope: string | null,
  hosts: AddSilenceOptions['hosts'],
): Set<string> | null {
  if (scopeType === 'all') return null;
  if (scopeType === 'host') return new Set([scope as string]);

  const names = new Set<string>();
  if (Array.isArray(hosts)) {
    for (const host of hosts) {
      if (!host.name) continue;
      if ((host.group ?? DEFAULT_GROUP) === scope) names.add(host.name);
    }
  } else if (hosts && typeof hosts === 'object') {
    for (const [name, group] of Object.entries(hosts)) {
      if ((group ?? DEFAULT_GROUP) === scope) names.add(name);
    }
  }
  return names;
}

function resolveOpenAlerts(
  db: SqliteDatabase,
  scopeType: string,
  scope: string | null,
  hosts: AddSilenceOptions['hosts'],
): void {
  const targetHosts = resolveScopeHosts(scopeType, scope, hosts);
  for (const status of ['active', 'acknowledged'] as const) {
    for (const alert of listAlerts(db, { status, limit: 1_000_000 })) {
      if (targetHosts === null || (alert.host_name !== null && targetHosts.has(alert.host_name))) {
        updateAlert(db, alert.id, { status: 'resolved' });
      }
    }
  }
}

/**
 * Validate and create a silence, then resolve the open alerts in its scope.
 *
 * @returns the new silence id.
 */
export function addSilence(
  db: SqliteDatabase,
  scopeType: string,
  scope: string | null | undefined,
  reason: string,
  startsAt: string | Date,
  endsAt: string | Date,
  createdBy: string | null = null,
  options: AddSilenceOptions = {},
): number {
  if (!(options.writable ?? true)) {
    throw new SilencesError('settings are not writable on this platform');
  }

  const scopeKind = String(scopeType ?? '').trim();
  if (!SILENCE_SCOPE_TYPES.has(scopeKind)) {
    throw new SilencesError('scope_type 必须是 host、group 或 all');
  }

  let scopeValue: string | null;
  if (scopeKind === 'all') {
    if (scope !== null && scope !== undefined && String(scope).trim() !== '') {
      throw new SilencesError('all 作用域的 scope 必须为空');
    }
    scopeValue = null;
  } else {
    scopeValue = String(scope ?? '').trim();
    if (scopeValue === '') throw new SilencesError('scope 不能为空');
  }

  const start = coerceDatetime(startsAt, 'starts_at');
  const end = coerceDatetime(endsAt, 'ends_at');
  if (start.getTime() >= end.getTime()) {
    throw new SilencesError('starts_at 必须早于 ends_at');
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new SilencesError('静默窗口不能超过 30 天');
  }

  const id = insertSilence(db, scopeKind, scopeValue, String(reason ?? ''), start, end, createdBy);
  resolveOpenAlerts(db, scopeKind, scopeValue, options.hosts);
  return id;
}

/** List silences (active-only by default, matching the oracle). */
export function listSilences(db: SqliteDatabase, options: ListSilencesOptions = {}): SilenceRow[] {
  return listSilenceRows(db, {
    activeOnly: options.activeOnly ?? true,
    now: options.now ?? null,
  });
}

/** Delete a silence by id; returns whether a row was removed. */
export function deleteSilence(db: SqliteDatabase, silenceId: number): boolean {
  return deleteSilenceRow(db, silenceId);
}
