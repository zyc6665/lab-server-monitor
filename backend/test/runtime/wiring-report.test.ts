/**
 * Tests for the P5 Task 11a report wiring (`runtime/wiring.ts` daily/weekly
 * tasks). Everything is injected — fake collector, fake renderer, fake sender —
 * so no SSH, SMTP or template rendering happens here.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config/config';
import type { HostReport } from '../../src/collect/types';
import type { DailyReport, WeeklyReport } from '../../src/report/model';
import type { ReportVariant } from '../../src/report/render';
import type { MailMessage, SmtpConfig } from '../../src/alerts/mailer';
import {
  buildScheduledTasks,
  type SchedulerWiringDeps,
} from '../../src/runtime/wiring';
import { saveAppSettings } from '../../src/storage/settings';
import { cleanupStorageTests, freshDb, type TestDb } from '../storage-helpers';

const tempDirs: string[] = [];

afterEach(() => {
  cleanupStorageTests();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(): AppConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'sm-report-wiring-'));
  tempDirs.push(dir);
  return {
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
    dataDir: dir,
    logDir: dir,
    servers: [],
    appVersion: 'test',
  };
}

function hostReport(): HostReport {
  return {
    hostName: 'alpha',
    host: '10.0.0.1',
    success: true,
    metrics: null,
    errors: [],
    checks: [],
    users: [],
  } as unknown as HostReport;
}

function configureSmtp(db: TestDb): void {
  saveAppSettings(db, 'smtp', {
    host: 'smtp.example.com',
    port: 587,
    from_addr: 'bot@example.com',
    to_addrs: ['ops@example.com'],
  });
}

interface Recorded {
  deps: SchedulerWiringDeps;
  collects: unknown[];
  persists: unknown[];
  renders: Array<{ report: DailyReport | WeeklyReport; variant: ReportVariant }>;
  sends: Array<{ smtp: SmtpConfig; message: MailMessage }>;
}

function recordingDeps(overrides: Partial<SchedulerWiringDeps> = {}): Recorded {
  const collects: unknown[] = [];
  const persists: unknown[] = [];
  const renders: Recorded['renders'] = [];
  const sends: Recorded['sends'] = [];
  const deps: SchedulerWiringDeps = {
    collectAllHosts: async (collectorConfig) => {
      collects.push(collectorConfig);
      return [hostReport()];
    },
    persistReports: (_db, reports, options) => {
      persists.push({ reports, options });
    },
    renderReport: (report, variant) => {
      renders.push({ report, variant });
      return { subject: `subj:${variant}`, textBody: 'text-body', htmlBody: 'html-body' };
    },
    sendReport: async (smtp, message) => {
      sends.push({ smtp, message });
    },
    pruneRetention: () => ({}),
    cleanupLogs: () => ({ deleted: 0, bytes: 0 }),
    now: () => new Date('2024-01-10T12:00:00Z'),
    ...overrides,
  };
  return { deps, collects, persists, renders, sends };
}

function taskNamed(tasks: ReturnType<typeof buildScheduledTasks>, name: string) {
  const task = tasks.find((candidate) => candidate.name === name);
  expect(task, `task ${name}`).toBeDefined();
  return task as NonNullable<typeof task>;
}

describe('daily-report task', () => {
  it('collects, persists, renders technical and emails it', async () => {
    const { db } = freshDb();
    configureSmtp(db);
    const config = makeConfig();
    const rec = recordingDeps();

    const task = taskNamed(buildScheduledTasks({ db, config, deps: rec.deps }), 'daily-report');
    await expect(task.run()).resolves.toBe('sent daily report: subj:technical');

    expect(rec.collects).toHaveLength(1);
    expect(rec.persists).toHaveLength(1);
    expect(rec.renders.map((entry) => entry.variant)).toEqual(['technical']);
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0].smtp.host).toBe('smtp.example.com');
    expect(rec.sends[0].message.to).toBe('ops@example.com');
    expect(rec.sends[0].message.subject).toBe('subj:technical');

    const daily = rec.renders[0].report as DailyReport;
    expect(daily.reports).toHaveLength(1);
    expect(daily.subjectPrefix).toBe('[Server Daily Report]');
  });

  it('sends a second executive variant when report.executive.enabled', async () => {
    const { db } = freshDb();
    configureSmtp(db);
    saveAppSettings(db, 'report', {
      executive: {
        enabled: true,
        subject_prefix: '[Leader Summary]',
        to_addrs: ['boss@example.com'],
      },
    });
    const config = makeConfig();
    const rec = recordingDeps();

    const task = taskNamed(buildScheduledTasks({ db, config, deps: rec.deps }), 'daily-report');
    await expect(task.run()).resolves.toBe('sent daily report: subj:technical');

    expect(rec.renders.map((entry) => entry.variant)).toEqual(['technical', 'executive']);
    expect(rec.sends).toHaveLength(2);
    expect(rec.sends[1].message.to).toBe('boss@example.com');
    expect(rec.sends[1].message.subject).toBe('subj:executive');
    const executive = rec.renders[1].report as DailyReport;
    expect(executive.subjectPrefix).toBe('[Leader Summary]');
  });

  it('persists the snapshot but skips rendering and sending when SMTP is absent', async () => {
    const { db } = freshDb();
    const config = makeConfig();
    const rec = recordingDeps();

    const task = taskNamed(buildScheduledTasks({ db, config, deps: rec.deps }), 'daily-report');
    await expect(task.run()).resolves.toBe('skipped: smtp not configured');

    expect(rec.collects).toHaveLength(1);
    expect(rec.persists).toHaveLength(1);
    expect(rec.renders).toHaveLength(0);
    expect(rec.sends).toHaveLength(0);
  });
});

describe('weekly-report task', () => {
  it('generates from the DB, renders the weekly variant and emails it', async () => {
    const { db } = freshDb();
    configureSmtp(db);
    const config = makeConfig();
    const rec = recordingDeps();

    const task = taskNamed(buildScheduledTasks({ db, config, deps: rec.deps }), 'weekly-report');
    await expect(task.run()).resolves.toBe('sent weekly report: subj:weekly');

    expect(rec.collects).toHaveLength(0);
    expect(rec.renders.map((entry) => entry.variant)).toEqual(['weekly']);
    expect(rec.sends).toHaveLength(1);
    expect(rec.sends[0].message.to).toBe('ops@example.com');
    expect(rec.sends[0].message.subject).toBe('subj:weekly');

    const weekly = rec.renders[0].report as WeeklyReport;
    expect(weekly.weekStart).toBe('2024-01-01');
    expect(weekly.weekEnd).toBe('2024-01-07');
    expect(weekly.subjectPrefix).toBe('[Server Weekly Report]');
  });

  it('renders first, then skips sending when SMTP is absent (oracle order)', async () => {
    const { db } = freshDb();
    const config = makeConfig();
    const rec = recordingDeps();

    const task = taskNamed(buildScheduledTasks({ db, config, deps: rec.deps }), 'weekly-report');
    await expect(task.run()).resolves.toBe('skipped: smtp not configured');

    expect(rec.renders.map((entry) => entry.variant)).toEqual(['weekly']);
    expect(rec.sends).toHaveLength(0);
  });
});
