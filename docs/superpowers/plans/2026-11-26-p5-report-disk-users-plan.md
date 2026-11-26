# P5 报表 / 磁盘健康 / 用户监控 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把报表生成、磁盘健康（storcli）、用户监控（扫描/账号写操作）三块 Python 业务逻辑按 1:1 行为迁移到 Node/TS，并把它们接入 P4 调度器与既有 Web 路由。

**Architecture:** 纯函数/服务层照 Python 模块逐函数移植（`report.py`→`src/report/`、`disk_health.py`+`disk_capacity.py`→`src/disk/`、`user_*.py`→`src/users/`），依赖全部注入（db 句柄、SSH runner、时钟、模板环境）。数据读写一律走 P1 `src/storage/*`。调度与路由通过 `src/runtime/wiring.ts`、`src/web/composition.ts` 注入。

**Tech Stack:** TypeScript 5.9 / Node 22 / better-sqlite3 / Nunjucks（报表模板复用 `servermanage/templates/report*.j2`）/ vitest。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md`（§6.3 业务模块、§7 迁移、§9 差分判据）。

## Global Constraints

- Python `servermanage/*` 零改动；`python -m pytest -q` 必须保持 **1892 passed / 1 skipped**。
- Node 侧 `pnpm --filter servermonitor-backend typecheck` 必须 exit 0，全量 vitest 不回退（P4 末基线 **76 files / 1472 passed / 1 skipped**）。
- 时间一律 ISO-8601 UTC 文本 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`（`nowIsoUtc`）；浮点比较按设计 §9.1（1e-6）。
- 数据访问只用已打开的 better-sqlite3 `db` 句柄；不得新开连接。
- 所有副作用（SSH、邮件、网络、时钟、文件系统）必须可注入以便测试；单测不得真连 SSH/网络。
- 中文文案、错误消息与 Python 逐字一致（差分对照）。
- 每个任务：先写失败测试 → 最小实现 → 验证 → 提交。

## Review Focus

1. **storcli 空/异常输出**（无 RAID、权限不足、命令不存在、JSON 与文本混排）不得抛未捕获异常，应产出带 `error`/`warning` 的报告而不是崩溃。
2. **磁盘温度/状态解析的边界值**（`parse_temperature` 对 "N/A"、负数、超 100、带单位）不得误判为健康或崩溃。
3. **用户名/密码校验**（`validate_username`、`validate_password`）必须与 Python 同规则，避免生成非法账号或过弱口令；账号写操作 plan 与 execute 的哈希/缓存过期语义不得错位导致重复执行。
4. **报表模板渲染**（JS 侧无 Jinja `selectattr`/`namespace`）——六份 `.j2` 模板必须全部可渲染，数值格式（GiB 1 位小数、百分比取整）与文本报表逐字节一致，空数据/缺字段不得产生 "None" 字样。
5. **用户扫描的 stale/失败路径**（`_usage_is_stale`、`_persist_failure`）——扫描失败必须落为失败状态且保留上次基线，不得把空结果写成"用户已全部删除"。

---

### Task 1: usermode 归一化

**Files:** Create `backend/src/users/usermode.ts`, `backend/test/users/usermode.test.ts`
**Interfaces:** `normalizeMode(value, {default?}): 'admin'|'member'`；`normalizeMemberAccount(value): string`；`validateMode(mode, memberAccount): [string, string]`；`ModeError`。照 `servermanage/usermode.py` 全部 51 行。
- [ ] 测试覆盖：默认值、未知模式报错文案、member 模式缺账号报错、trim/空白。
- [ ] 实现 → `pnpm --filter servermonitor-backend test users/usermode` 通过 → 提交 `feat(p5): usermode normalization`。

### Task 2: disk_capacity 挂载点状态

**Files:** Create `backend/src/disk/capacity.ts`, `backend/test/disk/capacity.test.ts`
**Interfaces:** `normalizeMounts(mounts): string[]`；`mountStatuses(rows, mounts, {thresholds?}): MountStatus[]`；`maxPercent(...)`。照 `servermanage/disk_capacity.py:32-138`。**注意**：P3 已有的 `src/collect/capacity.ts` 是容量预测，二者不同，勿混淆。
- [ ] 测试：`_row_value`/`_parse_percent` 边界（"%"/"12.5%"/空/None）、mount 缺失返回 missing 状态、阈值判定。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): disk mount capacity status`。

### Task 3: disk_health 解析（storcli 文本 + JSON）

**Files:** Create `backend/src/disk/parse.ts`, `backend/test/disk/parse.test.ts`
**Interfaces:** 类型 `DiskControllerInfo/VirtualDriveInfo/PhysicalDriveInfo`（字段对齐 Python dataclass `disk_health.py:51-101`）；`parseTemperature`；`parseControllers(text)`；`parseVirtualDrives(text, controller)`；`parsePhysicalDrivesText(text)`；`parsePhysicalDrivesJson(text)`；`parsePhysicalDrives(text)`；`StorcliParseError`。照 `disk_health.py:128-529`。
- [ ] 用真实 storcli 文本/JSON 样本作 fixture（≥6 组：多控制器、无 VD、SAS/SATA、异常行、权限错误文本、JSON 数组）。测试断言字段与 Python `parse_*` 输出一致（可用 Python oracle 生成期望）。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): storcli disk parsing`。

### Task 4: disk_health 健康评估

**Files:** Create `backend/src/disk/evaluate.ts`, `backend/test/disk/evaluate.test.ts`
**Interfaces:** `evaluateDriveHealth(drive, opts)`；`evaluateVirtualDriveHealth(vd)`；`evaluateControllerHealth(...)`；`parseTemperature` 复用；`AlertEvent` 类型（`disk_health.py:102-127`）。照 `disk_health.py:536-680`。规则：介质错误/其他错误增长 → critical；SMART 失败、温度阈值（默认 55℃）、状态词、BBU 状态。
- [ ] 测试：`_increased`、`_state_word` 各取值、温度边界、错误计数增长触发告警、无变化不触发。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): disk health evaluation`。

### Task 5: disk report + 采集

**Files:** Create `backend/src/disk/report.ts`, `backend/src/disk/collect.ts`, `backend/test/disk/report.test.ts`, `backend/test/disk/collect.test.ts`
**Interfaces:** `diskReportFromSnapshot(snapshot): DiskHealthReport`；`collectDiskHealth(host, runner, {runnerFactory?, timeoutMs?}): Promise<DiskHealthReport>`（`_run_privileged` 等价：sudo 缺失 → permission 提示；`collect_disk_health:791` 全流程：controllers→vds→pds 命令序列）。照 `disk_health.py:681-1016`。
- [ ] 测试：注入 fake runner 返回样本 stdout → 报告结构与 Python `disk_report_from_snapshot` 一致；权限错误 → 报告含 permission message 不抛；runner 抛错 → 捕获为 warning。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): disk health report and collection`。

### Task 6: 用户扫描解析

**Files:** Create `backend/src/users/scan.ts`, `backend/test/users/scan.test.ts`
**Interfaces:** `UserScanRunner` 接口；`validateUsername(name): boolean`；`parsePasswd(text)`；`parseGroup(text)`；`buildScanCommand()`；`buildUsageCommand(paths)`；`parseUsage(text)`；`parseScanOutput(fields)`；`collectHostUsers(host, runner, opts)`。照 `user_scan.py:100-582`。
- [ ] 测试：passwd/group 边界（重复 uid、系统账号、空行、恶意用户名）、usage 解析（KB/MB、permission denied 段）、`_safe_usage_path` 拒绝。用 Python oracle 对拍解析结果。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): user scan parsing`。

### Task 7: 用户账号写操作 plan/execute

**Files:** Create `backend/src/users/admin.ts`, `backend/test/users/admin.test.ts`
**Interfaces:** `validateAccountName`；`validatepassword`；`generatepassword(length=16)`；`buildPlan(params): AdminPlan`；`publicPlan(plan)`；`PlanCache`（TTL、哈希）；`executePlan(plan, runner, cache)`；`maskCommand(command)`；`AdminPlanError`；`_rollbackHint`。照 `user_admin.py:78-461`。
- [ ] 测试：add/remove/chpasswd/reset 四类 plan 步骤与命令、密码强度规则、plan 哈希被篡改 → 拒绝、缓存过期 → 报错、maskCommand 不泄露密码、rollback hint 文案。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): user admin plan and execute`。

### Task 8: 用户采集编排与持久化

**Files:** Create `backend/src/users/collection.ts`, `backend/test/users/collection.test.ts`
**Interfaces:** `isUserMonitoringEnabled(host, config)`；`runUserScan({db, config, hosts?, runScan?, now?}): Promise<ScanSummary>`；内部 `_scanHost`/`_usageIsStale`/`_persistFailure`/`_accountFromBaseline`。照 `user_collection.py:48-420`，落库用 P1 `storage/users.ts`（`saveHostUserSnapshot/saveHostUserScanResult/appendUserUsageHistory/saveUserScanState/upsertUserBaseline`）。
- [ ] 测试：禁用主机跳过；扫描成功写快照+usage 增量；扫描失败写 failed 状态且保留基线；stale usage 不覆盖。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): user scan orchestration`。

### Task 9: 报表上下文构建

**Files:** Create `backend/src/report/context.ts`, `backend/test/report/context.test.ts`
**Interfaces:** `buildContext(report)`（technical）、`buildExecutiveContext(report)`、`buildWeeklyContext(report)`，以及全部 `_overview_text/_disk_peak/_disk_total/_gpu_peak/_gpu_total/_host_status/_build_risk_items/_executive_host_context/_host_context/_weekly_host_context/_host_context` 辅助。照 `report.py:28-500`。另 `renderSvgLineChart`（`report.py:385-454`）。
- [ ] 用 Python oracle（构造 DailyReport/WeeklyReport 样本 → 调 `_build_context` 等）产出期望 JSON，逐字段比对（浮点 1e-6）。测试 ≥15 例。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): report context builders`。

### Task 10: 报表渲染（Nunjucks 复用 .j2）

**Files:** Create `backend/src/report/render.ts`, `backend/test/report/render.test.ts`；复用模板 `servermanage/templates/report{,_executive,_weekly}.{html,txt}.j2`（只读引用）
**Interfaces:** `renderReport(report, variant='technical'): {text?:string, html?:string}`；内部建立独立 Nunjucks Environment（autoescape 对 html，trim/lstrip 同 Python），注册渲染所需过滤器（含 `tojson`、数值格式化、`stamp` 若模板用到）。照 `report.py:500-514` + 六份模板。
- [ ] **先将六份模板在 Node 下全部渲染成功**（含空数据/缺字段），对每类报表用同一输入与 Python `render_report` 的 text 输出**逐字节比对**（文本报表）；HTML 结构关键片段断言。若某模板用了 Jinja 专有语法（`namespace/selectattr`），在渲染层加适配（不改模板，除非不可避免——若必须改模板，需复制到 `backend/src/report/templates/` 并在计划记录）。
- [ ] 实现 → 测试通过 → 提交 `feat(p5): report rendering`。

### Task 11: 接入调度与路由（wiring / composition）

**Files:** Modify `backend/src/runtime/wiring.ts`（注册 `disk-poll` 与 `user-scan` 任务、把 daily/weekly report 占位替换为真实生成+发送）、`backend/src/web/composition.ts`（disk-health 页用真实 `buildDiskHealthContext`、users 路由注入 `monitorService`（refresh/plan/execute）、hosts 的 `collectionStatus`/`collectHosts` 聚合、system diagnostics 补磁盘/用户摘要）
**Interfaces:** 依赖 Task 2–10 的导出；从 P4 `Notifier` 复用发送邮件；任务间隔：disk_poll 取 `monitoring.disk_poll_interval_seconds`（无则默认同 poll），user_scan 取 `user_monitoring.scan_interval_seconds`。
- [ ] 测试：wiring 用 fake deps 断言新增任务名/间隔/calendar 与 report 任务 run 产生的发送调用；composition 测试断言 disk-health 页返回真实 controller 数、users `/api/users/refresh` 触发注入的 monitorService（fake）。
- [ ] 实现 → 全量 vitest 通过 → 提交 `feat(p5): wire disk/user/report into scheduler and routes`。

### Task 12: 差分/对照测试

**Files:** Create `backend/test/diff/disk-users-report/`（`run_*_oracle.py`、`fixtures/`、`*-diff.test.ts`）
**Interfaces:** 对 disk_health 解析+评估（≥5 组 storcli 样本）、user_scan 解析（≥5 组 passwd/group/usage）、report 文本渲染（technical/executive/weekly 三类）与 Python 输出 `diff==[]`。
- [ ] 实现 oracle 脚本（直接 import `servermanage.*`）→ Node 对比 → 断言 `diff==[]`。任何差异必须列出并判定"Node 缺陷/有意差异"，不得放宽容差掩盖。
- [ ] 提交 `test(p5): disk/user/report differential vs python oracle`。

### Task 13: 验收

**Files:** Create `docs/superpowers/plans/p5-acceptance.md`；更新 `.superpowers/sdd/single-stack-rewrite-plan/progress.md`
**Interfaces:** 门禁：typecheck 0、backend vitest 全绿不回退、bundle build + smoke、`python -m pytest -q` 1892/1、`git status servermanage` 空。
- [ ] 记录每任务提交、门禁实测数字、已知差异与遗留项（尤其模板适配、disk/user 未覆盖路径）。
- [ ] 提交 `test(p5): P5 acceptance report`。
