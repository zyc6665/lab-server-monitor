/**
 * Stateful alert engine + notifier — ported from the Python oracle
 * `servermanage/alerts.py:657-1366` (Task 6 of P4).
 *
 * This layer sits on top of the pure rule layer (`./rules`) and the storage /
 * silence / streak helpers. It owns everything that has side effects:
 *
 * - {@link Notifier} fans one {@link AlertEvent} out to every enabled channel
 *   (`desktop` → `email` → `webhook`), isolating channel failures and returning
 *   the names of the channels that actually accepted the event.
 * - {@link AlertEngine} turns raw events into "notify now" decisions:
 *   de-duplication / cooldown, the `error_increase` bypass, acknowledgement
 *   suppression, per-host aggregation, persistence, and recovery notices.
 *
 * Ported pieces (Python -> here):
 *
 * - `_alert_timestamp`     -> {@link _alert_timestamp}
 * - `_alert_subject`       -> {@link _alert_subject}
 * - `_alert_text_body`     -> {@link _alert_text_body}
 * - `_alert_html_body`     -> {@link _alert_html_body}
 * - `_batch_event`         -> {@link _batch_event}
 * - `_as_utc`              -> {@link _as_utc}
 * - `_has_error_increase`  -> {@link _has_error_increase}
 * - `_severity_rank`       -> {@link _severity_rank}
 * - `NotifierProtocol`     -> {@link NotifierProtocol}
 * - `Notifier`             -> {@link Notifier}
 * - `AlertEngine.process`  -> {@link AlertEngine.process}
 *
 * Deliberate differences from the Python oracle (see the Task 6 report):
 *
 * - The engine is **async**: Node cannot block on SMTP / HTTP the way the
 *   Python synchronous code does, so every method that may dispatch returns a
 *   `Promise`.
 * - Consecutive-period gating does NOT live inside the Python `AlertEngine`
 *   (it is done in `servermanage/app.py:run_status_once`). Per the Task 6
 *   brief it is folded into {@link AlertEngine.process} using the shared
 *   {@link StreakTracker} (Task 4), before the `_should_skip` gate.
 * - The alert table has no `resolved_at` column (neither does Python's
 *   storage layer), so {@link AlertEngine.resolve} only flips `status`.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

import {
  fingerprintFor,
  recoveryEvent,
  type AlertEvent,
} from './rules';
import {
  effectivePeriods,
  StreakTracker,
  type PerHostRules,
} from './streak';
import type { SilenceRegistry } from './silence';
import {
  findLatestAlert,
  insertAlert,
  listOpenAlertsForHost,
  updateAlert,
  type AlertRow,
} from '../storage/alerts';
import { buildMessage, sendReport, type SendReportOptions, type SmtpConfig } from './mailer';
import {
  sendWebhook,
  type FetchLike,
  type SendWebhookOptions,
  type WebhookConfig,
} from './webhook';
import {
  sendDesktopNotification,
  type DesktopBridge,
} from './desktop';

// ---------------------------------------------------------------------------
// Config / protocol types
// ---------------------------------------------------------------------------

/**
 * The `alerts` config section consumed by the engine / notifier.
 *
 * Field names are snake_case to match `servermanage/models.py` `AlertsConfig`
 * (and the raw `loadEffectiveSettings(db).alerts` object). Every field except
 * `enabled` is optional with the same defaults the Python code applies.
 */
export interface AlertsConfig {
  enabled: boolean;
  desktop_notification?: boolean | null;
  email?: boolean | null;
  cooldown_minutes?: number | null;
  repeat_while_active?: boolean | null;
  offline_failures?: number | null;
  aggregate_by_host?: boolean | null;
  notify_on_recovery?: boolean | null;
  consecutive_periods?: number | string | null;
  thresholds?: Record<string, unknown> | null;
  webhook?: WebhookConfig | null;
}

/**
 * Anything able to fan one event out to the enabled channels.
 *
 * `dispatch` resolves to the names of the channels that actually accepted the
 * event (e.g. `["desktop", "email"]`). `dispatchBatch` merges several same-host
 * events into one message; it is optional so legacy `dispatch`-only doubles
 * keep working (and, like Python, do not get automatic recovery notifications).
 */
export interface NotifierProtocol {
  dispatch(event: AlertEvent, config: AlertsConfig): string[] | Promise<string[]>;
  dispatchBatch?(
    events: AlertEvent[],
    config: AlertsConfig,
  ): string[] | Promise<string[]>;
}

/** A per-channel send function: resolves `true` when the channel accepted it. */
export type ChannelAdapter = (
  event: AlertEvent,
  config: AlertsConfig,
) => boolean | Promise<boolean>;

/** Channels injected into {@link Notifier}. A missing adapter is "unconfigured". */
export interface NotifierChannels {
  desktop?: ChannelAdapter | null;
  email?: ChannelAdapter | null;
  webhook?: ChannelAdapter | null;
}

// ---------------------------------------------------------------------------
// Free helpers (1:1 with the Python module-level helpers)
// ---------------------------------------------------------------------------

/** `_ERROR_INCREASE_MARKER` (`servermanage/alerts.py:643`). */
const ERROR_INCREASE_MARKER = 'error_increase';

/** `_RESOLVE_SCAN_LIMIT` (`servermanage/alerts.py:654`). */
const RESOLVE_SCAN_LIMIT = 100_000;

/**
 * Sentinel for "the caller did not specify `notify`" (`_NOTIFY_DEFAULT`).
 *
 * Modern notifiers (those exposing `dispatchBatch`) default recovery
 * notifications on; legacy `dispatch`-only notifiers keep the historical
 * no-recovery behaviour.
 */
export const NOTIFY_DEFAULT: unique symbol = Symbol('notify-default');

/** Recovery-notify argument: an explicit boolean, or the default sentinel. */
export type NotifyOption = boolean | typeof NOTIFY_DEFAULT;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Local, human-readable ISO-8601 timestamp for notification bodies
 * (`_alert_timestamp`): second precision with a numeric UTC offset, e.g.
 * `2026-01-01T08:00:00+08:00`. The clock is injectable for deterministic tests.
 */
export function _alert_timestamp(now: Date = new Date()): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  const local = new Date(now.getTime() + offsetMinutes * 60_000);
  return (
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}` +
    `T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}` +
    offset
  );
}

/** `_alert_subject`: one-line subject prefixed with the severity. */
export function _alert_subject(event: AlertEvent): string {
  return `[${event.severity}] ${event.title}`;
}

/** `_alert_text_body`: host, category, severity, title, time, blank, message. */
export function _alert_text_body(event: AlertEvent): string {
  return [
    `主机: ${event.host_name}`,
    `类别: ${event.category}`,
    `级别: ${event.severity}`,
    `标题: ${event.title}`,
    `时间: ${_alert_timestamp()}`,
    '',
    event.message,
  ].join('\n');
}

/** Python `html.escape` (`quote=True`): escapes `& < > " '`. */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** `_alert_html_body`: minimal, safely-escaped HTML rendering of the text body. */
export function _alert_html_body(event: AlertEvent): string {
  const rows: Array<[string, string]> = [
    ['主机', event.host_name],
    ['类别', event.category],
    ['级别', event.severity],
    ['标题', event.title],
    ['时间', _alert_timestamp()],
    ['详情', event.message],
  ];
  const cells = rows
    .map(
      ([label, value]) =>
        `<tr><th>${htmlEscape(String(label))}</th>` +
        `<td>${htmlEscape(String(value))}</td></tr>`,
    )
    .join('');
  return (
    '<html><body>' +
    `<h3>${htmlEscape(event.title)}</h3>` +
    `<table>${cells}</table>` +
    '</body></html>'
  );
}

/**
 * `_batch_event`: merge several same-host events into one notification event.
 *
 * Keeps the host, carries the highest severity, lists every underlying
 * title/message in the body. Its fingerprint is only used for logging (the
 * individual rows keep their own fingerprints).
 */
export function _batch_event(events: AlertEvent[]): AlertEvent {
  const hostName = events[0].host_name;
  let highest = events[0];
  for (const event of events) {
    if (_severity_rank(event.severity) > _severity_rank(highest.severity)) {
      highest = event;
    }
  }
  const title = `主机 ${hostName} ${events.length} 项告警`;
  const details = events
    .map((event) => `- [${event.severity}] ${event.title}：${event.message}`)
    .join('\n');
  return {
    host_name: hostName,
    category: 'batch',
    severity: highest.severity,
    title,
    message: details,
    fingerprint: fingerprintFor('batch', hostName, String(events.length)),
    reasons: [],
  };
}

/**
 * `_as_utc`: normalise a timestamp to a `Date` instant. JavaScript `Date`
 * values are already absolute, so this is defensive; a string is parsed as
 * ISO-8601 (treated as UTC when it carries no offset, matching Python's
 * "naive means UTC").
 */
export function _as_utc(value: Date | string): Date {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  return _parse_iso(value) ?? new Date(value);
}

/** Parse a stored ISO timestamp; return `null` when unusable (`_parse_iso`). */
function _parse_iso(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  // Python's `datetime.fromisoformat` accepts the 6-digit fractional seconds
  // written by the storage layer; normalise to milliseconds so every engine
  // parses it identically.
  const normalized = value.replace(/\.(\d{3})\d+/, '.$1');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `_has_error_increase`: true when the event reports a growing error count.
 * The structured `reasons` is authoritative; the fingerprint substring is a
 * defensive fallback for producers that embed the marker there.
 */
export function _has_error_increase(event: AlertEvent): boolean {
  if ((event.reasons ?? []).includes(ERROR_INCREASE_MARKER)) {
    return true;
  }
  return event.fingerprint.toLowerCase().includes(ERROR_INCREASE_MARKER);
}

/** Severity ordering used to detect a genuine escalation (`_SEVERITY_RANK`). */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/** `_severity_rank`: info 0, warning 1, critical 2, anything else 0. */
export function _severity_rank(severity: string | null | undefined): number {
  return SEVERITY_RANK[String(severity ?? '').trim().toLowerCase()] ?? 0;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * `Notifier`: fan one {@link AlertEvent} out to every enabled channel.
 *
 * Channels are tried independently in the order `desktop` → `email` →
 * `webhook`. Each honours its config `enabled` flag, and a failure in one
 * channel is isolated so the others still run. `dispatch` never throws: an
 * unexpected failure is swallowed and the channels accepted so far are still
 * returned. An empty result therefore means the engine should retry next cycle.
 *
 * Channels are injected as {@link ChannelAdapter}s; a missing adapter means the
 * channel is "unconfigured" and is skipped cleanly (mirroring Python's
 * `smtp is None` email skip). Use {@link createNotifierFromTask5} to wire the
 * real Task 5 senders.
 */
export class Notifier implements NotifierProtocol {
  private readonly channels: NotifierChannels;

  constructor(channels: NotifierChannels = {}) {
    this.channels = channels;
  }

  async dispatch(event: AlertEvent, config: AlertsConfig): Promise<string[]> {
    const accepted: string[] = [];
    await this.runChannel(accepted, 'desktop', config.desktop_notification, this.channels.desktop, event, config);
    await this.runChannel(accepted, 'email', config.email, this.channels.email, event, config);
    await this.runChannel(
      accepted,
      'webhook',
      config.webhook?.enabled,
      this.channels.webhook,
      event,
      config,
    );
    return accepted;
  }

  async dispatchBatch(events: AlertEvent[], config: AlertsConfig): Promise<string[]> {
    const list = [...events];
    if (list.length === 0) {
      return [];
    }
    if (list.length === 1) {
      return this.dispatch(list[0], config);
    }
    return this.dispatch(_batch_event(list), config);
  }

  private async runChannel(
    accepted: string[],
    name: string,
    enabled: boolean | null | undefined,
    adapter: ChannelAdapter | null | undefined,
    event: AlertEvent,
    config: AlertsConfig,
  ): Promise<void> {
    if (!enabled || typeof adapter !== 'function') {
      return;
    }
    try {
      const ok = await adapter(event, config);
      if (ok) {
        accepted.push(name);
      }
    } catch {
      // One channel must never break the others (`_dispatch_*` isolation).
    }
  }
}

// ---------------------------------------------------------------------------
// Task 5 wiring factory
// ---------------------------------------------------------------------------

/** Options for {@link createNotifierFromTask5}. */
export interface Task5NotifierOptions {
  /** SMTP config; absent means the email channel is unconfigured. */
  smtp?: SmtpConfig | null;
  /** Electron desktop bridge; absent means desktop is unavailable. */
  bridge?: DesktopBridge | null;
  /** Injectable fetch for the webhook channel (tests). */
  fetchImpl?: FetchLike;
  /** Extra options forwarded to {@link sendReport}. */
  emailSendOptions?: SendReportOptions;
  /** Extra options forwarded to {@link sendWebhook}. */
  webhookSendOptions?: SendWebhookOptions;
}

/**
 * Builds a {@link Notifier} backed by the Task 5 channel modules:
 * `desktop` → {@link sendDesktopNotification}, `email` → {@link buildMessage} +
 * {@link sendReport}, `webhook` → {@link sendWebhook}.
 *
 * The email channel is only registered when an {@link SmtpConfig} is supplied
 * (otherwise it stays unconfigured, like Python's `smtp is None` skip).
 */
export function createNotifierFromTask5(options: Task5NotifierOptions = {}): Notifier {
  const { smtp, bridge } = options;
  const channels: NotifierChannels = {
    desktop: (event) =>
      sendDesktopNotification(_alert_subject(event), _alert_text_body(event), {
        bridge: bridge ?? null,
      }),
    webhook: (event, config) => {
      const webhook = config.webhook;
      if (!webhook) {
        return false;
      }
      return sendWebhook(
        webhook.type ?? '',
        event,
        webhook,
        options.webhookSendOptions ?? {},
      );
    },
  };
  if (smtp) {
    channels.email = async (event) => {
      const message = buildMessage({
        subject: _alert_subject(event),
        fromAddr: smtp.fromAddr,
        toAddrs: smtp.toAddrs,
        textBody: _alert_text_body(event),
        htmlBody: _alert_html_body(event),
      });
      await sendReport(smtp, message, options.emailSendOptions ?? {});
      return true;
    };
  }
  return new Notifier(channels);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Group memberships used for group-scoped silence matching. */
export type HostGroupSource =
  | Readonly<Record<string, string | readonly string[] | null | undefined>>
  | ((host: string) => string | readonly string[] | null | undefined);

/** Constructor options for {@link AlertEngine}. */
export interface AlertEngineOptions {
  db: SqliteDatabase;
  config: AlertsConfig;
  notifier: NotifierProtocol;
  /** Silence checker; absent means "nothing is silenced". */
  silences?: Pick<SilenceRegistry, 'activeFor'> | null;
  /** Streak tracker (Task 4); a fresh one is created when omitted. */
  streaks?: StreakTracker | null;
  /** Clock override for deterministic tests; defaults to `() => new Date()`. */
  now?: (() => Date) | null;
  /** Host group source used for group-scoped silences (optional). */
  hostGroups?: HostGroupSource | null;
  /** Per-host consecutive-period overrides (optional). */
  perHostRules?: PerHostRules | null;
}

/** Options shared by {@link AlertEngine.resolve}. */
export interface ResolveOptions {
  notify?: NotifyOption;
}

/** Options for {@link AlertEngine.resolve_missing}. */
export interface ResolveMissingOptions {
  category?: string | null;
  skip_prefixes?: readonly string[];
  notify?: NotifyOption;
}

/**
 * `AlertEngine`: turn raw {@link AlertEvent}s into "notify now" decisions.
 *
 * Responsibilities (mirroring the Python docstring):
 * - **De-duplication / cooldown** — a still-`active` alert with the same
 *   fingerprint is skipped while less than `cooldown_minutes` have elapsed since
 *   it was last notified. Reads the DB, so it survives a restart.
 * - **Error-increase bypass** — a fingerprint / reason containing
 *   `error_increase` always notifies, even inside the cooldown window.
 * - **Persistence** — every notification inserts an `active` row, records the
 *   channels that accepted it, and lets {@link resolve} close the condition.
 * - **Graceful degradation** — DB / notifier failures are swallowed so a broken
 *   dependency never aborts the polling cycle.
 *
 * The consecutive-period gate (Task 4) runs at the start of {@link process}:
 * silenced events are dropped first, the remaining events are observed in the
 * {@link StreakTracker}, and only events whose present streak has reached the
 * host's effective period count proceed to the cooldown gate.
 */
export class AlertEngine {
  private readonly db: SqliteDatabase;
  private readonly config: AlertsConfig;
  private readonly notifier: NotifierProtocol;
  private readonly silences: Pick<SilenceRegistry, 'activeFor'> | null;
  private readonly streaks: StreakTracker;
  private readonly clock: () => Date;
  private readonly hostGroups: HostGroupSource | null;
  private readonly perHostRules: PerHostRules | null;
  /** Per-host fingerprints observed on the previous cycle (for absent detection). */
  private readonly streakSeen = new Map<string, Set<string>>();

  constructor(options: AlertEngineOptions) {
    this.db = options.db;
    this.config = options.config;
    this.notifier = options.notifier;
    this.silences = options.silences ?? null;
    this.streaks = options.streaks ?? new StreakTracker();
    this.clock = options.now ?? (() => new Date());
    this.hostGroups = options.hostGroups ?? null;
    this.perHostRules = options.perHostRules ?? null;
  }

  // -- public API --------------------------------------------------------

  /**
   * Persist `events` and return the subset actually sent to at least one
   * channel. Disabled config is a no-op. Silenced events are dropped before
   * the streak gate; events still in their consecutive-period warm-up, or
   * suppressed by the cooldown / acknowledgement gate, are dropped next.
   */
  async process(events: AlertEvent[]): Promise<AlertEvent[]> {
    if (!this.config.enabled) {
      return [];
    }

    const now = _as_utc(this.clock());
    const afterSilence = events.filter((event) => !this._is_silenced(event, now));
    const candidates = this._gate_by_streak(afterSilence).filter(
      (event) => !this._should_skip(event, now),
    );

    if (candidates.length === 0) {
      return [];
    }

    if (Boolean(this.config.aggregate_by_host ?? false)) {
      return this._process_aggregated(candidates, now);
    }
    return this._process_individually(candidates, now);
  }

  /** `_process_individually`: one row + one dispatch per event. */
  async _process_individually(events: AlertEvent[], now: Date): Promise<AlertEvent[]> {
    const notified: AlertEvent[] = [];
    for (const event of events) {
      const alertId = this._persist(event, now);
      if (alertId === null) {
        continue;
      }
      const channels = await this._dispatch(event);
      this._record_channels(alertId, channels);
      if (channels.length > 0) {
        notified.push(event);
      }
    }
    return notified;
  }

  /** `_process_aggregated`: group by host, one merged dispatch for many. */
  async _process_aggregated(events: AlertEvent[], now: Date): Promise<AlertEvent[]> {
    const groups = new Map<string, AlertEvent[]>();
    for (const event of events) {
      const group = groups.get(event.host_name);
      if (group) {
        group.push(event);
      } else {
        groups.set(event.host_name, [event]);
      }
    }

    const notified: AlertEvent[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        const event = group[0];
        const alertId = this._persist(event, now);
        if (alertId === null) {
          continue;
        }
        const channels = await this._dispatch(event);
        this._record_channels(alertId, channels);
        if (channels.length > 0) {
          notified.push(event);
        }
        continue;
      }

      const persisted: Array<{ event: AlertEvent; alertId: number }> = [];
      for (const event of group) {
        const alertId = this._persist(event, now);
        if (alertId !== null) {
          persisted.push({ event, alertId });
        }
      }
      if (persisted.length === 0) {
        continue;
      }

      const batchEvents = persisted.map((item) => item.event);
      const channels = await this._dispatch_batch(batchEvents);
      for (const item of persisted) {
        this._record_channels(item.alertId, channels);
      }
      if (channels.length > 0) {
        notified.push(...batchEvents);
      }
    }
    return notified;
  }

  /**
   * `resolve`: mark every open alert for `host_name` + `category` as resolved
   * (both `active` and `acknowledged` rows). Emits one recovery event for the
   * closed condition; `skip_prefixes` / recovery rows are handled by
   * {@link resolve_missing}. Returns the generated recovery events even when
   * notifications are disabled; no open rows means an empty list.
   */
  async resolve(
    host_name: string,
    category: string,
    options: ResolveOptions = {},
  ): Promise<AlertEvent[]> {
    let rows: AlertRow[];
    try {
      rows = this._open_alerts_for_host(host_name, category);
    } catch {
      return [];
    }

    let closedConditions = 0;
    for (const row of rows) {
      if (row.host_name !== host_name || row.category !== category) {
        continue;
      }
      const isRecovery = String(row.fingerprint ?? '').startsWith('recovery:');
      try {
        updateAlert(this.db, row.id, { status: 'resolved' });
        if (!isRecovery) {
          closedConditions += 1;
        }
      } catch {
        // Graceful degradation: log-and-continue in Python; swallow here.
      }
    }

    if (closedConditions === 0) {
      return [];
    }
    return this._emit_recovery([[host_name, category]], options.notify ?? NOTIFY_DEFAULT);
  }

  /**
   * `resolve_missing`: resolve a host's open alerts whose condition no longer
   * fires. `active_fingerprints` is the set still produced this cycle; any open
   * row whose fingerprint is absent is stale and gets `status='resolved'`.
   * `skip_prefixes` names fingerprints that must never be auto-resolved (they
   * neither close nor produce a recovery notice). One recovery event is
   * produced per `(host, category)` that actually had non-recovery rows closed.
   */
  async resolve_missing(
    host_name: string,
    active_fingerprints: Iterable<string>,
    options: ResolveMissingOptions = {},
  ): Promise<AlertEvent[]> {
    const remaining = new Set<string>(active_fingerprints);
    const skip = options.skip_prefixes ?? [];
    const category = options.category ?? null;

    let rows: AlertRow[];
    try {
      rows = this._open_alerts_for_host(host_name, category ?? undefined);
    } catch {
      return [];
    }

    const closedCategories: string[] = [];
    for (const row of rows) {
      if (row.host_name !== host_name) {
        continue;
      }
      if (category !== null && row.category !== category) {
        continue;
      }
      const fingerprint = String(row.fingerprint ?? '');
      if (skip.length > 0 && skip.some((prefix) => fingerprint.startsWith(prefix))) {
        continue;
      }
      if (row.fingerprint !== null && remaining.has(String(row.fingerprint))) {
        continue;
      }
      const isRecovery = fingerprint.startsWith('recovery:');
      try {
        updateAlert(this.db, row.id, { status: 'resolved' });
      } catch {
        continue;
      }
      if (isRecovery) {
        // A recovery notice is informational; closing it must not spawn another.
        continue;
      }
      const rowCategory = row.category;
      if (typeof rowCategory === 'string' && !closedCategories.includes(rowCategory)) {
        closedCategories.push(rowCategory);
      }
    }

    if (closedCategories.length === 0) {
      return [];
    }
    return this._emit_recovery(
      closedCategories.map((value) => [host_name, value] as [string, string]),
      options.notify ?? NOTIFY_DEFAULT,
    );
  }

  /** Alias of {@link resolve_missing} using the plan's camelCase spelling. */
  resolveMissing(
    host_name: string,
    active_fingerprints: Iterable<string>,
    options: ResolveMissingOptions = {},
  ): Promise<AlertEvent[]> {
    return this.resolve_missing(host_name, active_fingerprints, options);
  }

  /**
   * `open_alert_fingerprints`: fingerprints of the host's currently open alerts
   * (`active` + `acknowledged`). DB failures yield an empty set.
   */
  open_alert_fingerprints(host_name: string, category?: string | null): Set<string> {
    let rows: AlertRow[];
    try {
      rows = this._open_alerts_for_host(host_name, category ?? undefined);
    } catch {
      return new Set();
    }
    const fingerprints = new Set<string>();
    for (const row of rows) {
      if (row.host_name !== host_name) {
        continue;
      }
      if (category !== null && category !== undefined && row.category !== category) {
        continue;
      }
      if (row.fingerprint) {
        fingerprints.add(String(row.fingerprint));
      }
    }
    return fingerprints;
  }

  /** Alias of {@link open_alert_fingerprints} (plan's camelCase spelling). */
  openAlertFingerprints(host_name: string, category?: string | null): Set<string> {
    return this.open_alert_fingerprints(host_name, category);
  }

  /** Public synchronous view of {@link _should_skip} (cooldown / ack gate). */
  shouldSkip(event: AlertEvent, now?: Date): boolean {
    return this._should_skip(event, now ? _as_utc(now) : _as_utc(this.clock()));
  }

  // -- recovery ----------------------------------------------------------

  /**
   * `_emit_recovery`: build one recovery event per key and, when recovery
   * notifications are on, push them through the normal pipeline. Returns the
   * events regardless of whether they were dispatched.
   */
  async _emit_recovery(
    keys: Array<[string, string]>,
    notify: NotifyOption,
  ): Promise<AlertEvent[]> {
    const events = keys.map(([hostName, category]) => recoveryEvent(hostName, category));
    if (
      this._should_notify_recovery(notify) &&
      Boolean(this.config.notify_on_recovery ?? true)
    ) {
      await this.process(events);
    }
    return events;
  }

  /**
   * `_should_notify_recovery`: capability-based default. When `notify` is the
   * sentinel, recovery notifications are on iff the notifier implements
   * `dispatchBatch`; otherwise the explicit boolean wins.
   */
  _should_notify_recovery(notify: NotifyOption): boolean {
    if (notify === NOTIFY_DEFAULT) {
      return typeof this.notifier.dispatchBatch === 'function';
    }
    return Boolean(notify);
  }

  // -- internals ---------------------------------------------------------

  /** `_open_alerts_for_host`: open alerts filtered in SQL by host / category. */
  private _open_alerts_for_host(host_name: string, category?: string | null): AlertRow[] {
    return listOpenAlertsForHost(this.db, host_name, {
      category: category ?? undefined,
      limit: RESOLVE_SCAN_LIMIT,
    });
  }

  /** `_groups_for_host`: resolve a host's group memberships for silence. */
  _groups_for_host(host_name: string): string[] {
    const source = this.hostGroups;
    if (source === null) {
      return [];
    }
    try {
      const groups =
        typeof source === 'function' ? source(host_name) : source[host_name];
      if (groups === null || groups === undefined) {
        return [];
      }
      if (typeof groups === 'string') {
        return [groups];
      }
      return groups.map((group) => String(group));
    } catch {
      return [];
    }
  }

  /** `_is_silenced`: true when an active silence covers this event's host. */
  _is_silenced(event: AlertEvent, now: Date): boolean {
    const checker = this.silences;
    if (checker === null) {
      return false;
    }
    try {
      const groups = this._groups_for_host(event.host_name);
      const probes: Array<string | null> = groups.length > 0 ? groups : [null];
      for (const group of probes) {
        const hit = checker.activeFor(
          {
            hostName: event.host_name,
            group,
            category: event.category,
            fingerprint: event.fingerprint,
          },
          now,
        );
        if (hit.silenced) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * `_should_skip`: suppression for an event that already passes silence /
   * streak gating.
   *
   * - `error_increase` always notifies.
   * - An `acknowledged` latest row means "confirmed still-present": suppress.
   * - An `active` row follows cooldown + un-notified-retry semantics; an
   *   `active` row with no `notified_channels` is retried (no cooldown consumed).
   */
  _should_skip(event: AlertEvent, now: Date): boolean {
    if (_has_error_increase(event)) {
      return false;
    }

    let latest: AlertRow | null;
    try {
      latest = findLatestAlert(this.db, event.fingerprint);
    } catch {
      // Cannot prove a duplicate: let it through rather than drop it.
      return false;
    }
    if (latest === null) {
      return false;
    }

    const status = latest.status;
    if (status === 'acknowledged') {
      return true;
    }
    if (status !== 'active') {
      return false;
    }

    // A previous attempt that no channel accepted must be retried.
    if (!latest.notified_channels) {
      return false;
    }

    const createdAt = _parse_iso(latest.created_at);
    if (createdAt === null) {
      return false;
    }

    const cooldownMinutes = this.config.cooldown_minutes ?? 60;
    const elapsedMs = now.getTime() - createdAt.getTime();
    if (elapsedMs < cooldownMinutes * 60_000) {
      return true;
    }

    // Cooldown elapsed on a still-active, already-notified alert. When
    // `repeat_while_active` is off, stay silent unless the new event is a
    // genuine escalation (strictly higher severity).
    if (!Boolean(this.config.repeat_while_active ?? false)) {
      if (_severity_rank(event.severity) <= _severity_rank(latest.severity)) {
        return true;
      }
    }
    return false;
  }

  /** `_persist`: insert an `active` row at `now`; DB errors -> `null`. */
  private _persist(event: AlertEvent, now: Date): number | null {
    try {
      return insertAlert(
        this.db,
        {
          host_name: event.host_name,
          category: event.category,
          severity: event.severity,
          title: event.title,
          message: event.message,
          fingerprint: event.fingerprint,
          reasons: event.reasons,
        },
        { createdAt: now },
      );
    } catch {
      return null;
    }
  }

  /** `_dispatch`: notify one event; notifier errors -> empty channel list. */
  private async _dispatch(event: AlertEvent): Promise<string[]> {
    try {
      const channels = await this.notifier.dispatch(event, this.config);
      return Array.isArray(channels) ? [...channels] : [];
    } catch {
      return [];
    }
  }

  /**
   * `_dispatch_batch`: dispatch a same-host batch, tolerating notifiers without
   * `dispatchBatch` (fall back to per-event dispatch and union the channels).
   */
  private async _dispatch_batch(events: AlertEvent[]): Promise<string[]> {
    if (events.length === 0) {
      return [];
    }
    if (events.length === 1) {
      return this._dispatch(events[0]);
    }

    const batch = this.notifier.dispatchBatch;
    if (typeof batch === 'function') {
      try {
        const channels = await batch.call(this.notifier, events, this.config);
        return Array.isArray(channels) ? [...channels] : [];
      } catch {
        return [];
      }
    }

    const accepted: string[] = [];
    for (const event of events) {
      for (const channel of await this._dispatch(event)) {
        if (!accepted.includes(channel)) {
          accepted.push(channel);
        }
      }
    }
    return accepted;
  }

  /** `_record_channels`: write the comma-joined accepted channels back. */
  private _record_channels(alertId: number, channels: string[]): void {
    try {
      updateAlert(this.db, alertId, { notifiedChannels: channels.join(',') });
    } catch {
      // Graceful degradation.
    }
  }

  /**
   * Consecutive-period gate (Task 4 `StreakTracker`), folded into the engine per
   * the Task 6 brief. Observes every candidate fingerprint for its host as
   * present, and observes previously-seen / currently-open fingerprints of the
   * host as absent so a bad → good → bad wobble restarts the present count.
   * Recovery events (`recovery:*`) bypass the gate — they are engine-generated,
   * not raw observations of a sustained condition.
   */
  private _gate_by_streak(events: AlertEvent[]): AlertEvent[] {
    const passThrough: AlertEvent[] = [];
    // host -> fingerprint -> the events observed this cycle (usually one).
    const presentByHost = new Map<string, Map<string, AlertEvent[]>>();
    for (const event of events) {
      if (event.fingerprint.startsWith('recovery:')) {
        passThrough.push(event);
        continue;
      }
      let byFingerprint = presentByHost.get(event.host_name);
      if (!byFingerprint) {
        byFingerprint = new Map();
        presentByHost.set(event.host_name, byFingerprint);
      }
      const bucket = byFingerprint.get(event.fingerprint);
      if (bucket) {
        bucket.push(event);
      } else {
        byFingerprint.set(event.fingerprint, [event]);
      }
    }

    const hosts = new Set<string>([...presentByHost.keys(), ...this.streakSeen.keys()]);
    const passed: AlertEvent[] = [];
    for (const host of hosts) {
      const present = presentByHost.get(host) ?? new Map<string, AlertEvent[]>();
      const openFps = this.open_alert_fingerprints(host);
      const previous = this.streakSeen.get(host) ?? new Set<string>();
      const universe = new Set<string>([...present.keys(), ...previous, ...openFps]);
      const periods = effectivePeriods(
        host,
        this.perHostRules,
        this.config.consecutive_periods ?? null,
      );
      const nextSeen = new Set<string>();
      for (const fingerprint of universe) {
        const isPresent = present.has(fingerprint);
        const result = this.streaks.observe(host, fingerprint, isPresent, periods);
        if (isPresent) {
          if (result.streak >= periods) {
            passed.push(...(present.get(fingerprint) ?? []));
          }
          nextSeen.add(fingerprint);
        } else if (openFps.has(fingerprint)) {
          // Keep tracking the clear streak of a still-open condition.
          nextSeen.add(fingerprint);
        }
      }
      if (nextSeen.size > 0) {
        this.streakSeen.set(host, nextSeen);
      } else {
        this.streakSeen.delete(host);
      }
    }
    return [...passThrough, ...passed];
  }
}
