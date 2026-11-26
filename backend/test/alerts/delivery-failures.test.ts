import { afterEach, describe, expect, it } from 'vitest';

import {
  AlertEngine,
  Notifier,
  type AlertsConfig,
  type ChannelAdapter,
} from '../../src/alerts/engine';
import type { AlertEvent } from '../../src/alerts/rules';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { listDeliveryFailures } from '../../src/storage/alert-delivery';

type Db = ReturnType<typeof openDatabase>;

function open(): Db {
  const db = openDatabase(':memory:');
  initSchema(db);
  return db;
}

function makeConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    enabled: true,
    desktop_notification: true,
    email: true,
    cooldown_minutes: 60,
    repeat_while_active: false,
    aggregate_by_host: false,
    notify_on_recovery: true,
    consecutive_periods: 1,
    webhook: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    host_name: 'gpu-01',
    category: 'system',
    severity: 'warning',
    title: 'cpu high',
    message: 'cpu usage above threshold',
    fingerprint: 'system:gpu-01:cpu',
    reasons: [],
    ...overrides,
  };
}

function rows(db: Db): Array<{ id: number; notified_channels: string | null }> {
  return db
    .prepare('SELECT id, notified_channels FROM alerts ORDER BY id')
    .all() as Array<{ id: number; notified_channels: string | null }>;
}

const accepting: ChannelAdapter = () => true;
const throwing: ChannelAdapter = () => {
  throw new Error('smtp down');
};

let db: Db | null = null;

afterEach(() => {
  if (db) {
    db.close();
    db = null;
  }
});

describe('AlertEngine delivery-failure recording', () => {
  it('records only the channels that threw', async () => {
    db = open();
    const notifier = new Notifier({ desktop: accepting, email: throwing });
    const engine = new AlertEngine({ db, config: makeConfig(), notifier });

    await engine.process([makeEvent()]);

    const [alert] = rows(db);
    expect(alert.notified_channels).toBe('desktop');

    const failures = listDeliveryFailures(db);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      alertId: alert.id,
      channel: 'email',
      error: 'smtp down',
    });
  });

  it('records nothing when every channel succeeds', async () => {
    db = open();
    const notifier = new Notifier({ desktop: accepting, email: accepting });
    const engine = new AlertEngine({ db, config: makeConfig(), notifier });

    await engine.process([makeEvent()]);

    const [alert] = rows(db);
    expect(alert.notified_channels).toBe('desktop,email');
    expect(listDeliveryFailures(db)).toHaveLength(0);
  });

  it('records a batch channel failure against each persisted alert', async () => {
    db = open();
    const notifier = new Notifier({ desktop: accepting, email: throwing });
    const engine = new AlertEngine({
      db,
      config: makeConfig({ aggregate_by_host: true }),
      notifier,
    });

    await engine.process([
      makeEvent({ fingerprint: 'system:gpu-01:cpu', category: 'system' }),
      makeEvent({ fingerprint: 'system:gpu-01:mem', category: 'memory', title: 'mem high' }),
    ]);

    const alerts = rows(db);
    expect(alerts).toHaveLength(2);
    const failures = listDeliveryFailures(db);
    expect(failures.map((row) => row.alertId).sort()).toEqual(alerts.map((row) => row.id).sort());
    expect(failures.every((row) => row.channel === 'email')).toBe(true);
  });

  it('keeps notified_channels empty when every channel throws', async () => {
    db = open();
    const notifier = new Notifier({ desktop: throwing, email: throwing });
    const engine = new AlertEngine({ db, config: makeConfig(), notifier });

    const notified = await engine.process([makeEvent()]);

    expect(notified).toEqual([]);
    const [alert] = rows(db);
    expect(alert.notified_channels).toBe('');
    expect(listDeliveryFailures(db)).toHaveLength(2);
  });
});
