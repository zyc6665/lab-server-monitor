/**
 * Host health diagnostics + per-day alert buckets — the Node port of
 * `servermanage/diagnostics.py` (`build_host_diagnostics`,
 * `summarize_diagnostics`) and the `_host_alert_days` helper from
 * `servermanage/web/routes/_core.py`.
 *
 * The functions are read-only: they turn one `_build_host_detail` payload into
 * a list of graded conclusion rows (freshness / CPU / load / memory / disk /
 * GPU / temperature / service checks / disk array / accounts / collection
 * success), most-severe first, plus a small `{crit, warn, ok, attention}`
 * summary for the card badge. Field names, Chinese copy, thresholds and
 * ordering are byte-aligned with the Python oracle.
 */

type Obj = Record<string, unknown>;

export type DiagnosticLevel = 'ok' | 'warn' | 'crit';

export interface DiagnosticRow {
  key: string;
  level: DiagnosticLevel;
  title: string;
  detail: string;
  hint: string;
}

export interface DiagnosticsSummary {
  crit: number;
  warn: number;
  ok: number;
  attention: number;
}

export interface AlertDay {
  key: string;
  label: string;
  total: number;
  critical: number;
  warning: number;
  info: number;
  height: number;
}

const LEVEL_OK: DiagnosticLevel = 'ok';
const LEVEL_WARN: DiagnosticLevel = 'warn';
const LEVEL_CRIT: DiagnosticLevel = 'crit';

const LEVEL_WEIGHT: Record<DiagnosticLevel, number> = {
  crit: 0,
  warn: 1,
  ok: 2,
};

/** Python `round()` — round-half-to-even (banker's rounding). */
function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Python `f"{value:.{digits}f}"` (banker's rounding, mirrors overview.ts). */
function fixed(value: number, digits: number): string {
  const negative = value < 0;
  const factor = 10 ** digits;
  const rounded = roundHalfEven(Math.abs(value) * factor);
  let text = String(rounded);
  if (digits > 0) {
    if (text.length <= digits) {
      text = '0'.repeat(digits - text.length + 1) + text;
    }
    text = `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
  }
  return negative ? `-${text}` : text;
}

/** `_number`: `None`/`""` → `null`; otherwise float of the trimmed `%`-suffixed value. */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(String(value).trim().replace(/%$/, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Python `str(value)` (used where the oracle stringifies a possibly-missing value). */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function asObj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Obj)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function row(key: string, level: DiagnosticLevel, title: string, detail: string, hint = ''): DiagnosticRow {
  return { key, level, title, detail, hint };
}

/** `_parse_time`: `datetime.fromisoformat(text.replace("Z","+00:00"))`, naive → UTC. */
export function parseTime(value: unknown): Date | null {
  if (!value) return null;
  let text = String(value).trim();
  if (!text) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  text = text.replace(' ', 'T');
  if (!hasZone) {
    text += 'Z';
  } else {
    text = text.replace(/Z$/i, 'Z');
  }
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function freshnessRow(detail: Obj, now: Date, pollIntervalSeconds: number): DiagnosticRow {
  const success = detail.success;
  if (success === false) {
    const parts: string[] = [];
    for (const err of asArray(detail.errors).slice(0, 2)) {
      if (err !== null && typeof err === 'object' && !Array.isArray(err)) {
        const entry = err as Obj;
        parts.push(`${(entry.stage as string) || 'unknown'}：${(entry.message as string) || '—'}`);
      } else {
        parts.push(String(err));
      }
    }
    const message = parts.join('；');
    return row(
      'collect',
      LEVEL_CRIT,
      '最近一次采集失败',
      message || '采集没有成功完成',
      '先点「测试连接」确认 SSH 可达，再检查 sudo 密码或采集命令是否被拦截。',
    );
  }
  if (success === null || success === undefined) {
    return row(
      'collect',
      LEVEL_WARN,
      '还没有采集数据',
      '这台主机尚未完成首次采集。',
      '确认主机地址、账号与密钥后点「立即采集」。',
    );
  }
  const collected = parseTime(detail.collected_at);
  if (collected === null) {
    return row('collect', LEVEL_OK, '采集正常', '采集时间未知，但最近一次采集成功。');
  }
  let age = (now.getTime() - collected.getTime()) / 1000;
  if (age < 0) age = 0;
  const minutes = Math.trunc(age / 60);
  const limit = Math.max(Math.trunc(pollIntervalSeconds), 60) * 3;
  if (age > limit) {
    return row(
      'collect',
      LEVEL_WARN,
      '采集数据已过期',
      `最近一次采集在 ${minutes} 分钟前，超过轮询周期的 3 倍。`,
      '确认后台调度是否在运行，或检查该主机的 SSH 连接是否超时。',
    );
  }
  return row(
    'collect',
    LEVEL_OK,
    '采集正常',
    minutes ? `最近一次采集在 ${minutes} 分钟前。` : '刚刚完成采集。',
  );
}

function usageRows(metrics: Obj): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [];
  const cpu = num(metrics.cpu_usage_percent);
  if (cpu !== null) {
    const level = cpu >= 97 ? LEVEL_CRIT : cpu >= 90 ? LEVEL_WARN : LEVEL_OK;
    rows.push(
      row(
        'cpu',
        level,
        'CPU 使用率',
        `当前 ${fixed(cpu, 1)}%`,
        level !== LEVEL_OK ? '查看高占用进程，或确认是否有训练任务把 GPU 机器打满。' : '',
      ),
    );
  }

  const cores = num(metrics.cpu_core_count);
  const load = asObj(metrics.load_average);
  const load1 = num(load.load_1);
  if (load1 !== null && cores) {
    const ratio = cores ? load1 / cores : 0;
    const level = ratio >= 2 ? LEVEL_CRIT : ratio >= 1.2 ? LEVEL_WARN : LEVEL_OK;
    rows.push(
      row(
        'load',
        level,
        '系统负载',
        `1 分钟负载 ${fixed(load1, 2)}，${Math.trunc(cores)} 核，平均每核 ${fixed(ratio, 2)}`,
        level !== LEVEL_OK ? '负载持续高于核数通常意味着进程排队，结合 CPU 与磁盘 IO 一起看。' : '',
      ),
    );
  }

  const memory = asObj(metrics.memory);
  const used = num(memory.used_mb);
  const total = num(memory.total_mb);
  if (used !== null && total) {
    const percent = total ? (used / total) * 100 : 0;
    const level = percent >= 95 ? LEVEL_CRIT : percent >= 90 ? LEVEL_WARN : LEVEL_OK;
    rows.push(
      row(
        'memory',
        level,
        '内存占用',
        `${fixed(percent, 1)}%（${fixed(used, 0)} / ${fixed(total, 0)} MB）`,
        level !== LEVEL_OK ? '接近上限会导致 OOM，建议确认常驻进程或及时扩容。' : '',
      ),
    );
  }

  let worst: { percent: number; mount: string } | null = null;
  for (const raw of asArray(metrics.disks)) {
    const mount = asObj(raw);
    const percent = num(mount.used_percent);
    if (percent === null) continue;
    if (worst === null || percent > worst.percent) {
      worst = { percent, mount: String(mount.mount || mount.path || '—') };
    }
  }
  if (worst !== null) {
    const level = worst.percent >= 95 ? LEVEL_CRIT : worst.percent >= 90 ? LEVEL_WARN : LEVEL_OK;
    rows.push(
      row(
        'disk',
        level,
        '磁盘使用率',
        `最高的挂载点 ${worst.mount} 已用 ${fixed(worst.percent, 1)}%`,
        level !== LEVEL_OK ? '清理历史数据或日志；本工具自身的日志只保留 24 小时。' : '',
      ),
    );
  }

  const gpus = asArray(metrics.gpu_summary);
  if (gpus.length) {
    let peak: { percent: number; index: string } | null = null;
    for (const raw of gpus) {
      const gpu = asObj(raw);
      const usedMb = num(gpu.memory_used_mb);
      const totalMb = num(gpu.memory_total_mb);
      if (usedMb === null || !totalMb) continue;
      const percent = (usedMb / totalMb) * 100;
      if (peak === null || percent > peak.percent) {
        peak = { percent, index: pyStr(gpu.index) };
      }
    }
    if (peak !== null) {
      const level = peak.percent >= 97 ? LEVEL_CRIT : peak.percent >= 90 ? LEVEL_WARN : LEVEL_OK;
      rows.push(
        row(
          'gpu_memory',
          level,
          'GPU 显存',
          `GPU ${peak.index} 显存已用 ${fixed(peak.percent, 1)}%`,
          level !== LEVEL_OK ? '显存打满会让新任务直接 OOM，确认是否有残留进程。' : '',
        ),
      );
    }
  }
  return rows;
}

function temperatureRow(detail: Obj): DiagnosticRow | null {
  const metrics = asObj(detail.metrics);
  const values: number[] = [];
  for (const raw of asArray(metrics.thermal_zones)) {
    const value = num(asObj(raw).celsius);
    if (value !== null) values.push(value);
  }
  for (const raw of asArray(metrics.gpu_summary)) {
    const value = num(asObj(raw).temperature_c);
    if (value !== null) values.push(value);
  }
  if (!values.length) return null;
  const hottest = Math.max(...values);
  const level = hottest >= 85 ? LEVEL_CRIT : hottest >= 70 ? LEVEL_WARN : LEVEL_OK;
  return row(
    'temperature',
    level,
    '温度',
    `最高 ${fixed(hottest, 1)} °C`,
    level !== LEVEL_OK ? '检查风扇与机房温度；持续高温会触发降频。' : '',
  );
}

function checkRow(detail: Obj): DiagnosticRow | null {
  const checks = asArray(detail.checks).map((raw) => asObj(raw));
  if (!checks.length) return null;
  const failing = checks.filter((check) => String(check.status) !== 'ok');
  if (!failing.length) {
    return row('checks', LEVEL_OK, '服务检查', `${checks.length} 项检查全部正常。`);
  }
  const names = failing
    .slice(0, 4)
    .map((check) => String(check.check_name || check.name || '—'))
    .join('、');
  return row(
    'checks',
    LEVEL_WARN,
    '服务检查异常',
    `${failing.length} / ${checks.length} 项异常：${names}`,
    '确认对应端口/进程是否在运行，必要时手动登录主机排查。',
  );
}

function diskHealthRow(detail: Obj): DiagnosticRow | null {
  const disk = detail.disk;
  if (!disk || typeof disk !== 'object') return null;
  const record = disk as Obj;
  const status = String(record.status || '').toLowerCase();
  const drives = asArray(record.drives).map((raw) => asObj(raw));
  const total = drives.length;
  const bad = drives.filter((drive) => {
    const health = String(drive.health || '').toLowerCase();
    const driveStatus = String(drive.status || '').toLowerCase();
    return !['healthy', 'ok', ''].includes(health) || ['failed', 'offline'].includes(driveStatus);
  });
  if (['error', 'critical'].includes(status) || bad.length) {
    return row(
      'disk_health',
      LEVEL_CRIT,
      '磁盘阵列异常',
      `${bad.length || 1} 块盘状态异常（共 ${total} 块）。`,
      '尽快在磁盘健康页确认具体槽位，涉及换盘请先备份。',
    );
  }
  if (['no_storcli', 'unknown'].includes(status)) {
    return row(
      'disk_health',
      LEVEL_WARN,
      '磁盘健康不可用',
      String(record.message || '') || '未获取到 storcli 输出。',
      '确认 storcli 路径与 sudo 免密配置；没有阵列卡的主机可忽略。',
    );
  }
  if (!drives.length) {
    // 状态是 ok 但没有明细时，说“0 块盘全部健康”会误导，宁可不显示这一行。
    return null;
  }
  return row('disk_health', LEVEL_OK, '磁盘阵列', `${total} 块盘全部健康。`);
}

function accountRow(detail: Obj): DiagnosticRow | null {
  const users = asArray(detail.users).map((raw) => asObj(raw));
  if (!users.length) return null;
  const issues = users.filter((user) => {
    const value = user.issues;
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });
  if (!issues.length) {
    return row('accounts', LEVEL_OK, '服务器账号', `${users.length} 个普通账号无异常。`);
  }
  return row(
    'accounts',
    LEVEL_WARN,
    '服务器账号异常',
    `${issues.length} / ${users.length} 个账号存在问题（目录缺失、所有者异常或未加入 docker 组）。`,
    '在服务器用户页查看明细，必要时由管理员人工修复。',
  );
}

function collectionRow(detail: Obj): DiagnosticRow | null {
  const uptime = asObj(detail.collection_uptime);
  const expected = Math.trunc(Number(uptime.expected) || 0);
  if (expected <= 0) return null;
  const samples = Math.trunc(Number(uptime.samples) || 0);
  const ratio = expected ? samples / expected : 1.0;
  const percent = roundHalfEven(ratio * 100);
  if (ratio >= 0.9) {
    return row(
      'uptime',
      LEVEL_OK,
      '采集成功率正常',
      `最近 24 小时应采 ${expected} 次，实际 ${samples} 次（${percent}%）。`,
    );
  }
  if (ratio >= 0.6) {
    return row(
      'uptime',
      LEVEL_WARN,
      '采集有缺失',
      `最近 24 小时应采 ${expected} 次，实际 ${samples} 次（${percent}%）。`,
      '检查网络抖动、SSH 超时或主机是否偶尔休眠。',
    );
  }
  return row(
    'uptime',
    LEVEL_CRIT,
    '采集大量失败',
    `最近 24 小时应采 ${expected} 次，只成功 ${samples} 次（${percent}%）。`,
    '确认主机在线与 SSH 凭据，必要时手动执行一次采集看报错。',
  );
}

/** `build_host_diagnostics`: graded diagnostic rows for one host detail, most severe first. */
export function buildHostDiagnostics(
  detail: Obj,
  opts: { now?: Date; pollIntervalSeconds?: number } = {},
): DiagnosticRow[] {
  const moment = opts.now ?? new Date();
  const pollIntervalSeconds = opts.pollIntervalSeconds ?? 600;
  const rows: DiagnosticRow[] = [freshnessRow(detail, moment, pollIntervalSeconds)];
  if (detail.success !== false) {
    rows.push(...usageRows(asObj(detail.metrics)));
    for (const extra of [
      temperatureRow(detail),
      collectionRow(detail),
      checkRow(detail),
      diskHealthRow(detail),
      accountRow(detail),
    ]) {
      if (extra !== null) rows.push(extra);
    }
  }
  rows.sort((a, b) => LEVEL_WEIGHT[a.level] - LEVEL_WEIGHT[b.level]);
  return rows;
}

/** `summarize_diagnostics`: count rows per level plus the combined attention total. */
export function summarizeDiagnostics(rows: readonly DiagnosticRow[]): DiagnosticsSummary {
  const counts: DiagnosticsSummary = { crit: 0, warn: 0, ok: 0, attention: 0 };
  for (const item of rows) {
    if (item.level === 'crit') counts.crit += 1;
    else if (item.level === 'warn') counts.warn += 1;
    else if (item.level === 'ok') counts.ok += 1;
  }
  counts.attention = counts.crit + counts.warn;
  return counts;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

/** ISO local calendar date (`YYYY-MM-DD`) of *moment* in *timeZone*. */
function localDateKey(moment: Date, timeZone: string): string {
  let formatter = dateFormatterCache.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dateFormatterCache.set(timeZone, formatter);
  }
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(moment)) {
    if (part.type !== 'literal') fields[part.type] = part.value;
  }
  return `${fields.year}-${fields.month}-${fields.day}`;
}

/** Add *days* calendar days to an ISO `YYYY-MM-DD` key (UTC-noon safe). */
function addDays(key: string, days: number): string {
  const [year, month, day] = key.split('-').map((part) => Number(part));
  const stamp = Date.UTC(year, month - 1, day) + days * 86_400_000;
  const next = new Date(stamp);
  return `${next.getUTCFullYear()}-${pad2(next.getUTCMonth() + 1)}-${pad2(next.getUTCDate())}`;
}

/**
 * `_host_alert_days`: bucket *alerts* into the last *days* local calendar days
 * (oldest first), with a bar `height` scaled to the busiest day.
 */
export function hostAlertDays(
  alerts: readonly Obj[],
  timezone: string,
  opts: { days?: number; now?: Date } = {},
): AlertDay[] {
  const days = opts.days ?? 7;
  const current = opts.now ?? new Date();
  const today = localDateKey(current, timezone);
  const start = addDays(today, -(days - 1));
  const buckets = new Map<string, AlertDay>();
  const order: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const key = addDays(start, offset);
    const entry: AlertDay = {
      key,
      label: key.slice(5),
      total: 0,
      critical: 0,
      warning: 0,
      info: 0,
      height: 0,
    };
    buckets.set(key, entry);
    order.push(key);
  }
  for (const alert of alerts) {
    const moment = parseTime(alert.created_at);
    if (moment === null) continue;
    const key = localDateKey(moment, timezone);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.total += 1;
    const severity = String(alert.severity || 'info');
    if (severity === 'critical') bucket.critical += 1;
    else if (severity === 'warning') bucket.warning += 1;
    else bucket.info += 1;
  }
  const rows = order.map((key) => buckets.get(key) as AlertDay);
  const peak = rows.reduce((max, entry) => (entry.total > max ? entry.total : max), 0);
  for (const entry of rows) {
    entry.height = peak ? roundHalfEven((entry.total * 100) / peak) : 0;
  }
  return rows;
}
