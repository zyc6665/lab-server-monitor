import { describe, it, expect, afterEach } from 'vitest';

import {
  saveDiskHealth,
  getDiskHealth,
  getAllDiskHealth,
  pruneDiskHealth,
  type DiskHealthReportInput,
} from '../src/storage/disk';
import { cleanupStorageTests, freshDb, type TestDb } from './storage-helpers';

afterEach(cleanupStorageTests);

function count(db: TestDb, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}

/** A fully-populated disk-health report exercising every stored field. */
function sampleReport(overrides: Partial<DiskHealthReportInput> = {}): DiskHealthReportInput {
  return {
    host_name: 'host-a',
    collected_at: '2026-01-02T03:04:05.123000+00:00',
    status: 'warning',
    message: 'degraded',
    controllers: [
      {
        controller: 0,
        model: 'PERC H730',
        firmware: '25.5.9.0001',
        bbu_state: 'Optimal',
        health: 'ok',
        reasons: [],
      },
      {
        controller: 1,
        model: 'PERC H740',
        firmware: '50.9.4',
        bbu_state: null,
        health: 'warning',
        reasons: ['bbu_missing'],
      },
    ],
    virtual_drives: [
      {
        controller: 0,
        vd_id: 0,
        raid_level: 'RAID1',
        state: 'Optimal',
        size: '1.8 TB',
        health: 'ok',
        reasons: [],
      },
      {
        controller: 0,
        vd_id: 1,
        raid_level: 'RAID5',
        state: 'Degraded',
        size: '5.4 TB',
        health: 'critical',
        reasons: ['degraded', 'rebuild'],
      },
    ],
    physical_drives: [
      {
        controller: 0,
        enclosure: 32,
        slot: 0,
        did: 0,
        model: 'ST1800MM',
        serial: 'SN001',
        state: 'Online',
        media_errors: 0,
        other_errors: 2,
        predictive_failures: 0,
        smart_alert: false,
        temperature_c: 32,
        shield_counter: 0,
        health: 'ok',
        reasons: [],
      },
      {
        controller: 0,
        enclosure: 32,
        slot: 1,
        did: 1,
        model: 'ST1800MM',
        serial: 'SN002',
        state: 'Failed',
        media_errors: 15,
        other_errors: 0,
        predictive_failures: 3,
        smart_alert: true,
        temperature_c: 45,
        shield_counter: 7,
        health: 'critical',
        reasons: ['media_errors', 'smart_alert'],
      },
    ],
    ...overrides,
  };
}

/** Minimal one-row-per-table batch, for prune tests. */
function minimalReport(hostName: string, collectedAt: string): DiskHealthReportInput {
  return {
    host_name: hostName,
    collected_at: collectedAt,
    status: 'ok',
    message: null,
    controllers: [{ controller: 0, health: 'ok', reasons: [] }],
    virtual_drives: [{ controller: 0, vd_id: 0, health: 'ok', reasons: [] }],
    physical_drives: [
      { controller: 0, enclosure: 0, slot: 0, health: 'ok', reasons: [], smart_alert: null },
    ],
  };
}

describe('saveDiskHealth / getDiskHealth round-trip', () => {
  it('writes every field and reads the latest batch back', () => {
    const { db } = freshDb();
    const report = sampleReport();

    saveDiskHealth(db, report);

    const snapshot = getDiskHealth(db, 'host-a');
    expect(snapshot).not.toBeNull();
    expect(snapshot!.host_name).toBe('host-a');
    expect(snapshot!.collected_at).toBe('2026-01-02T03:04:05.123000+00:00');
    expect(snapshot!.status).toBe('warning');
    expect(snapshot!.message).toBe('degraded');

    expect(snapshot!.controllers).toEqual([
      {
        controller: 0,
        model: 'PERC H730',
        firmware: '25.5.9.0001',
        bbu_state: 'Optimal',
        health: 'ok',
        reasons: [],
      },
      {
        controller: 1,
        model: 'PERC H740',
        firmware: '50.9.4',
        bbu_state: null,
        health: 'warning',
        reasons: ['bbu_missing'],
      },
    ]);

    expect(snapshot!.virtual_drives).toHaveLength(2);
    expect(snapshot!.virtual_drives[1]).toEqual({
      controller: 0,
      vd_id: 1,
      raid_level: 'RAID5',
      state: 'Degraded',
      size: '5.4 TB',
      health: 'critical',
      reasons: ['degraded', 'rebuild'],
    });

    expect(snapshot!.physical_drives).toHaveLength(2);
    // smart_alert round-trips as a real boolean, not the stored 0/1.
    expect(snapshot!.physical_drives[0].smart_alert).toBe(false);
    expect(snapshot!.physical_drives[1]).toMatchObject({
      controller: 0,
      enclosure: 32,
      slot: 1,
      did: 1,
      model: 'ST1800MM',
      serial: 'SN002',
      state: 'Failed',
      media_errors: 15,
      other_errors: 0,
      predictive_failures: 3,
      smart_alert: true,
      temperature_c: 45,
      shield_counter: 7,
      health: 'critical',
      reasons: ['media_errors', 'smart_alert'],
    });

    expect(count(db, 'disk_health_snapshot')).toBe(1);
    expect(count(db, 'disk_controller_snapshot')).toBe(2);
    expect(count(db, 'disk_vd_snapshot')).toBe(2);
    expect(count(db, 'disk_pd_snapshot')).toBe(2);
  });

  it('serialises reasons exactly like Python json.dumps(ensure_ascii=False)', () => {
    const { db } = freshDb();
    saveDiskHealth(db, sampleReport());

    const pd = db
      .prepare(
        'SELECT reasons FROM disk_pd_snapshot WHERE host_name = ? AND slot = ?',
      )
      .get('host-a', 1) as { reasons: string };
    // Python default separators: space after the comma, raw UTF-8.
    expect(pd.reasons).toBe('["media_errors", "smart_alert"]');

    const vd = db
      .prepare('SELECT reasons FROM disk_vd_snapshot WHERE host_name = ? AND vd_id = ?')
      .get('host-a', 1) as { reasons: string };
    expect(vd.reasons).toBe('["degraded", "rebuild"]');

    // An empty reasons list is stored as `[]`, never NULL.
    const emptyReasons = db
      .prepare('SELECT reasons FROM disk_controller_snapshot WHERE host_name = ? AND controller = ?')
      .get('host-a', 0) as { reasons: string };
    expect(emptyReasons.reasons).toBe('[]');
  });

  it('stores smart_alert as 0/1 and NULL, never as a JSON boolean', () => {
    const { db } = freshDb();
    saveDiskHealth(db, sampleReport());

    const rows = db
      .prepare(
        'SELECT slot, smart_alert FROM disk_pd_snapshot WHERE host_name = ? ORDER BY slot',
      )
      .all('host-a') as Array<{ slot: number; smart_alert: number | null }>;
    expect(rows).toEqual([
      { slot: 0, smart_alert: 0 },
      { slot: 1, smart_alert: 1 },
    ]);

    // smart_alert omitted from the input stays NULL in the column.
    saveDiskHealth(
      db,
      sampleReport({
        collected_at: '2026-01-03T00:00:00.000000+00:00',
        physical_drives: [
          { controller: 0, enclosure: 1, slot: 2, health: 'ok', reasons: [] },
        ],
      }),
    );
    const nullRow = db
      .prepare('SELECT smart_alert FROM disk_pd_snapshot WHERE collected_at = ? AND slot = ?')
      .get('2026-01-03T00:00:00.000000+00:00', 2) as { smart_alert: number | null };
    expect(nullRow.smart_alert).toBeNull();
  });

  it('applies dataclass defaults for status and health when omitted', () => {
    const { db } = freshDb();
    saveDiskHealth(db, {
      host_name: 'host-a',
      collected_at: '2026-01-02T03:04:05.123000+00:00',
      controllers: [{ controller: 0 }],
      virtual_drives: [{ controller: 0, vd_id: 0 }],
      physical_drives: [{ controller: 0 }],
    });

    const snapshot = getDiskHealth(db, 'host-a')!;
    expect(snapshot.status).toBe('ok');
    expect(snapshot.message).toBeNull();
    expect(snapshot.controllers[0].health).toBe('unknown');
    expect(snapshot.virtual_drives[0].health).toBe('unknown');
    expect(snapshot.physical_drives[0].health).toBe('unknown');
  });

  it('renders a Date collected_at with microsecond precision', () => {
    const { db } = freshDb();
    saveDiskHealth(
      db,
      sampleReport({ collected_at: new Date('2026-01-02T03:04:05.123Z') }),
    );
    expect(getDiskHealth(db, 'host-a')!.collected_at).toBe(
      '2026-01-02T03:04:05.123000+00:00',
    );
  });

  it('replaces the component rows when the same host/timestamp is re-saved', () => {
    const { db } = freshDb();
    saveDiskHealth(db, sampleReport());
    saveDiskHealth(
      db,
      sampleReport({
        status: 'ok',
        message: null,
        controllers: [{ controller: 0, health: 'ok', reasons: [] }],
        virtual_drives: [],
        physical_drives: [],
      }),
    );

    // Header upserted (still one row), components fully replaced.
    expect(count(db, 'disk_health_snapshot')).toBe(1);
    expect(count(db, 'disk_controller_snapshot')).toBe(1);
    expect(count(db, 'disk_vd_snapshot')).toBe(0);
    expect(count(db, 'disk_pd_snapshot')).toBe(0);

    const snapshot = getDiskHealth(db, 'host-a')!;
    expect(snapshot.status).toBe('ok');
    expect(snapshot.message).toBeNull();
    expect(snapshot.controllers).toHaveLength(1);
    expect(snapshot.virtual_drives).toEqual([]);
    expect(snapshot.physical_drives).toEqual([]);
  });

  it('returns the newest batch and ignores older component rows', () => {
    const { db } = freshDb();
    saveDiskHealth(
      db,
      sampleReport({
        collected_at: '2026-01-01T00:00:00.000000+00:00',
        status: 'ok',
        physical_drives: [],
      }),
    );
    saveDiskHealth(
      db,
      sampleReport({
        collected_at: '2026-01-05T00:00:00.000000+00:00',
        status: 'critical',
        controllers: [{ controller: 0, health: 'critical', reasons: ['dead'] }],
        virtual_drives: [],
        physical_drives: [],
      }),
    );

    const snapshot = getDiskHealth(db, 'host-a')!;
    expect(snapshot.collected_at).toBe('2026-01-05T00:00:00.000000+00:00');
    expect(snapshot.status).toBe('critical');
    expect(snapshot.controllers).toEqual([
      {
        controller: 0,
        model: null,
        firmware: null,
        bbu_state: null,
        health: 'critical',
        reasons: ['dead'],
      },
    ]);
    expect(snapshot.physical_drives).toEqual([]);
  });

  it('returns null for an unknown host and [] for an empty database', () => {
    const { db } = freshDb();
    expect(getDiskHealth(db, 'nope')).toBeNull();
    expect(getAllDiskHealth(db)).toEqual([]);
  });
});

describe('getAllDiskHealth', () => {
  it('returns the latest batch per host, ordered by host name', () => {
    const { db } = freshDb();
    saveDiskHealth(
      db,
      sampleReport({
        host_name: 'host-c',
        collected_at: '2026-01-01T00:00:00.000000+00:00',
        status: 'ok',
      }),
    );
    saveDiskHealth(
      db,
      sampleReport({
        host_name: 'host-c',
        collected_at: '2026-01-02T00:00:00.000000+00:00',
        status: 'warning',
      }),
    );
    saveDiskHealth(
      db,
      sampleReport({
        host_name: 'host-a',
        collected_at: '2026-01-03T00:00:00.000000+00:00',
        status: 'critical',
      }),
    );

    const all = getAllDiskHealth(db);
    expect(all.map((item) => item.host_name)).toEqual(['host-a', 'host-c']);
    // host-c returns its newest batch only.
    expect(all[1].collected_at).toBe('2026-01-02T00:00:00.000000+00:00');
    expect(all[1].status).toBe('warning');
    expect(all[1].controllers).toHaveLength(2);
    expect(all[1].physical_drives).toHaveLength(2);
    expect(all[0].status).toBe('critical');
  });
});

describe('pruneDiskHealth', () => {
  const NOW = new Date('2026-11-25T00:00:00.000Z');

  it('deletes batches older than the retention window (all four tables)', () => {
    const { db } = freshDb();
    saveDiskHealth(db, minimalReport('host-a', '2026-11-10T00:00:00.000000+00:00')); // older than cutoff
    saveDiskHealth(db, minimalReport('host-a', '2026-11-24T00:00:00.000000+00:00')); // kept

    const counts = pruneDiskHealth(db, 7, 100, NOW);

    expect(counts).toEqual({
      disk_health_snapshot: 1,
      disk_controller_snapshot: 1,
      disk_vd_snapshot: 1,
      disk_pd_snapshot: 1,
    });
    expect(count(db, 'disk_health_snapshot')).toBe(1);
    expect(getDiskHealth(db, 'host-a')!.collected_at).toBe(
      '2026-11-24T00:00:00.000000+00:00',
    );
  });

  it('keeps only the newest maxBatchesPerHost batches per host', () => {
    const { db } = freshDb();
    for (const day of ['20', '21', '22', '23', '24']) {
      saveDiskHealth(db, minimalReport('host-a', `2026-11-${day}T00:00:00.000000+00:00`));
    }

    const counts = pruneDiskHealth(db, 3650, 2, NOW);

    expect(counts.disk_health_snapshot).toBe(3);
    expect(counts.disk_controller_snapshot).toBe(3);
    expect(counts.disk_vd_snapshot).toBe(3);
    expect(counts.disk_pd_snapshot).toBe(3);

    const remaining = db
      .prepare('SELECT collected_at FROM disk_health_snapshot ORDER BY collected_at')
      .all() as Array<{ collected_at: string }>;
    expect(remaining.map((row) => row.collected_at)).toEqual([
      '2026-11-23T00:00:00.000000+00:00',
      '2026-11-24T00:00:00.000000+00:00',
    ]);
  });

  it('applies the keep window independently per host', () => {
    const { db } = freshDb();
    for (const day of ['22', '23', '24']) {
      saveDiskHealth(db, minimalReport('host-a', `2026-11-${day}T00:00:00.000000+00:00`));
      saveDiskHealth(db, minimalReport('host-b', `2026-11-${day}T00:00:00.000000+00:00`));
    }

    const counts = pruneDiskHealth(db, 3650, 2, NOW);

    expect(counts.disk_health_snapshot).toBe(2); // one oldest batch per host
    expect(counts.disk_controller_snapshot).toBe(2);
    expect(count(db, 'disk_health_snapshot')).toBe(4);
  });

  it('removes orphaned component rows that have no header batch', () => {
    const { db } = freshDb();
    db.prepare(
      `INSERT INTO disk_controller_snapshot
         (collected_at, host_name, controller, model, firmware, bbu_state, health, reasons)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('2026-01-01T00:00:00.000000+00:00', 'ghost', 0, null, null, null, 'ok', '[]');

    const counts = pruneDiskHealth(db, 7, 100, NOW);

    expect(counts.disk_controller_snapshot).toBe(1);
    expect(counts.disk_health_snapshot).toBe(0);
    expect(count(db, 'disk_controller_snapshot')).toBe(0);
  });

  it('returns all-zero counts for an empty database', () => {
    const { db } = freshDb();
    expect(pruneDiskHealth(db, 7, 100, NOW)).toEqual({
      disk_health_snapshot: 0,
      disk_controller_snapshot: 0,
      disk_vd_snapshot: 0,
      disk_pd_snapshot: 0,
    });
  });

  it('clamps retentionDays and maxBatchesPerHost to at least 1', () => {
    const { db } = freshDb();
    saveDiskHealth(db, minimalReport('host-a', '2026-11-24T00:00:00.000000+00:00'));
    saveDiskHealth(db, minimalReport('host-a', '2026-11-23T00:00:00.000000+00:00'));

    // retentionDays=0 -> 1 day; maxBatches=0 -> keep 1 newest.
    const counts = pruneDiskHealth(db, 0, 0, NOW);
    expect(counts.disk_health_snapshot).toBe(1);
    expect(getDiskHealth(db, 'host-a')!.collected_at).toBe(
      '2026-11-24T00:00:00.000000+00:00',
    );
  });
});
