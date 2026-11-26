/**
 * 报表预览 / 立即发送 / 发送历史（P2-2，M5）。
 *
 *   GET  /api/reports/preview?variant=technical|executive|weekly
 *   GET  /api/reports/history
 *   POST /api/reports/send          { variant }
 *   GET  /reports                   报表页（`reports.html`）
 *
 * 预览默认按需采集一次最新快照再渲染（与日报任务一致）；测试可通过
 * `deps.buildReports` / `deps.sendReport` 注入桩，避免真实 SSH/SMTP。
 */
import type { Express, Request, Response } from 'express';

import type { AppConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import { SECRET_SMTP_PASSWORD } from '../../config/secrets';
import { readSecretText } from '../../config/admin';
import {
  buildMessage,
  sendReport as defaultSendReport,
  type SmtpConfig,
} from '../../alerts/mailer';
import {
  buildDailyReport,
  generateWeeklyReport,
} from '../../report/assemble';
import { renderReport as defaultRenderReport } from '../../report/render';
import { collectAllHosts } from '../../collect/collectors';
import { recordReportRun, listReportRuns } from '../../storage/report-runs';
import { createTemplating, type Templating } from '../templating';

type SqliteDatabase = import('better-sqlite3').Database;

export type ReportVariant = 'technical' | 'executive' | 'weekly';

const VARIANTS: ReportVariant[] = ['technical', 'executive', 'weekly'];

export interface BuiltReports {
  daily: ReturnType<typeof buildDailyReport>;
  weekly: ReturnType<typeof generateWeeklyReport>;
}

export interface ReportsRouteDeps {
  db: SqliteDatabase;
  config: AppConfig;
  templating?: Templating;
  appVersion?: string;
  /** Build the underlying report payloads (defaults to a real collection). */
  buildReports?: (db: SqliteDatabase, config: AppConfig) => Promise<BuiltReports>;
  /** Deliver a rendered message (defaults to the mailer). */
  sendReport?: typeof defaultSendReport;
  /** Render a report (defaults to `report/render.ts`). */
  renderReport?: typeof defaultRenderReport;
}

type Obj = Record<string, unknown>;

function isPlainObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(settings: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = settings[name];
  return isPlainObject(value) ? value : {};
}

function readString(obj: Record<string, unknown>, key: string, fallback: string): string {
  const value = obj[key];
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function parseVariant(raw: unknown): ReportVariant | null {
  return VARIANTS.includes(raw as ReportVariant) ? (raw as ReportVariant) : null;
}

async function defaultBuildReports(db: SqliteDatabase, config: AppConfig): Promise<BuiltReports> {
  const settings = loadEffectiveSettings(db) as unknown as Record<string, unknown>;
  const report = section(settings, 'report');
  const monitoring = section(settings, 'monitoring');
  const subjectPrefix = readString(report, 'subject_prefix', '[Server Daily Report]');
  const tz = readString(monitoring, 'timezone', 'UTC');

  const reports = await collectAllHosts(
    { servers: config.servers, monitoring: { stage_retries: 1 } },
    {},
  );
  const generatedAt = new Date().toISOString();
  const daily = buildDailyReport(reports, { generatedAt, subjectPrefix });
  const weekly = generateWeeklyReport(db, { tz });
  return { daily, weekly };
}

/** Resolve the SMTP transport from settings + DB secrets (mirrors wiring). */
function resolveSmtpConfig(db: SqliteDatabase, settings: Record<string, unknown>): SmtpConfig | null {
  const smtp = section(settings, 'smtp');
  const host = readString(smtp, 'host', '').trim();
  if (host === '') return null;
  const port = typeof smtp.port === 'number' ? smtp.port : 587;
  const username = readString(smtp, 'username', '');
  const useSsl = smtp.use_ssl === true;
  const fromAddr = readString(smtp, 'from_addr', '');
  const toAddrs = Array.isArray(smtp.to_addrs)
    ? (smtp.to_addrs as unknown[]).map((v) => String(v))
    : [];
  return {
    host,
    port,
    username,
    password: readSecretText(db, SECRET_SMTP_PASSWORD) ?? '',
    useSsl,
    fromAddr,
    toAddrs,
  };
}

export function registerReportsRoutes(app: Express, deps: ReportsRouteDeps): void {
  const templating =
    deps.templating ?? createTemplating({ appVersion: deps.appVersion ?? deps.config.appVersion });
  const build = deps.buildReports ?? defaultBuildReports;
  const render = deps.renderReport ?? defaultRenderReport;
  const send = deps.sendReport ?? defaultSendReport;

  const preview = async (req: Request, res: Response): Promise<void> => {
    const variant = parseVariant(req.query.variant);
    if (variant === null) {
      res.status(400).json({ error: 'invalid_variant' });
      return;
    }
    let built: BuiltReports;
    try {
      built = await build(deps.db, deps.config);
    } catch (err) {
      res.status(500).json({ error: 'preview_failed', message: (err as Error).message });
      return;
    }
    const source = variant === 'weekly' ? built.weekly : built.daily;
    const rendered = render(source as never, variant);
    res.json({ variant, subject: rendered.subject, text: rendered.textBody, html: rendered.htmlBody });
  };

  const history = (_req: Request, res: Response): void => {
    res.json({ runs: listReportRuns(deps.db, 50) });
  };

  const sendNow = async (req: Request, res: Response): Promise<void> => {
    const body = req.body ?? {};
    const variant = parseVariant((body as Record<string, unknown>).variant);
    if (variant === null) {
      res.status(400).json({ error: 'invalid_variant' });
      return;
    }
    const settings = loadEffectiveSettings(deps.db) as unknown as Record<string, unknown>;
    const smtp = resolveSmtpConfig(deps.db, settings);
    const needsSecret = smtp !== null && smtp.username.trim() !== '';
    const smtpReady = smtp !== null && (!needsSecret || (smtp.password ?? '') !== '');
    if (!smtpReady) {
      res.status(400).json({ error: 'smtp_not_configured', message: '尚未配置 SMTP 邮件服务器' });
      return;
    }
    const kind = variant === 'weekly' ? 'weekly' : 'daily';
    let built: BuiltReports;
    try {
      built = await build(deps.db, deps.config);
      const source = variant === 'weekly' ? built.weekly : built.daily;
      const rendered = render(source as never, variant);
      await send(
        smtp,
        buildMessage({
          subject: rendered.subject,
          fromAddr: smtp.fromAddr,
          toAddrs: smtp.toAddrs,
          textBody: rendered.textBody,
          htmlBody: rendered.htmlBody,
        }),
      );
      recordReportRun(deps.db, { kind, variant, status: 'sent', recipients: smtp.toAddrs });
      res.json({ ok: true, variant, subject: rendered.subject });
    } catch (err) {
      const message = (err as Error).message;
      try {
        recordReportRun(deps.db, { kind, variant, status: 'error', error: message, recipients: smtp.toAddrs });
      } catch {
        /* history write must not mask the send error */
      }
      res.status(502).json({ error: 'send_failed', message });
    }
  };

  const page = (_req: Request, res: Response): void => {
    templating.renderPage(res, 'reports.html', { active_page: 'reports' });
  };

  app.get('/api/reports/preview', preview);
  app.get('/api/reports/history', history);
  app.post('/api/reports/send', sendNow);
  app.get('/reports', page);
}
