/**
 * Tests for the Task 6 alert engine (`src/alerts/engine.ts`).
 *
 * Covers the streak (consecutive-period) gate, cooldown / de-duplication,
 * acknowledgement suppression, the error-increase bypass, every silence scope,
 * recovery emission (`resolve` / `resolve_missing`), per-host aggregation, and
 * channel-failure isolation / recording. Uses a real temp SQLite database per
 * test (via `freshDb`) and an injectable clock for deterministic timing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AlertEngine,
  Notifier,
  NOTIFY_DEFAULT,
  createNotifierFromTask5,
  _alert_html_body,
  _alert_subject,
  _alert_text_body,
  _batch_event,
  _has_error_increase,
  _severity_rank,
  type AlertEngineOptions,
  type AlertsConfig,
  type NotifierChannels,
  type NotifierProtocol,
} from '../../src/alerts/engine';
import { SilenceRegistry } from '../../src/alerts/silence';
import type { AlertEvent } from '../../src/alerts/rules';
import {
  findLatestAlert,
  insertAlert,
  insertSilence,
  updateAlert,
  type AlertRow,
} from '../../src/storage/alerts';
import { cleanupStorageTests, freshDb, type TestDb } from '../storage-helpers';

afterEach(cleanupStorageTests);

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/** Sensible default alerts config; every test overrides only what it needs. */
function makeConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    enabled: true,
    desktop_notification: true,
    email: false,
    cooldown_minutes: 60,
    repeat_while_active: false,
    aggregate_by_host: false,
    notify_on_recovery: true,
    consecutive_periods: 1,
    webhook: null,
    ...overrides,
  };
}

/** Builds a config enabling exactly the named channels. */
function channelConfig(
  channels: string[],
  overrides: Partial<AlertsConfig> = {},
): AlertsConfig {
  return makeConfig({
    desktop_notification: channels.includes('desktop'),
    email: channels.includes('email'),
    webhook: channels.includes('webhook')
      ? { enabled: true, type: 'generic', url: 'https://example.test/hook' }
      : null,
    ...overrides,
  });
}

let eventSeq = 0;

/** Builds an AlertEvent; the fingerprint defaults to `<category>:<host>:cpu`. */
function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  eventSeq += 1;
  const host = overrides.host_name ?? 'gpu-01';
  const category = overrides.category ?? 'system';
  const fingerprint = overrides.fingerprint ?? `${category}:${host}:cpu`;
  return {
    host_name: host,
    category,
    severity: 'warning',
    title: `CPU 高 #${eventSeq}`,
    message: `CPU 使用率 95% (#${eventSeq})`,
    fingerprint,
    reasons: [],
    ...overrides,
  };
}

/** A `Notifier` whose named channels all accept the event. */
function acceptingNotifier(channels: string[] = ['desktop']): Notifier {
  const map: NotifierChannels = {};
  if (channels.includes('desktop')) map.desktop = () => true;
  if (channels.includes('email')) map.email = () => true;
  if (channels.includes('webhook')) map.webhook = () => true;
  return new Notifier(map);
}

interface RecordingNotifier extends NotifierProtocol {
  dispatched: AlertEvent[];
  batches: AlertEvent[][];
}

/** A notifier that records every dispatch / dispatchBatch call. */
function recordingNotifier(channels: string[] = ['desktop']): RecordingNotifier {
  const dispatched: AlertEvent[] = [];
  const batches: AlertEvent[][] = [];
  return {
    dispatched,
    batches,
    dispatch(event) {
      dispatched.push(event);
      return [...channels];
    },
    dispatchBatch(events) {
      batches.push(events);
      return [...channels];
    },
  };
}

/** A legacy notifier exposing only `dispatch` (no `dispatchBatch`). */
function legacyNotifier(): NotifierProtocol {
  return { dispatch: () => ['desktop'] };
}

/** Builds an engine with sensible defaults; pass overrides for the rest. */
function makeEngine(
  db: TestDb,
  overrides: Partial<AlertEngineOptions> = {},
): AlertEngine {
  return new AlertEngine({
    db,
    config: makeConfig(),
    notifier: acceptingNotifier(),
    ...overrides,
  });
}

/** A controllable clock for `now` overrides. */
function clock(start = '2026-01-01T00:00:00.000Z') {
  let current = new Date(start);
  return {
    now: () => current,
    advanceMs(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
  };
}

/** Every alert row, oldest first (for status / channel assertions). */
function allRows(db: TestDb): AlertRow[] {
  return db
    .prepare('SELECT * FROM alerts ORDER BY id ASC')
    .all() as AlertRow[];
}

/** Finds a row by fingerprint (tests always insert unique fingerprints). */
function rowByFingerprint(db: TestDb, fingerprint: string): AlertRow | undefined {
  return allRows(db).find((row) => row.fingerprint === fingerprint);
}

// ---------------------------------------------------------------------------
// Streak / consecutive-period gate
// ---------------------------------------------------------------------------

describe('consecutive-period (streak) gate', () => {
  it('warms up for N periods before notifying', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ consecutive_periods: 2 }),
      now: c.now,
    });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(0); // streak 1 < 2
    expect(await engine.process([ev])).toHaveLength(1); // streak 2 >= 2
  });

  it('resets on a bad -> good -> bad wobble', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ consecutive_periods: 2 }),
      now: c.now,
    });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(0); // streak 1
    expect(await engine.process([])).toHaveLength(0); // absent -> reset
    expect(await engine.process([ev])).toHaveLength(0); // streak 1 again
  });

  it('keeps notifying a sustained condition once past warm-up', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ consecutive_periods: 2, repeat_while_active: true }),
      now: c.now,
    });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(0); // streak 1
    expect(await engine.process([ev])).toHaveLength(1); // streak 2 -> notify
    c.advanceMs(61 * 60_000);
    expect(await engine.process([ev])).toHaveLength(1); // streak 3, cooldown elapsed
  });

  it('lets engine-generated recovery events bypass the gate', async () => {
    const { db } = freshDb();
    const c = clock();
    const rec = recordingNotifier();
    const fp = 'system:gpu-01:cpu';
    insertAlert(
      db,
      {
        host_name: 'gpu-01',
        category: 'system',
        severity: 'warning',
        title: 'old',
        message: 'old',
        fingerprint: fp,
      },
      { createdAt: c.now() },
    );
    // 5 periods would block a raw observation; recovery must still fire.
    const engine = makeEngine(db, {
      config: makeConfig({ consecutive_periods: 5 }),
      notifier: rec,
      now: c.now,
    });

    const out = await engine.resolve('gpu-01', 'system');
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
    expect(rec.dispatched).toHaveLength(1);
    expect(rec.dispatched[0].severity).toBe('info');
  });

  it('honours a per-host consecutive_periods override', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ consecutive_periods: 3 }),
      perHostRules: { 'gpu-01': { consecutive_periods: 1 } },
      now: c.now,
    });
    const ev = makeEvent({ host_name: 'gpu-01' });

    expect(await engine.process([ev])).toHaveLength(1); // override => immediate
  });
});

// ---------------------------------------------------------------------------
// Cooldown / de-duplication / acknowledgement
// ---------------------------------------------------------------------------

describe('cooldown and de-duplication', () => {
  it('suppresses a repeat inside the cooldown window', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(1);
    expect(await engine.process([ev])).toHaveLength(0); // inside cooldown
    c.advanceMs(30 * 60_000);
    expect(await engine.process([ev])).toHaveLength(0); // still inside
  });

  it('re-notifies after cooldown when repeat_while_active is on', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ repeat_while_active: true }),
      now: c.now,
    });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(1);
    c.advanceMs(61 * 60_000);
    expect(await engine.process([ev])).toHaveLength(1);
  });

  it('re-notifies an escalation after cooldown with repeat_while_active off', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const ev = makeEvent({ severity: 'warning', fingerprint: 'system:gpu-01:cpu' });

    expect(await engine.process([ev])).toHaveLength(1);
    c.advanceMs(61 * 60_000);
    const escalated = makeEvent({
      severity: 'critical',
      fingerprint: ev.fingerprint,
    });
    expect(await engine.process([escalated])).toHaveLength(1);
  });

  it('stays silent on a non-escalation after cooldown with repeat off', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const critical = makeEvent({ severity: 'critical', fingerprint: 'system:gpu-01:cpu' });

    expect(await engine.process([critical])).toHaveLength(1);
    c.advanceMs(61 * 60_000);
    const lower = makeEvent({ severity: 'warning', fingerprint: critical.fingerprint });
    expect(await engine.process([lower])).toHaveLength(0);
  });

  it('defaults cooldown to 60 minutes when unset', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: makeConfig({ cooldown_minutes: undefined }),
      now: c.now,
    });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(1);
    c.advanceMs(30 * 60_000);
    expect(await engine.process([ev])).toHaveLength(0); // 30 < 60
  });

  it('always notifies an error_increase via reasons', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(1);
    const noisy = { ...ev, reasons: ['error_increase'] };
    expect(await engine.process([noisy])).toHaveLength(1); // bypasses cooldown
  });

  it('always notifies an error_increase embedded in the fingerprint', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const ev = makeEvent({ fingerprint: 'system:gpu-01:error_increase' });

    expect(await engine.process([ev])).toHaveLength(1);
    expect(await engine.process([ev])).toHaveLength(1); // still bypasses
  });

  it('suppresses an acknowledged alert', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });
    const ev = makeEvent();

    expect(await engine.process([ev])).toHaveLength(1);
    const row = findLatestAlert(db, ev.fingerprint);
    expect(row).not.toBeNull();
    updateAlert(db, row!.id, { status: 'acknowledged' });
    expect(await engine.process([ev])).toHaveLength(0);
  });

  it('retries an alert whose prior attempt notified no channel', async () => {
    const { db } = freshDb();
    const c = clock();
    const ev = makeEvent();
    insertAlert(
      db,
      {
        host_name: ev.host_name,
        category: ev.category,
        severity: ev.severity,
        title: 'old',
        message: 'old',
        fingerprint: ev.fingerprint,
      },
      { createdAt: c.now() },
    );
    const engine = makeEngine(db, { config: makeConfig(), now: c.now });

    expect(await engine.process([ev])).toHaveLength(1);
    expect(findLatestAlert(db, ev.fingerprint)!.notified_channels).toBe('desktop');
  });

  it('does not consume the cooldown when a retry succeeded', async () => {
    const { db } = freshDb();
    const c = clock();
    const ev = makeEvent();
    let accept = false;
    const notifier: NotifierProtocol = {
      dispatch: () => (accept ? ['desktop'] : []),
    };
    const engine = makeEngine(db, {
      config: makeConfig(),
      notifier,
      now: c.now,
    });

    expect(await engine.process([ev])).toHaveLength(0); // persisted, no channel
    accept = true;
    // Same clock instant: proves the failed attempt did not burn the cooldown.
    expect(await engine.process([ev])).toHaveLength(1);
    expect(findLatestAlert(db, ev.fingerprint)!.notified_channels).toBe('desktop');
  });
});

// ---------------------------------------------------------------------------
// Silence scopes
// ---------------------------------------------------------------------------

describe('silence scopes', () => {
  function silenceWindow(c: ReturnType<typeof clock>) {
    const start = new Date(c.now().getTime() - 3_600_000);
    const end = new Date(c.now().getTime() + 3_600_000);
    return { start, end };
  }

  function engineWithSilences(db: TestDb, c: ReturnType<typeof clock>, extra: Partial<AlertEngineOptions> = {}) {
    return makeEngine(db, {
      config: channelConfig(['desktop']),
      silences: new SilenceRegistry(db),
      now: c.now,
      ...extra,
    });
  }

  it('suppresses an "all" scope silence and persists nothing', async () => {
    const { db } = freshDb();
    const c = clock();
    const { start, end } = silenceWindow(c);
    insertSilence(db, 'all', null, 'maint', start, end, 'tester');
    const engine = engineWithSilences(db, c);

    expect(await engine.process([makeEvent()])).toHaveLength(0);
    expect(allRows(db)).toHaveLength(0);
  });

  it('suppresses a host-scope silence only for that host', async () => {
    const { db } = freshDb();
    const c = clock();
    const { start, end } = silenceWindow(c);
    insertSilence(db, 'host', 'gpu-02', 'maint', start, end, 'tester');
    const engine = engineWithSilences(db, c);

    const out = await engine.process([
      makeEvent({ host_name: 'gpu-01' }),
      makeEvent({ host_name: 'gpu-02' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].host_name).toBe('gpu-01');
  });

  it('suppresses a group-scope silence using hostGroups', async () => {
    const { db } = freshDb();
    const c = clock();
    const { start, end } = silenceWindow(c);
    insertSilence(db, 'group', 'prod', 'maint', start, end, 'tester');
    const engine = engineWithSilences(db, c, { hostGroups: () => 'prod' });

    expect(await engine.process([makeEvent({ host_name: 'gpu-01' })])).toHaveLength(0);
  });

  it('suppresses a category-scope silence only for that category', async () => {
    const { db } = freshDb();
    const c = clock();
    const { start, end } = silenceWindow(c);
    insertSilence(db, 'category', 'disk', 'maint', start, end, 'tester');
    const engine = engineWithSilences(db, c);

    const out = await engine.process([
      makeEvent({ category: 'disk' }),
      makeEvent({ category: 'system' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('system');
  });

  it('suppresses a fingerprint-scope silence', async () => {
    const { db } = freshDb();
    const c = clock();
    const { start, end } = silenceWindow(c);
    const ev = makeEvent();
    insertSilence(db, 'fingerprint', ev.fingerprint, 'maint', start, end, 'tester');
    const engine = engineWithSilences(db, c);

    expect(await engine.process([ev])).toHaveLength(0);
  });

  it('ignores a silence whose window is not active yet', async () => {
    const { db } = freshDb();
    const c = clock();
    const start = new Date(c.now().getTime() + 3_600_000);
    const end = new Date(c.now().getTime() + 7_200_000);
    insertSilence(db, 'all', null, 'future', start, end, 'tester');
    const engine = engineWithSilences(db, c);

    expect(await engine.process([makeEvent()])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Recovery: resolve / resolve_missing
// ---------------------------------------------------------------------------

describe('resolve / resolve_missing', () => {
  it('marks a matching open alert resolved and emits an info recovery', async () => {
    const { db } = freshDb();
    const c = clock();
    const rec = recordingNotifier();
    const engine = makeEngine(db, { config: makeConfig(), notifier: rec, now: c.now });
    const ev = makeEvent();

    await engine.process([ev]); // dispatch #1
    const out = await engine.resolve('gpu-01', 'system');

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
    expect(rec.dispatched).toHaveLength(2); // recovery dispatched too
    expect(rec.dispatched[1].severity).toBe('info');

    const rows = allRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('resolved');
    expect(rows[1].fingerprint).toBe('recovery:gpu-01:system');
    expect(rows[1].severity).toBe('info');
  });

  it('returns [] when there is no open alert to resolve', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { now: c.now });

    expect(await engine.resolve('gpu-01', 'system')).toEqual([]);
  });

  it('does not dispatch the recovery when notify=false', async () => {
    const { db } = freshDb();
    const c = clock();
    const rec = recordingNotifier();
    const engine = makeEngine(db, { config: makeConfig(), notifier: rec, now: c.now });
    const ev = makeEvent();

    await engine.process([ev]);
    const out = await engine.resolve('gpu-01', 'system', { notify: false });

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
    expect(rec.dispatched).toHaveLength(1); // only the original event
    const rows = allRows(db);
    expect(rows).toHaveLength(1); // no recovery row inserted
    expect(rows[0].status).toBe('resolved');
  });

  it('resolve_missing closes a stale condition', async () => {
    const { db } = freshDb();
    const c = clock();
    const rec = recordingNotifier();
    const engine = makeEngine(db, { config: makeConfig(), notifier: rec, now: c.now });
    const ev = makeEvent();

    await engine.process([ev]);
    const out = await engine.resolve_missing('gpu-01', []);

    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('info');
    expect(rowByFingerprint(db, ev.fingerprint)!.status).toBe('resolved');
  });

  it('resolve_missing keeps conditions still in the active set', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { now: c.now });
    const ev = makeEvent();

    await engine.process([ev]);
    const out = await engine.resolve_missing('gpu-01', [ev.fingerprint]);
    expect(out).toEqual([]);
    expect(rowByFingerprint(db, ev.fingerprint)!.status).toBe('active');
  });

  it('resolve_missing never auto-resolves a skip_prefix', async () => {
    const { db } = freshDb();
    const c = clock();
    insertAlert(
      db,
      {
        host_name: 'gpu-01',
        category: 'system',
        severity: 'warning',
        title: 'manual',
        message: 'manual',
        fingerprint: 'user-added:gpu-01:x',
      },
      { createdAt: c.now() },
    );
    const engine = makeEngine(db, { now: c.now });

    const out = await engine.resolve_missing('gpu-01', [], {
      skip_prefixes: ['user-added'],
    });
    expect(out).toEqual([]);
    expect(rowByFingerprint(db, 'user-added:gpu-01:x')!.status).toBe('active');
  });

  it('resolve_missing scopes to a category when asked', async () => {
    const { db } = freshDb();
    const c = clock();
    insertAlert(
      db,
      {
        host_name: 'gpu-01',
        category: 'system',
        severity: 'warning',
        title: 'a',
        message: 'a',
        fingerprint: 'system:gpu-01:cpu',
      },
      { createdAt: c.now() },
    );
    insertAlert(
      db,
      {
        host_name: 'gpu-01',
        category: 'disk',
        severity: 'warning',
        title: 'b',
        message: 'b',
        fingerprint: 'disk:gpu-01:space',
      },
      { createdAt: c.now() },
    );
    const rec = recordingNotifier();
    const engine = makeEngine(db, { notifier: rec, now: c.now });

    const out = await engine.resolve_missing('gpu-01', [], { category: 'system' });
    expect(out).toHaveLength(1);
    expect(rowByFingerprint(db, 'system:gpu-01:cpu')!.status).toBe('resolved');
    expect(rowByFingerprint(db, 'disk:gpu-01:space')!.status).toBe('active');
  });

  it('resolve_missing also closes acknowledged rows', async () => {
    const { db } = freshDb();
    const c = clock();
    const ev = makeEvent();
    await makeEngine(db, { now: c.now }).process([ev]);
    const row = findLatestAlert(db, ev.fingerprint)!;
    updateAlert(db, row.id, { status: 'acknowledged' });

    const engine = makeEngine(db, { now: c.now });
    const out = await engine.resolve_missing('gpu-01', []);
    expect(out).toHaveLength(1);
    expect(rowByFingerprint(db, ev.fingerprint)!.status).toBe('resolved');
  });

  it('resolve_missing closes a recovery row without spawning another', async () => {
    const { db } = freshDb();
    const c = clock();
    insertAlert(
      db,
      {
        host_name: 'gpu-01',
        category: 'system',
        severity: 'info',
        title: 'recovered',
        message: 'recovered',
        fingerprint: 'recovery:gpu-01:system',
      },
      { createdAt: c.now() },
    );
    const engine = makeEngine(db, { now: c.now });

    const out = await engine.resolve_missing('gpu-01', []);
    expect(out).toEqual([]);
    const rows = allRows(db);
    expect(rows).toHaveLength(1); // no new recovery row
    expect(rows[0].status).toBe('resolved');
  });

  it('defaults recovery-notify on only for dispatchBatch-capable notifiers', async () => {
    const { db } = freshDb();
    const modern = makeEngine(db, { notifier: acceptingNotifier() });
    expect(modern._should_notify_recovery(NOTIFY_DEFAULT)).toBe(true);
    expect(modern._should_notify_recovery(false)).toBe(false);
    expect(modern._should_notify_recovery(true)).toBe(true);

    const legacy = makeEngine(db, { notifier: legacyNotifier() });
    expect(legacy._should_notify_recovery(NOTIFY_DEFAULT)).toBe(false);
  });

  it('open_alert_fingerprints lists open fingerprints, not resolved ones', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, { now: c.now });
    const ev = makeEvent();

    await engine.process([ev]);
    expect(engine.open_alert_fingerprints('gpu-01').has(ev.fingerprint)).toBe(true);

    await engine.resolve('gpu-01', 'system');
    expect(engine.open_alert_fingerprints('gpu-01').has(ev.fingerprint)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

describe('per-host aggregation', () => {
  it('merges several same-host alerts into one batch message', async () => {
    const { db } = freshDb();
    const c = clock();
    const seen: AlertEvent[] = [];
    const notifier = new Notifier({
      desktop: (event) => {
        seen.push(event);
        return true;
      },
    });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop'], { aggregate_by_host: true }),
      notifier,
      now: c.now,
    });

    const a = makeEvent({ fingerprint: 'system:gpu-01:cpu', title: 'CPU 高', severity: 'warning' });
    const b = makeEvent({ fingerprint: 'disk:gpu-01:space', title: '磁盘满', severity: 'critical' });
    const out = await engine.process([a, b]);

    expect(out).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe('主机 gpu-01 2 项告警');
    expect(seen[0].category).toBe('batch');
    expect(seen[0].severity).toBe('critical');
    expect(seen[0].message).toContain('CPU 高');
    expect(seen[0].message).toContain('磁盘满');

    const rows = allRows(db);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.notified_channels).toBe('desktop');
    }
  });

  it('falls back to a normal single dispatch for a one-event group', async () => {
    const { db } = freshDb();
    const c = clock();
    const seen: AlertEvent[] = [];
    const notifier = new Notifier({
      desktop: (event) => {
        seen.push(event);
        return true;
      },
    });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop'], { aggregate_by_host: true }),
      notifier,
      now: c.now,
    });
    const ev = makeEvent({ title: '单独告警' });

    const out = await engine.process([ev]);
    expect(out).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].title).toBe('单独告警'); // not re-wrapped as a batch
  });

  it('_batch_event keeps the highest severity and joins titles', () => {
    const warning = makeEvent({ severity: 'warning', title: '警告', message: 'm1' });
    const critical = makeEvent({ severity: 'critical', title: '严重', message: 'm2' });
    const batch = _batch_event([warning, critical]);

    expect(batch.title).toBe('主机 gpu-01 2 项告警');
    expect(batch.category).toBe('batch');
    expect(batch.severity).toBe('critical');
    expect(batch.fingerprint).toBe('batch:gpu-01:2');
    expect(batch.message).toContain('- [warning] 警告：m1');
    expect(batch.message).toContain('- [critical] 严重：m2');
  });
});

// ---------------------------------------------------------------------------
// Channel handling / failure isolation
// ---------------------------------------------------------------------------

describe('channel handling', () => {
  it('records only the channels that accepted when one fails', async () => {
    const { db } = freshDb();
    const c = clock();
    const notifier = new Notifier({
      desktop: () => true,
      email: () => {
        throw new Error('smtp down');
      },
    });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop', 'email']),
      notifier,
      now: c.now,
    });

    expect(await engine.process([makeEvent()])).toHaveLength(1);
    expect(allRows(db)[0].notified_channels).toBe('desktop');
  });

  it('records an empty channel string and returns [] when all fail', async () => {
    const { db } = freshDb();
    const c = clock();
    const notifier = new Notifier({ desktop: () => false });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop']),
      notifier,
      now: c.now,
    });

    expect(await engine.process([makeEvent()])).toEqual([]);
    const rows = allRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].notified_channels).toBe('');
  });

  it('tries channels in desktop -> email -> webhook order', async () => {
    const { db } = freshDb();
    const c = clock();
    const order: string[] = [];
    const notifier = new Notifier({
      desktop: () => {
        order.push('desktop');
        return true;
      },
      email: () => {
        order.push('email');
        return true;
      },
      webhook: () => {
        order.push('webhook');
        return true;
      },
    });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop', 'email', 'webhook']),
      notifier,
      now: c.now,
    });

    await engine.process([makeEvent()]);
    expect(order).toEqual(['desktop', 'email', 'webhook']);
  });

  it('stores accepted channels as a comma-joined string', async () => {
    const { db } = freshDb();
    const c = clock();
    const engine = makeEngine(db, {
      config: channelConfig(['desktop', 'email']),
      notifier: acceptingNotifier(['desktop', 'email']),
      now: c.now,
    });

    await engine.process([makeEvent()]);
    expect(allRows(db)[0].notified_channels).toBe('desktop,email');
  });

  it('wires the Task 5 senders through createNotifierFromTask5', async () => {
    const { db } = freshDb();
    const c = clock();
    const bridge = { notify: vi.fn() };
    const smtp = {
      host: 'smtp.test',
      port: 587,
      username: 'user',
      password: 'secret',
      useSsl: false,
      fromAddr: 'alerts@test',
      toAddrs: ['ops@test'],
    };
    const notifier = createNotifierFromTask5({
      smtp,
      bridge,
      emailSendOptions: { smtpFactory: () => ({ sendMail: async () => undefined }) },
    });
    const engine = makeEngine(db, {
      config: channelConfig(['desktop', 'email']),
      notifier,
      now: c.now,
    });

    expect(await engine.process([makeEvent()])).toHaveLength(1);
    expect(allRows(db)[0].notified_channels).toBe('desktop,email');
    expect(bridge.notify).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Misc: disabled config, helpers, templates
// ---------------------------------------------------------------------------

describe('disabled config and helpers', () => {
  it('is a no-op when alerts are disabled', async () => {
    const { db } = freshDb();
    const c = clock();
    const calls: AlertEvent[] = [];
    const notifier: NotifierProtocol = {
      dispatch: (event) => {
        calls.push(event);
        return ['desktop'];
      },
    };
    const engine = makeEngine(db, {
      config: makeConfig({ enabled: false }),
      notifier,
      now: c.now,
    });

    expect(await engine.process([makeEvent()])).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(allRows(db)).toHaveLength(0);
  });

  it('ranks severities info < warning < critical, default 0', () => {
    expect(_severity_rank('info')).toBe(0);
    expect(_severity_rank('warning')).toBe(1);
    expect(_severity_rank('critical')).toBe(2);
    expect(_severity_rank('unknown')).toBe(0);
    expect(_severity_rank(null)).toBe(0);
  });

  it('detects error_increase from reasons or fingerprint', () => {
    expect(_has_error_increase({ ...makeEvent(), reasons: ['error_increase'] })).toBe(true);
    expect(_has_error_increase(makeEvent({ fingerprint: 'x:error_increase' }))).toBe(true);
    expect(_has_error_increase(makeEvent({ fingerprint: 'x:cpu' }))).toBe(false);
  });

  it('renders subject, text body and an escaped HTML body', () => {
    const ev = makeEvent({
      host_name: 'gpu-09',
      category: 'disk',
      severity: 'critical',
      title: '磁盘 <满>',
      message: '使用率 "99%" & 高',
    });

    expect(_alert_subject(ev)).toBe('[critical] 磁盘 <满>');

    const text = _alert_text_body(ev);
    expect(text).toContain('主机: gpu-09');
    expect(text).toContain('类别: disk');
    expect(text).toContain('级别: critical');
    expect(text).toContain('标题: 磁盘 <满>');
    expect(text.split('\n').at(-1)).toBe('使用率 "99%" & 高');

    const html = _alert_html_body(ev);
    expect(html).toContain('&lt;满&gt;');
    expect(html).toContain('&quot;99%&quot;');
    expect(html).toContain('&amp;');
    expect(html).toContain('<th>主机</th>');
  });
});
