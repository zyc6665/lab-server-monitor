/** Scheduled maintenance tasks from P2-4: storage-sample + backup. */
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupStorageTests, freshDb } from '../storage-helpers';
import { buildScheduledTasks } from '../../src/runtime/wiring';
import { saveSection } from '../../src/config/service';
import { listStorageSamples } from '../../src/storage/storage-samples';
import type { AppConfig } from '../../src/config/config';

afterEach(() => {
  cleanupStorageTests();
});

function makeConfig(dataDir: string): AppConfig {
  return { dbPath: path.join(dataDir, 'servermonitor.db'), host: '127.0.0.1', port: 0, dataDir, logDir: dataDir, servers: [], appVersion: 'test' };
}

describe('P2-4 scheduled tasks', () => {
  it('records a storage sample and clamps to the injected directory size', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sm-sched-'));
    const { db } = freshDb();
    const tasks = buildScheduledTasks({
      db,
      config: makeConfig(dataDir),
      deps: { directorySize: () => 4242, now: () => new Date('2026-05-01T00:00:00Z') },
    });
    const sample = tasks.find((t) => t.name === 'storage-sample');
    expect(sample).toBeTruthy();
    await sample!.run();
    const rows = listStorageSamples(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.day).toBe('2026-05-01');
    expect(rows[0]!.data_dir_bytes).toBe(4242);
  });

  it('runs backup when scheduled and prunes to the keep count', async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sm-sched-'));
    const { db } = freshDb();
    saveSection(db, 'monitoring', { backup_schedule: 'daily', backup_keep: 2 });
    let day = 1;
    const tasks = buildScheduledTasks({
      db,
      config: makeConfig(dataDir),
      deps: {
        backupDatabase: async (_db, target) => {
          writeFileSync(target, 'db');
        },
        now: () => new Date(`2026-06-0${day}T00:00:00Z`),
      },
    });
    const backup = tasks.find((t) => t.name === 'backup');
    expect(backup).toBeTruthy();
    for (day = 1; day <= 4; day += 1) {
      await backup!.run();
    }
    const files = readdirSync(path.join(dataDir, 'backups')).filter((n) => n.endsWith('.db'));
    expect(files.sort()).toEqual(['auto-2026-06-03.db', 'auto-2026-06-04.db']);
  });

  it('omits the backup task when the schedule is off', () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), 'sm-sched-'));
    const { db } = freshDb();
    saveSection(db, 'monitoring', { backup_schedule: 'off' });
    const tasks = buildScheduledTasks({ db, config: makeConfig(dataDir), deps: { directorySize: () => 0 } });
    expect(tasks.some((t) => t.name === 'backup')).toBe(false);
  });
});
