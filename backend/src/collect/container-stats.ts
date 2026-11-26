/**
 * 按需读取 Docker 容器资源占用（只读）——`servermanage/container_stats.py` 的
 * 1:1 TypeScript 移植。
 *
 * 只在用户点击「刷新占用」时执行一次 `docker stats --no-stream`，结果不落库、
 * 不进入轮询，避免给被监控主机增加持续负载。
 *
 * 约定（与 `./types.ts` 一致）：
 * - Python `X | None` -> `X | null`（保持显式 `null`，不用 `undefined`）。
 * - 字段名 camelCase：Python 的行字典键 `cpu_percent` / `memory_percent` /
 *   `memory_usage` 分别映射为 `cpuPercent` / `memoryPercent` / `memoryUsage`，
 *   与 `types.ts` 的既有命名保持一致（JSON 序列化时沿用后端其它记录的做法）。
 * - 百分比取整用 `roundHalfEven`，与 Python `round(x, 1)` 的银行家舍入一致。
 * - 解析从不抛异常：畸形输入产出 `null` / `[]`。
 */

import { roundHalfEven } from './types';

/**
 * 逐字节等于 Python oracle 的命令模板。注意字符串里的 `\t` 是真实制表符，
 * 外层为单引号——`docker stats --format` 需要它，切勿重排格式。
 */
export const STATS_COMMAND =
  "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemPerc}}\t{{.MemUsage}}' 2>/dev/null";

/** 单行容器占用。`cpuPercent` / `memoryPercent` 无法解析时为 `null`。 */
export interface ContainerStatRow {
  name: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryUsage: string;
}

/**
 * `collectContainerStats` 所需的最小 SSH 结果面。生产环境的 `SshClient.run`
 * 返回 `Promise<CommandResult>`，测试可注入同步的假实现。
 */
export interface ContainerStatsRunResult {
  stdout?: string | null;
  exitStatus?: number | null;
}

/** 最小 SSH 客户端面：与 `SshClient.run(command, timeoutMs)` 结构兼容。 */
export interface ContainerStatsSsh {
  run(
    command: string,
    timeoutMs: number,
  ):
    | ContainerStatsRunResult
    | null
    | undefined
    | Promise<ContainerStatsRunResult | null | undefined>;
}

/** Python `parse_container_stats` 的行数上限（排序前截断）。 */
const MAX_ROWS = 300;

/**
 * Python `float()` 能接受的十进制字面量（本移植仅覆盖十进制；`inf` / `nan`
 * 这类 `docker stats` 不会产出的写法按非法处理，返回 `null`）。
 * 这样可避免 JS `Number()` 的陷阱（如 `Number("0x10") === 16`）。
 */
const PY_FLOAT_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Python `str.splitlines()`（覆盖远程命令输出中出现的行终止符）。 */
function splitLines(value: string): string[] {
  return value.split(/\r\n|[\n\r\v\f\u001c\u001d\u001e\u0085\u2028\u2029]/);
}

/** Python `float(raw)` 的十进制子集；非法返回 `null`。 */
function toPythonFloat(raw: string): number | null {
  if (!PY_FLOAT_RE.test(raw)) {
    return null;
  }
  return Number(raw);
}

/**
 * 移植 `_percent`：`"3.42%"` -> `3.42`；无法解析返回 `null`。
 * Python 为 `(text or "").strip().rstrip("%")`，这里等价地先去空白、去掉尾随
 * 的 `%`（可能多个），再去一次空白以兼容 `"3.42 %"` 这类写法。
 */
function parsePercent(text: string | null | undefined): number | null {
  const raw = (text ?? '').trim().replace(/%+$/, '').trim();
  if (!raw) {
    return null;
  }
  const value = toPythonFloat(raw);
  if (value === null) {
    return null;
  }
  return roundHalfEven(value, 1);
}

/**
 * 移植 `parse_container_stats`：把 `docker stats` 的制表符输出解析成占用量列表。
 *
 * 行为与 Python 完全一致：
 * - 按 `\t` split，首列为空（或纯空白）的行跳过；
 * - 缺列时 `cpuPercent` / `memoryPercent` 为 `null`、`memoryUsage` 为 `""`；
 * - 最多保留 300 行（在排序前按输入顺序截断）；
 * - 排序键 `(cpuPercent is None, -cpuPercent)` 升序 —— 即 `cpuPercent` 为
 *   `null` 的行排最后、其余按 CPU 降序；相等时保持原始顺序（稳定排序）。
 */
export function parseContainerStats(output: string | null | undefined): ContainerStatRow[] {
  const rows: ContainerStatRow[] = [];

  for (const line of splitLines(output ?? '')) {
    const parts = line.split('\t');
    const name = (parts[0] ?? '').trim();
    if (name === '') {
      continue;
    }

    const cpuPercent = parts.length > 1 ? parsePercent(parts[1]) : null;
    const memoryPercent = parts.length > 2 ? parsePercent(parts[2]) : null;
    const memoryUsage = parts.length > 3 ? (parts[3] ?? '').trim() : '';

    rows.push({ name, cpuPercent, memoryPercent, memoryUsage });
    if (rows.length >= MAX_ROWS) {
      break;
    }
  }

  rows.sort(compareRows);
  return rows;
}

/**
 * Python `key=lambda row: (row["cpu_percent"] is None, -(row["cpu_percent"] or 0.0))`
 * 的等价比较器。Array.prototype.sort 自 ES2019 起保证稳定，因此相等 CPU 保持
 * 输入顺序，与 Python 的稳定 `list.sort` 一致。
 */
function compareRows(a: ContainerStatRow, b: ContainerStatRow): number {
  const aNull = a.cpuPercent === null ? 1 : 0;
  const bNull = b.cpuPercent === null ? 1 : 0;
  if (aNull !== bNull) {
    return aNull - bNull;
  }
  return (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0);
}

/**
 * 移植 `collect_container_stats`：在已连接的主机上执行一次只读统计命令。
 *
 * - `ssh.run` 返回 `null` / `undefined` -> `[]`；
 * - `exitStatus` 非 0（且非 `null` / `undefined`，对应 Python 的 `None`）-> `[]`；
 * - 否则解析 `stdout`。
 *
 * `_host` 与 Python 的 `host` 参数位置对齐，但只读命令不需要主机字段，故不使用。
 */
export async function collectContainerStats(
  _host: { name: string },
  ssh: ContainerStatsSsh,
  timeoutMs = 30000,
): Promise<ContainerStatRow[]> {
  const result = await ssh.run(STATS_COMMAND, timeoutMs);
  if (result === null || result === undefined) {
    return [];
  }
  if (result.exitStatus !== null && result.exitStatus !== undefined && result.exitStatus !== 0) {
    return [];
  }
  return parseContainerStats(result.stdout);
}
