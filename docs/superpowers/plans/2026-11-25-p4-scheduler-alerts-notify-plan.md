# P4 调度 / 运行时 / 告警 / 通知 实施计划（Python → Node/TypeScript）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 `servermanage/{scheduler,runtime,availability,maintenance,log_cleanup,alerts,notify_webhook,notify_desktop,mailer}.py` 逐项等价移植到 `backend/src/{runtime,alerts}/*`，并把调度循环、主机巡检、维护/日志清理接入已装配的 Web 服务，行为与 Python oracle 一致。

**Architecture:** 纯函数优先（规则、时间计算、`_should_skip`、命令构建、结果解析），I/O 通过注入的 `runner` / `notifier` / `clock` 隔离；调度器为单线程 `setInterval` tick 驱动、状态写 `task_state`（P1 `storage/tasks.ts`）；告警引擎写 `alerts` 表（P1 `storage/alerts.ts`）。

**Tech Stack:** TypeScript、better-sqlite3、nodemailer、global fetch（webhook）、`Intl.DateTimeFormat`（时区）、vitest + supertest。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md` §6.4 / §6.5 / §8 P4。

## Global Constraints

- Node ≥ 22；无新增运行时依赖（除已批准的 `nodemailer`）。
- 不改 `servermanage/**`（Python 仅作 oracle 与 pytest 门禁 1892 passed / 1 skipped）。
- 时间字符串一律 `nowIsoUtc()` 产出 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`。
- 阈值比较含等号（`>=`）；`null` 指标跳过、绝不当作 0。
- 告警指纹 = 各段小写、冒号拼接。
- 失败任务仍占时间槽，`last_result` 记录 `"error: Type: msg"`，截断 500 字符。
- 每任务只新建文件（除明确标注 Modify），子代理禁止 commit，由 lead 验证后提交。

## Review Focus

1. **夏令时/时区边界**：`Asia/Shanghai` 无 DST，但 `_current_period_target` 需对任意 IANA tz 正确（用 Intl 计算本地墙钟），装新主机不重复发日报。
2. **调度补跑**：服务停机 3 天后重启，日报只补 1 次、周报只补 1 次，不重复轰炸。
3. **告警抖动**：坏→好→坏在两周期内，streak 必须重置为 1，不得因历史计数误报。
4. **通知部分失败**：一个通道失败不影响其他通道；无 `notified_channels` 时下一周期重试且不消耗冷却。
5. **巡检目标注入**：`run_host_checks` 的 target 走 `validate_check_target`，含控制字符/空格的 HTTP/TCP target 必须被拒绝而非执行。

---

### Task 1: 调度时间原语 `backend/src/runtime/schedule-time.ts`

**Files:** Create: `backend/src/runtime/schedule-time.ts`; Test: `backend/test/runtime/schedule-time.test.ts`

**Interfaces:**
- Produces: `normalizeDt(d: Date, tz: string): Date`、`parseHhmm(t: string): {h:number;m:number}`、`parseIsoOrNull(v: unknown): Date | null`、`shouldRun(lastRunAt: Date|null, now: Date, intervalSeconds: number): boolean`、`computeDailyFire(nowLocal: Date, hhmm: string): Date`、`computeWeeklyFire(nowLocal: Date, weekday: number, hhmm: string): Date`、`currentPeriodTarget(nowLocal: Date, spacingDays: number, hhmm: string, weekday?: number): Date`、`isReportDue(nowLocal: Date, lastRunAt: Date|null, target: Date): boolean`。
- 语义 1:1 照 `servermanage/scheduler.py:84-260`（`_align_pair` 处理 naive/aware 对齐）。

**Steps:** [ ] 写测试表（含跨日、跨周、`<=2d`→今日、`<=14d`→本周、否则下次）；[ ] 跑测试确认失败；[ ] 实现；[ ] 测试通过；[ ] 报告。

### Task 2: 调度器核心 `backend/src/runtime/scheduler.ts`

**Files:** Create: `backend/src/runtime/scheduler.ts`; Test: 同目录 test

**Interfaces:**
- Consumes: Task1、`storage/tasks.ts` 的 `getTaskState/setTaskState`。
- Produces: `interface ScheduledTask {name; intervalSeconds?; calendar?: {kind:'daily'|'weekly'; hhmm; weekday?}; run: () => Promise<string>}`、`class Scheduler {constructor(tasks, {db, now?, tick?}); runPending(): Promise<string[]>; start(); stop(); isDue(task, now); defaultTick(tasks)}`。
- `runPending` 顺序执行、单任务异常捕获为 `error: ${name}: ${msg}`、仍写 `last_run_at`；`tick` 夹取 1..60s（`scheduler.py:321-457`）。

### Task 3: 告警规则纯函数 `backend/src/alerts/rules.ts`

**Files:** Create: `backend/src/alerts/rules.ts`; Test: `backend/test/alerts/rules.test.ts`

**Interfaces:**
- Produces: `fingerprintFor(...parts: string[]): string`、`evaluateSystemAlerts(report, rules, ctx): AlertEvent[]`、`effectiveThresholds(...)`、`evaluateAvailabilityAlerts(...)`、`evaluateUserAlerts(...)`、`evaluateDiskAlerts(report)`、`offlineAlert(host, failures)`、`recoveryEvent(host, category)`、类型 `AlertEvent`。
- 逐项移植 `servermanage/alerts.py:73-585`；阈值 `>=`、`null` 跳过、可用性仅 `failed`/`error` 为 critical。

### Task 4: 连续周期门控 + Silence `backend/src/alerts/streak.ts` + `silence.ts`

**Files:** Create: `backend/src/alerts/streak.ts`、`backend/src/alerts/silence.ts`; Test 各一。

**Interfaces:**
- Produces: `class StreakTracker {observe(host, fingerprint, present: boolean, effectivePeriods: number): {trigger:boolean; recover:boolean}; reset()}`、`effectivePeriods(...)`（per-host 覆盖 > alerts.consecutive_periods 默认 2 clamp 1..10）；`class SilenceRegistry {constructor(db); activeFor({host, group, category, fingerprint}, now): {silenced:boolean; reason?:string}}`（优先级 all>group>host，每次读库）。

### Task 5: 通知通道 `backend/src/alerts/{mailer,webhook,desktop}.ts`

**Files:** Create 三个；Test 各一（全部注入 fake transport / fetch）。

**Interfaces:**
- `sendReport(smtp, message, {smtpFactory?, retries=3, delayMs=3000})`：线性重试 3 次，认证失败立即中止（`mailer.py`）。
- `buildWebhookPayload(kind, event)`、`sendWebhook(kind, event, config, {fetchImpl, timeoutMs=10000})`：wecom/dingtalk/feishu/通用；2xx 且 `errcode===0` 才成功（`notify_webhook.py`）。
- `sendDesktopNotification(title, message, {bridge?})`：桌面桥可用则用，缺失返回 `false` 永不抛（`notify_desktop.py` → Electron `Notification` 由 P6 桥接）。

### Task 6: AlertEngine `backend/src/alerts/engine.ts`

**Files:** Create: `backend/src/alerts/engine.ts`; Test: `backend/test/alerts/engine.test.ts`

**Interfaces:**
- Consumes: Task3/4、`storage/alerts.ts`（insertAlert/updateAlert/findLatestAlert/listOpenAlertsForHost/listAlertsForHost）、Task5 notifier。
- Produces: `class AlertEngine {constructor({db, notifier, silences, config, now?}); process(events): AlertEvent[]; resolve(host, category, opts?); resolveMissing(host, presentFingerprints); openAlertFingerprints(host); shouldSkip(event, now)}`。
- `_should_skip`：`error_increase` 必发；`acknowledged` 抑制；无 `notified_channels`⇒重试不消耗冷却；否则 `cooldown_minutes` 默认 60，`repeat_while_active=false` 时仅更高严重度再通知。聚合 `aggregate_by_host`："主机 X N 项告警"（`alerts.py:883-1366`）。

### Task 7: 可用性巡检 `backend/src/runtime/availability.ts` + 注入

**Files:** Create: `backend/src/runtime/availability.ts`; Modify: `backend/src/web/composition.ts`（注入 `hosts.runHostChecks`、`hosts.prepareHostCheck`）; Test 各一。

**Interfaces:**
- Produces: `validateCheckTarget(checkType, target): string`、`buildCheckCommand(check): string`、`parseCheckResult(check, result): HostCheckResult`、`runHostChecks(host, checks, runner, {timeoutMs})`（`availability.py:37-341`）。
- 注入：`hosts.runHostChecks = (host, checks) => runHostChecks(host, checks, runnerFromHost(host))`、`prepareHostCheck = payload => coerceHostCheck(payload)`；target 含控制字符/空格必须 `CheckTargetError`。

### Task 8: 维护与日志清理 `backend/src/runtime/maintenance.ts` + `log-cleanup.ts`

**Files:** Create: `backend/src/runtime/maintenance.ts`、`backend/src/runtime/log-cleanup.ts`; Modify: `backend/src/web/routes/system.ts` 仅在必要处接入 `pruneLogFiles`; Test 各一。

**Interfaces:**
- `directorySize(path)`、`storageUsage(dbPath)`、`cleanupLogs(logDir, retentionHours, now)`、`cleanupUpdates(dir, keep)`、`cleanupElectronCache(dir)`（`maintenance.py`）；`pruneLogFiles(logDir, retentionHours, now)`（`log_cleanup.py`）。

### Task 9: 运行时锁/端口 `backend/src/runtime/instance.ts`

**Files:** Create: `backend/src/runtime/instance.ts`; Test 同目录。

**Interfaces:**
- `findAvailablePort(host, preferred, span=20): Promise<number>`、`writeRuntimeState(path, {url,port,pid})`、`readRuntimeState(path)`（与 `runtime.py:157-216` 对齐；单实例锁由 Electron `requestSingleInstanceLock` 承担，本任务不复刻 mutex）。

### Task 10: 服务装配调度循环 `backend/src/server.ts`（Modify）

**Files:** Modify: `backend/src/server.ts`; Create: `backend/src/runtime/wiring.ts`; Test: `backend/test/runtime/wiring.test.ts`

**Interfaces:**
- `buildScheduledTasks({db,config,schedulerDeps})`：`collect`（interval=poll_interval_seconds）、`daily-report`/`weekly-report`（calendar）、`prune`、`user-scan`（若 P5 未就绪则留空钩子）；`startSchedulerIfConfigured(db,config)` 在 `startServer` 有 db/config 时启动，`close()` 时 stop。
- 测试用 fake clock + 注入任务，断言 tick 语义与 catch-up（不真跑 600s）。

### Task 11: 差分/对照测试 `backend/test/diff/scheduler-alerts/`

**Files:** Create: `run_schedule_oracle.py`、`fixtures/*.json`、`scheduler-alerts-diff.test.ts`

**Interfaces:** 对 `shouldRun`/`isReportDue`/`currentPeriodTarget` 的 20+ 时间点表、以及 `AlertEngine` 状态机 12 个剧本（抖动/冷却/ack/silence/恢复/聚合/重试）与 Python oracle 结果 `diff==[]`。

### Task 12: 验收 `docs/superpowers/plans/p4-acceptance.md`

**Files:** Create 上述文档；门禁：typecheck 0、vitest 全绿（不回退）、`python -m pytest -q` 1892 passed/1 skipped、`servermanage/**` 零改动、bundle smoke 通过。

## P4 DoD

- 调度器在 fake clock 下 catch-up 语义与 oracle 一致（日报/周报各补 1 次）。
- 告警引擎 12 剧本与 oracle 对照 `diff==[]`；通知三通道单测覆盖重试/部分失败/永不抛。
- `hosts.runHostChecks`/`prepareHostCheck` 已注入真实实现（巡检可执行，target 校验生效）。
- 全量测试不回退，Python pytest 1892/1，工作树干净（lead 提交）。
