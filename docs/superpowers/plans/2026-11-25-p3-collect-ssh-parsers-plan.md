# P3 采集 / SSH / 解析 实施计划（backend/src/collect）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Python 的采集层（`ssh_client.py` / `commands.py` / `parsers.py` / `collectors.py` / `host_probe.py` / `container_stats.py` / `compute.py` / `capacity.py`）1:1 移植到 `backend/src/collect/*`（TypeScript），行为与原实现等价，用 Python oracle 做差分对照。

**Architecture:** 纯函数优先——命令表与解析器是纯函数（易测、可差分）；SSH 传输层 `ssh2` 客户端薄封装（TOFU 指纹、keepalive、超时、瞬态一次重试、sudo 仅经 stdin）；采集编排注入 runner，测试用假 runner，不真连。所有时间用 `nowIsoUtc()`（`YYYY-MM-DDTHH:MM:SS.ffffff+00:00`）。

**Tech Stack:** TypeScript 5.9 + vitest + `ssh2`（唯一新运行时依赖）；better-sqlite3 已有；测试用 supertest 无关。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md`（§6.3 采集/SSH/解析、§7 数据兼容、§9.1 差分判据、§14 as-is 索引）

## Global Constraints

- 平台 Windows 10/11 单用户；安装/数据目录可自定义、默认不落 C 盘（本阶段不涉及路径）。
- 不得修改 `servermanage/*`（Python 保持 oracle，`git status servermanage` 必须为空）。Python 测试门禁 `python -m pytest -q` 必须仍为 1892 passed / 1 skipped。
- 时间字符串必须 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`（6 位微秒，禁 `toISOString()`）。
- 新增运行时依赖仅允许 `ssh2`（`pnpm --filter servermonitor-backend add ssh2` + devDep `@types/ssh2`）。
- 命令字符串逐字节复制 `servermanage/commands.py::build_command_map()`，不得改写（区分 shell 引号/转义）。
- 解析器必须逐字段对齐 Python dataclass 语义（`None` vs `0`、`round()` 规则、单位换算）。
- 每个任务禁 commit，由 lead 验证后提交；工作树保持可回滚。
- `pnpm --filter servermonitor-backend typecheck` 与 `test` 全绿（基线 49 files / 777 passed / 1 skipped，不得回退）。

## Review Focus

- **命令输出的畸形/截断输入**：解析器遇到空 stdout、非零退出、列数不足、`N/A`、`[Not Supported]`、超大数值时必须返回 `null`/空数组并记 stage 错误，绝不抛异常中断整机采集（`parse_host_metrics` 的内层各 parser 均需 try 语义对齐）。
- **GPU 缺失主机**：`nvidia-smi` 不存在时 GPU 阶段失败不得使整机失败；`gpu_summary=[]` 且 `hottestTemperatureC` 仍从 thermal/无 GPU 回落。
- **SSH 认证失败 vs 瞬态错误**：认证错误绝不重试、绝不把密码写日志/argv；仅连接类瞬态错误重试一次（1.0s 退避）。
- **TOFU 主机密钥**：`tofu` 首次信任并落盘指纹、`strict` 失配抛错且不连接、`insecure` 忽略；known-hosts JSON 原子写。
- **sudo 密码通道**：只经 stdin（`sudo -S -p ''`），区分 `SudoAuthError`（密码错）与 `SudoUnavailable`（无 sudo），错误信息不得包含密码。

---

### Task 1: 命令表 `collect/commands.ts`

**Files:** Create `backend/src/collect/commands.ts`; Test `backend/test/collect/commands.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `STAGES`（21 个 stage 常量对象，键同 Python：hostname/os_release/kernel/uptime/cpu_cores/cpu_usage/memory/disk/net/thermal/who/total_processes/process_counts/top_cpu/top_memory/pid_user_map/docker_containers/docker_status/pid_container_map/gpu_summary/gpu_processes）；`type Stage = keyof typeof COMMANDS`；`buildCommandMap(): Record<Stage, string>`

**步骤:**
- [ ] Step 1: 写失败测试——断言 `buildCommandMap()` 有 21 个键，且 `cpu_usage`、`net`、`pid_container_map`、`gpu_summary` 等关键字符串与 `servermanage/commands.py` 逐字节相等（测试内嵌期望字符串）。
- [ ] Step 2: 运行 `pnpm --filter servermonitor-backend test commands` 期望 FAIL（模块不存在）。
- [ ] Step 3: 逐字节复制 `build_command_map()` 的 21 条命令实现。
- [ ] Step 4: 运行测试 PASS；`typecheck` 0。
- [ ] Step 5: 交 lead 提交。

### Task 2: 类型与模型 `collect/types.ts`

**Files:** Create `backend/src/collect/types.ts`; Test `backend/test/collect/types.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `CommandResult { stdout: string; stderr: string; exitStatus: number }`；`LoadAverage`、`MemorySummary`、`DiskUsageRow`、`LoggedInUser`、`UserProcessCount`、`ProcessRow`、`GPUSummaryRow`、`GPUProcessRow`、`ThermalZone`、`ContainerInfo`、`HostMetrics`、`HostCollectionError`、`HostCheckResult`、`HostReport`（字段名/可空性与 `servermanage/models.py:284-540` 逐字段一致，camelCase）；`hottestTemperatureC(m: HostMetrics): number | null`（thermal+GPU 取最大，`round(…,1)`）；`emptyHostMetrics()`。

**步骤:**
- [ ] Step 1: 失败测试——`hottestTemperatureC` 对空返回 null、thermal 35.2+gpu 62 → 62、仅 thermal 41.24 → 41.2（Python `round` 银行家舍入需与 JS 对齐，用 `Math.round(x*10)/10` 验证差异点）。
- [ ] Step 2: 运行 FAIL。
- [ ] Step 3: 定义全部接口 + `hottestTemperatureC`；字段按 models.py 一一对应。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 3: 文本解析器 `collect/parsers-text.ts`

**Files:** Create `backend/src/collect/parsers-text.ts`; Test `backend/test/collect/parsers-text.test.ts`

**Interfaces:**
- Consumes: `collect/types`
- Produces: `parseUptime`, `parseUptimeText`, `parseOsPrettyName`, `parseMemorySummary`, `parseMemory`, `parseDiskUsage`, `parseWho`, `parseProcessCounts`, `parseProcessRows`, `parseThermalZones`, `parseDockerContainerNames`, `parseDockerContainers`, `parsePidContainerMap`, `parseTotalProcesses`, `parseCpuUsagePercent`, `parseNetTotals`（签名与 `servermanage/parsers.py:97-565` 对应函数一致，返回对应类型或 `null`/`[]`）

**步骤:**
- [ ] Step 1: 失败测试——用 `servermanage/tests/test_parsers.py` 中的实际样例字符串（逐条抄入 fixture），断言解析结果字段（load 三值、memory total/used/percent、df 行、who 用户、process counts 排序、docker name 映射、thermal ℃ 单位换算 `millidegree/1000`、net rx/tx 整数）。
- [ ] Step 2: 运行 FAIL。
- [ ] Step 3: 实现各函数（`_to_int/_to_float/_first_line` 私有助手，失败返回 null；浮点 `round` 对齐 Python）。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 4: GPU 解析与总装 `collect/parsers.ts`

**Files:** Create `backend/src/collect/parsers.ts`; Test `backend/test/collect/parsers.test.ts`

**Interfaces:**
- Consumes: `collect/parsers-text`、`collect/types`、`collect/commands`
- Produces: `parseNvidiaSmiSummaryWithUuid`, `parseGpuSummary`, `parseNvidiaSmiSummary`, `parseNvidiaSmiProcesses`, `parsePidUserCommandMap`, `parseGpuUuidMap`, `parseHostMetrics(results: Partial<Record<Stage, CommandResult>>, host: {name: string}): HostMetrics`（含 `_attachContainerContext`、`_buildProcessCountsByUser`、`_stdoutIfOk/_stdoutIfOkAny` 语义：仅 exit=0 采用 stdout）

**步骤:**
- [ ] Step 1: 失败测试——GPU csv 样例（含 `[Not Supported]`、`N/A`、多卡 uuid 映射到进程）；`parseHostMetrics` 给一组完整 stage 结果断言所有字段，并断言某 stage 非零退出时字段为 null/空但其余仍解析。
- [ ] Step 2: 运行 FAIL。
- [ ] Step 3: 实现。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 5: SSH 传输层 `collect/ssh-client.ts`

**Files:** Create `backend/src/collect/ssh-client.ts`; Test `backend/test/collect/ssh-client.test.ts`（用注入的假 `ssh2` 客户端工厂，不真连）

**Interfaces:**
- Consumes: `collect/types`、`collect/commands`
- Produces:
  - `class SudoAuthError extends Error`、`class SudoUnavailable extends Error`、`class HostKeyMismatch extends Error`
  - `type HostKeyPolicy = 'tofu' | 'strict' | 'insecure'`
  - `class KnownHostsStore { constructor(filePath); verify(host, port, fingerprint): 'ok'|'mismatch'|'unknown'; trust(...): void }`（SHA256 指纹，JSON 落盘，原子写）
  - `class SshClient { constructor(cfg: SshConnectConfig, deps?: {clientFactory?}) ; connect(): Promise<void>; run(command, timeoutMs): Promise<CommandResult>; runSudo(command, password, timeoutMs): Promise<CommandResult>; openShell(cols,rows): Promise<ShellChannel>; close(): void }`；`SshConnectConfig {host, port, username, password, privateKey?, privateKeyPath?, keyPassphrase?, connectTimeoutSec, hostKeyPolicy, knownHostsPath}`。
  - 语义：keepaliveInterval=30000；`_isTransientConnectError` 判定（ECONNRESET/ETIMEDOUT/ECONNREFUSED/EHOSTUNREACH/ENETUNREACH/Timeout/Connection lost）→ 重试 1 次、退避 1000ms；认证错误（All configured authentication methods failed / Cannot parse privateKey）不重试；`run` 超时→`{stdout:'',stderr:'command timed out',exitStatus:124}`；`runSudo` 用 `sudo -S -p ''` 经 stdin，stderr 命中 "incorrect password"/"Sorry, try again" → SudoAuthError，命中 "not in the sudoers"/"command not found" → SudoUnavailable。
- [ ] Step 1: 失败测试——假客户端：首次 connect 抛 ETIMEDOUT 第二次成功（断言重试一次）；认证错误不重试；runSudo 写 stdin 且 argv 不含密码；stderr 密码错→SudoAuthError；TOFU 首次 trust、二次 mismatch。
- [ ] Step 2: FAIL。
- [ ] Step 3: `pnpm --filter servermonitor-backend add ssh2 -D @types/ssh2`（若已在 package.json 则跳过），实现。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 6: 采集编排 `collect/collectors.ts`

**Files:** Create `backend/src/collect/collectors.ts`; Test `backend/test/collect/collectors.test.ts`

**Interfaces:**
- Consumes: `collect/commands`、`collect/parsers`、`collect/types`
- Produces: `type CollectorRunner = { run(cmd, timeoutMs): Promise<CommandResult>; close?(): void }`；`collectHostReport(host: HostLike, runner, opts: {connectTimeoutSec, commandTimeoutSec, buildCommandMap?, parseResults?, runHostChecks?: (host, runner) => Promise<HostCheckResult[]>}): Promise<HostReport>`；`collectAllHosts(hosts, factory: (host)=>Promise<CollectorRunner>|CollectorRunner, opts: {concurrency, connectTimeoutSec, commandTimeoutSec, runHostChecks?}): Promise<HostReport[]>`
- 语义：逐 stage 顺序执行；任一 stage 非零退出记 `HostCollectionError{stage,message}` 但继续；runner 抛异常（含 ssh）→ success=false 中止并返回；parse 抛异常→stage='parse' 错误；checks 抛异常不使报告失败（stage='checks'）；`collectedAt` 缺省用 `nowIsoUtc()`。
- [ ] Step 1: 失败测试——假 runner 返回预置 stage 输出（构造 1 台健康主机 → success=true、metrics 完整）；某 stage exit=1 → errors 含该 stage 且 success 仍 true（非 ssh）；runner.run 抛错 → success=false；并发 3 台乱序完成仍按输入顺序返回。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现（并发用简单 promise 池，默认 concurrency=8）。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 7: 连通性探测 `collect/host-probe.ts`

**Files:** Create `backend/src/collect/host-probe.ts`; Test `backend/test/collect/host-probe.test.ts`

**Interfaces:**
- Consumes: `collect/ssh-client`（仅类型）、`collect/types`
- Produces: `type ProbeRunner = { run(cmd,timeoutMs): Promise<CommandResult>; runSudo?(cmd,timeoutMs): Promise<CommandResult>; close?(): void }`；`interface ProbeResult { status: 'ok'|'ssh_failed'|'sudo_error'|'error'; os?: string; kernel?: string; uptime?: string; cpuCores?: number; memoryTotalMb?: number; disks?: Array<{mount:string;size:string;used:string;avail:string;usePercent:string}>; storcli?: string|null; message?: string }`；`probeHost(host, opts: {connectTimeoutSec, commandTimeoutSec, runnerFactory: (host)=>ProbeRunner}): Promise<ProbeResult>`
- 语义对齐 `servermanage/host_probe.py:237-337`：跑一组探测命令（os-release/uname/uptime/nproc/free/df/storcli 检测），失败分级。
- [ ] Step 1: 失败测试——假 runner 全部成功 → status ok 且字段解析正确；run 抛错 → status error+message；sudo 缺失 → sudo_error。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 8: 容器统计 `collect/container-stats.ts`

**Files:** Create `backend/src/collect/container-stats.ts`; Test `backend/test/collect/container-stats.test.ts`

**Interfaces:**
- Consumes: `collect/types`
- Produces: `parseContainerStats(output: string|null): Array<{name,cpuPercent,memPercent,memUsage,memLimit,netIo,blockIo,pids}>`（对齐 `container_stats.py:30`）；`collectContainerStats(host, runner, opts): Promise<Array<...>>`（`docker stats --no-stream` 命令字符串从 oracle 复制）
- [ ] Step 1: 失败测试——样例 `docker stats` 输出（含 `--` 缺失、`0.00%`、`N/A`）断言百分比与 IO 字段；空输出→[]。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 9: 算力汇总 `collect/compute.ts`

**Files:** Create `backend/src/collect/compute.ts`; Test `backend/test/collect/compute.test.ts`

**Interfaces:**
- Consumes: `collect/types`（HostMetrics）
- Produces: `interface GpuSpec {name; tflops; pf16; bandwidthGbs}`；`GPU_SPECS` 表 + `specFor(name): GpuSpec`（未知卡回落零值）；`buildComputeSummary(snapshots: Array<{hostName; metrics: HostMetrics}>, opts?: {servers?: Array<{name; group}>}): ComputeSummary`（字段 `totals/models/hosts/users/idle_hosts/notes` 对齐 `servermanage/compute.py:82`）。
- [ ] Step 1: 失败测试——2 台主机（1 GPU A100、1 无 GPU）断言 totals 计数、model 聚合、idle 判定、notes。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现（从 compute.py 复制 GPU 规格表数值）。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 10: 容量预测 `collect/capacity.ts`

**Files:** Create `backend/src/collect/capacity.ts`; Test `backend/test/collect/capacity.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `linearSlope(points: Array<[number, number]>): number | null`（最小二乘，点数<2→null）；`forecastSeries(points, opts): Array<{day; value}>`；`buildCapacityForecasts(rows, opts): CapacityForecast[]`（对齐 `capacity.py:27-166`：阈值 ETA、linear 斜率、上限/截断）
- [ ] Step 1: 失败测试——已知斜率样例（y=2x+1 → slope 2）、单点→null、阈值穿越 ETA 天数、超过上限截断。
- [ ] Step 2: FAIL。
- [ ] Step 3: 实现。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 11: 差分对照 `test/collect/diff-parsers.test.ts`

**Files:** Create `backend/test/collect/fixtures/*.json`（stage→stdout 样例，取自 `servermanage/tests/test_parsers.py` 与真实输出）、`backend/test/collect/diff-parsers.test.ts`；复用 `backend/test/diff/run_python_oracle.py` 模式新增 `backend/test/collect/run_python_parse_oracle.py`

**Interfaces:**
- Consumes: `collect/parsers`、`collect/types`
- Produces: 测试断言 `parseHostMetrics(fixture)` 的 JSON 与 Python `parse_host_metrics` 输出（经 oracle 脚本）在规范化后**diff==[]**（归一化：浮点按 `round(...,6)`、时间置空、数组显式排序键、`None`↔`null`）。
- [ ] Step 1: 写 oracle 脚本：输入 stage dict → 调 `servermanage.parsers.parse_host_metrics` → dump JSON（ensure_ascii=False）。先跑通打印。
- [ ] Step 2: 写测试（3 组 fixture：完整 GPU 机 / 无 GPU 机 / 部分 stage 失败机）断言 diff==[]；先 FAIL（实现未对齐处暴露）。
- [ ] Step 3: 修 `parsers` 直到 diff==[]（不改 oracle）。
- [ ] Step 4: PASS + typecheck。
- [ ] Step 5: 交 lead 提交。

### Task 12: 装配与验收 `web/composition.ts` 注入 + 验收文档

**Files:** Modify `backend/src/web/composition.ts`（注入 `buildComputeSummary` 到 pages deps、`collectHosts`/`probeHost` 到 hosts deps 的可用实现）；Create `docs/superpowers/plans/p3-acceptance.md`；追加 `.superpowers/sdd/single-stack-rewrite-plan/progress.md`

**Interfaces:**
- Consumes: Task 1–11 全部导出
- Produces: composition 的默认 deps 现在提供真实 `buildComputeSummary`（pages `/api/compute` 真数据）与真实 `probeHost`（hosts probe 端点，需 SSH 注入时仍可覆盖）；不改任何路由文件签名。
- [ ] Step 1: 写集成测试断言 `/api/compute` 在有 GPU 快照数据时返回真实 totals（不再全 0 占位）。
- [ ] Step 2: FAIL（占位实现）。
- [ ] Step 3: 在 composition `buildDefaultDeps` 接 `buildComputeSummary`；probe 通过可选 runnerFactory 注入（无 SSH 配置时保持"尚未迁移"行为）。
- [ ] Step 4: 全量 `test` PASS + typecheck 0；`python -m pytest -q` 仍 1892 passed/1 skipped；写验收文档（端点/解析器覆盖、差分结果、已知差异：host_probe 简化、checks 属 P4、SSH 终端属 P4/P6）。
- [ ] Step 5: 交 lead 提交。

## P3 Definition of Done

- `backend/src/collect/*` 覆盖 commands/types/parsers-text/parsers/ssh-client/collectors/host-probe/container-stats/compute/capacity。
- 差分测试 `diff-parsers` 对 3 组 fixture 全 `diff==[]`。
- backend typecheck 0；vitest 全绿（≥777，无回退）；Python `pytest -q` 1892 passed/1 skipped；`git status servermanage` 为空。
- 已知差异与 P4/P5 依赖列在 `p3-acceptance.md`。
