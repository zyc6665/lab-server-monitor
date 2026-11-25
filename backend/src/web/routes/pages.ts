/**
 * Lightweight pages — the Express equivalent of
 * `servermanage/web/routes/pages.py` (P2 Task 16).
 *
 * Registers the same five GET endpoints with the same template context keys:
 *
 *   GET /compute            compute summary page (`compute.html`)
 *   GET /api/compute        the same summary as JSON
 *   GET /my                 "my account" page (`my.html`)
 *   GET /api/my/summary     my-account summary as JSON
 *   GET /terminal           SSH terminal shell (`terminal.html`)
 *
 * The Python oracle builds its payloads with `compute_mod.build_compute_summary`
 * and `_core._build_my_summary`, neither of which has been ported to Node yet.
 * Both builders are therefore injectable through {@link PagesRouteDeps}; the
 * defaults below aggregate the *existing* host snapshots into the documented
 * field structure and leave anything that needs the un-ported GPU spec table or
 * user-monitoring payload empty (never fabricated).
 *
 * The middleware chain (setup / CSRF / auth / user-mode) is installed by
 * `createWebApp`; this module only registers handlers.
 */
import type { Express } from 'express';

import type { AppConfig, HostConfig } from '../../config/config';
import { loadEffectiveSettings } from '../../config/service';
import { getAllHostSnapshots } from '../../storage/hosts';
import { createTemplating, type Templating } from '../templating';
import { ENDPOINTS } from './registry';

type SqliteDatabase = import('better-sqlite3').Database;
type Obj = Record<string, unknown>;

/** MiB per GiB — the oracle stores GPU memory in MiB and reports GiB. */
const GB = 1024;

/** `_view_mode`: the effective dashboard mode (`admin` unless explicitly `user`). */
function readViewMode(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  return monitoring.mode === 'user' ? 'user' : 'admin';
}

/** `_member_account`: the configured member account (empty when unset). */
function readMemberAccount(db: SqliteDatabase): string {
  const settings = loadEffectiveSettings(db);
  const monitoring = asObj(settings.monitoring);
  const member = monitoring.member_account;
  return typeof member === 'string' ? member : '';
}

/** True when the process is the local desktop client (`SERVERMONITOR_DESKTOP`). */
function isDesktopMode(): boolean {
  return process.env.SERVERMONITOR_DESKTOP === '1';
}

/** Narrow an unknown value to a plain object. */
function asObj(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

/** Narrow an unknown value to an array. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Coerce an unknown value to a finite number (0 otherwise). */
function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Python `round(value, digits)` for the small one-decimal cases used here. */
function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Resolve one server by name. */
function findServer(servers: HostConfig[], name: string): HostConfig | undefined {
  return servers.find((server) => server.name === name);
}

/** A slug used only as a model key (mirrors `_anchor`/`anchor_slug`). */
function slug(value: string): string {
  const text = value ? String(value) : '';
  return text.replace(/[^0-9A-Za-z_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

interface ModelBucket {
  key: string;
  label: string;
  tier: string;
  tier_label: string;
  cards: number;
  vram_mb: number;
  used_mb: number;
  tflops: number;
  bandwidth_gbs: number;
  hosts: Set<string>;
}

interface UserBucket {
  user: string;
  memory_mb: number;
  processes: number;
  cardKeys: Set<string>;
  hosts: Set<string>;
  commands: Set<string>;
}

/**
 * Default compute summary builder.
 *
 * Aggregates `metrics.gpu_summary` (per-card) and `metrics.gpu_processes`
 * (per-process) from the latest host snapshots. Fields that depend on the
 * un-ported GPU spec table (`tflops`, `pf16`, `bandwidth_gbs`) stay `0` and are
 * called out in `notes` — the data is not fabricated.
 */
export function defaultBuildComputeSummary(
  db: SqliteDatabase,
  config: AppConfig,
): Obj {
  const snapshots = getAllHostSnapshots(db);
  const servers = config.servers;

  const modelBuckets = new Map<string, ModelBucket>();
  const userBuckets = new Map<string, UserBucket>();
  const hostRows: Obj[] = [];
  const idleHosts: string[] = [];

  let totalCards = 0;
  let totalVramMb = 0;
  let totalUsedMb = 0;

  for (const snapshot of snapshots) {
    const metrics = asObj(snapshot.metrics);
    const gpuRows = asArray(metrics.gpu_summary).map((row) => asObj(row));

    let hostCards = 0;
    let hostVramMb = 0;
    let hostUsedMb = 0;
    let hostUtilSum = 0;
    const hostModels = new Set<string>();

    for (const row of gpuRows) {
      const label = String(row.name ?? '未知');
      const totalMb = num(row.memory_total_mb);
      const usedMb = num(row.memory_used_mb);
      const util = num(row.utilization_percent);

      hostCards += 1;
      hostVramMb += totalMb;
      hostUsedMb += usedMb;
      hostUtilSum += util;
      hostModels.add(label);

      const key = slug(label);
      let bucket = modelBuckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          label,
          tier: 'unknown',
          tier_label: '未知',
          cards: 0,
          vram_mb: 0,
          used_mb: 0,
          tflops: 0,
          bandwidth_gbs: 0,
          hosts: new Set<string>(),
        };
        modelBuckets.set(key, bucket);
      }
      bucket.cards += 1;
      bucket.vram_mb += totalMb;
      bucket.used_mb += usedMb;
      bucket.hosts.add(snapshot.host_name);
    }

    for (const raw of asArray(metrics.gpu_processes)) {
      const proc = asObj(raw);
      const user = String(proc.username ?? '').trim();
      if (!user) {
        continue;
      }
      let bucket = userBuckets.get(user);
      if (!bucket) {
        bucket = {
          user,
          memory_mb: 0,
          processes: 0,
          cardKeys: new Set<string>(),
          hosts: new Set<string>(),
          commands: new Set<string>(),
        };
        userBuckets.set(user, bucket);
      }
      bucket.memory_mb += num(proc.memory_used_mb);
      bucket.processes += 1;
      bucket.cardKeys.add(`${snapshot.host_name}:${String(proc.index ?? '')}`);
      bucket.hosts.add(snapshot.host_name);
      const command = String(proc.command ?? '').trim();
      if (command) {
        bucket.commands.add(command);
      }
    }

    const server = findServer(servers, snapshot.host_name);
    const vramPct = hostVramMb > 0 ? roundTo((hostUsedMb / hostVramMb) * 100, 1) : 0;
    const utilAvg = hostCards > 0 ? roundTo(hostUtilSum / hostCards, 1) : 0;
    const idle = hostCards > 0 && utilAvg <= 5 && vramPct < 10;
    if (idle) {
      idleHosts.push(snapshot.host_name);
    }

    hostRows.push({
      name: snapshot.host_name,
      address: server?.host ?? '',
      group: server?.group || '未分组',
      cards: hostCards,
      vram_gb: roundTo(hostVramMb / GB, 2),
      used_gb: roundTo(hostUsedMb / GB, 2),
      vram_pct: vramPct,
      util_avg: utilAvg,
      tflops: 0,
      collected_at: snapshot.collected_at,
      models: [...hostModels],
      idle,
    });

    totalCards += hostCards;
    totalVramMb += hostVramMb;
    totalUsedMb += hostUsedMb;
  }

  const models = [...modelBuckets.values()]
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      tier: bucket.tier,
      tier_label: bucket.tier_label,
      cards: bucket.cards,
      vram_gb: roundTo(bucket.vram_mb / GB, 2),
      used_gb: roundTo(bucket.used_mb / GB, 2),
      tflops: bucket.tflops,
      bandwidth_gbs: bucket.bandwidth_gbs,
      hosts: [...bucket.hosts],
      share: totalVramMb > 0 ? roundTo((bucket.vram_mb / totalVramMb) * 100, 1) : 0,
    }))
    .sort((a, b) => b.cards - a.cards);

  const users = [...userBuckets.values()]
    .map((bucket) => ({
      user: bucket.user,
      memory_gb: roundTo(bucket.memory_mb / GB, 2),
      share: totalUsedMb > 0 ? roundTo((bucket.memory_mb / totalUsedMb) * 100, 1) : 0,
      cards: bucket.cardKeys.size,
      processes: bucket.processes,
      hosts: [...bucket.hosts],
      command: [...bucket.commands][0] ?? '',
      peak_gb: 0,
    }))
    .sort((a, b) => b.memory_gb - a.memory_gb);

  return {
    totals: {
      cards: totalCards,
      vram_gb: roundTo(totalVramMb / GB, 2),
      used_gb: roundTo(totalUsedMb / GB, 2),
      tflops: 0,
      free_gb: roundTo(Math.max(totalVramMb - totalUsedMb, 0) / GB, 2),
      vram_pct: totalVramMb > 0 ? roundTo((totalUsedMb / totalVramMb) * 100, 1) : 0,
      pf16: 0,
      bandwidth_gbs: 0,
    },
    models,
    hosts: hostRows,
    users,
    idle_hosts: idleHosts,
    notes: [
      '算力型号规格表（FP16 峰值 / 带宽）尚未迁移，tflops / pf16 / bandwidth_gbs 暂为 0（TODO: P2 compute 模块移植）。',
      'GPU 数据取自最近一次主机轮询快照。',
      '空闲主机：GPU 平均利用率 ≤5% 且显存占用 <10%。',
    ],
  };
}

/**
 * Default my-account summary builder.
 *
 * `_build_my_summary` (per-host member account status) has not been ported, so
 * this returns the documented empty structure — mode + member plus zeroed
 * counters — rather than fabricating per-host rows. Replace via
 * {@link PagesRouteDeps.buildMySummary} once the user-monitoring payload lands.
 */
export function defaultBuildMySummary(
  db: SqliteDatabase,
  _config: AppConfig,
): Obj {
  return {
    mode: readViewMode(db),
    member: readMemberAccount(db),
    // TODO(compute/users port): populate hosts[] from _build_users_payload.
    hosts: [],
    summary: {
      hosts: 0,
      present: 0,
      missing: 0,
      issues: 0,
      host_errors: 0,
      home_bytes: 0,
      data_bytes: 0,
    },
  };
}

/** Injected dependencies. Only `db` + `config` are required. */
export interface PagesRouteDeps {
  /** Open SQLite handle (snapshots + settings). */
  db: SqliteDatabase;
  /** Resolved runtime config (servers, app version, paths). */
  config: AppConfig;
  /** Pre-built templating bundle (defaults to a fresh one). */
  templating?: Templating;
  /** `APP_VERSION` used by the templating bundle when `templating` is absent. */
  appVersion?: string;
  /**
   * Compute-summary builder. Defaults to {@link defaultBuildComputeSummary}.
   * The Python `compute_mod.build_compute_summary` is not ported yet.
   */
  buildComputeSummary?: (db: SqliteDatabase, config: AppConfig) => unknown;
  /**
   * My-account summary builder. Defaults to {@link defaultBuildMySummary}.
   * The Python `_core._build_my_summary` is not ported yet.
   */
  buildMySummary?: (db: SqliteDatabase, config: AppConfig) => unknown;
}

/**
 * Registers the compute / my / terminal pages and their JSON APIs on `app`.
 *
 * @param app  Express application (middleware chain already installed).
 * @param deps Open DB handle, resolved config and optional builder/templating
 *             overrides.
 */
export function registerPagesRoutes(app: Express, deps: PagesRouteDeps): void {
  const { db, config } = deps;
  const templating = deps.templating ?? createTemplating({ appVersion: deps.appVersion });
  const buildCompute = deps.buildComputeSummary ?? defaultBuildComputeSummary;
  const buildMy = deps.buildMySummary ?? defaultBuildMySummary;

  const computeSummary = (): unknown => buildCompute(db, config);

  app.get(ENDPOINTS.compute_page, (_req, res) => {
    templating.renderPage(res, 'compute.html', {
      active_page: 'compute',
      summary: computeSummary(),
    });
  });

  app.get(ENDPOINTS.api_compute, (_req, res) => {
    res.json(computeSummary());
  });

  app.get(ENDPOINTS.my_page, (_req, res) => {
    templating.renderPage(res, 'my.html', {
      active_page: 'my',
      member: readMemberAccount(db),
      mode: readViewMode(db),
    });
  });

  app.get(ENDPOINTS.api_my_summary, (_req, res) => {
    res.json(buildMy(db, config));
  });

  app.get(ENDPOINTS.terminal_page, (_req, res) => {
    const hosts = config.servers.map((server) => ({
      name: server.name,
      host: server.host,
      group: server.group,
    }));
    templating.renderPage(res, 'terminal.html', {
      active_page: 'terminal',
      hosts,
      desktop_mode: isDesktopMode(),
    });
  });
}
