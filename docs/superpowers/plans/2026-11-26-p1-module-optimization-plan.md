# P1 核心监控闭环实施计划（v0.3.0）

日期：2026-11-26
设计：`docs/superpowers/specs/2026-11-26-module-optimization-design.md` §6
基线：v0.2.13

## Goal

交付 P1 三个模块：采集阶段耗时与失败重试可见（M1）、任务中心（M3）、告警中心批量操作与投递失败可见可重发（M4），发布 v0.3.0。

## 技术栈 / 约束

- 单栈：Electron + Node/TS 后端（Express + better-sqlite3 + Nunjucks），无 Python。
- 所有写操作在 `better-sqlite3` 事务内；时间统一 `nowIsoUtc()`（UTC 微秒）。
- 新表通过 `backend/src/storage/schema.ts` 的 `CREATE TABLE IF NOT EXISTS` 幂等落库（已加 `task_runs`、`alert_delivery_failures`）。
- 前端为原生 ES module（`backend/assets/web/static`），禁用 innerHTML 拼接，DOM 用 createElement/textContent。
- 单飞：同名任务同一时刻只允许一个执行实例（进程内表 + `task_runs` 状态）。
- 测试：vitest（backend）、vitest（desktop）；新增/修改须保持全绿。

## Review Focus

1. 单飞锁必须覆盖「调度器触发」与「手动触发」两条路径，不能各用一把锁。
2. `task_runs` 只保留最近 200 条（prune 任务清理），避免无限增长。
3. 投递失败记录必须逐通道写入，且重发只重试失败通道，不重复成功通道。
4. 阶段耗时不得改变既有 `HostReport` 结构兼容性（读旧快照仍可用）。
5. 批量操作需校验 ids 上限（≤200），防止超大请求。

## 任务

### Track A — 采集可视化与重试（M1）

- **A1** `backend/src/collect/types.ts`：`StageTiming {stage, ms, ok, error?}`；`HostReport.stageTimings?: StageTiming[]`。
- **A2** `backend/src/collect/collectors.ts`：逐阶段计时；失败阶段按 `monitoring.stage_retries`（0–3，默认 1）重试一次并累加耗时；`stageTimings` 随报告返回；`collectAllHosts` 透传。
- **A3** 设置：`backend/src/config/schema.ts` + `defaults.ts` 的 `monitoring` 段新增 `stage_retries`（integer 0..3，默认 1）。
- **A4** 主机详情：`backend/src/web/routes/overview.ts` 的 `HostDetail` 透出 `stage_timings`（读快照 raw_json 内的 `stageTimings`）；`backend/assets/web/templates/host.html` 增加折叠面板「采集耗时」（表格：阶段/耗时/状态/错误）。
- 验收：单测覆盖「成功计时」「失败重试一次」「stage_retries=0 不重试」；页面渲染面板。

### Track B — 任务中心（M3）

- **B1** 新增 `backend/src/storage/task-runs.ts`：`recordTaskRunStart/Finish`、`listTaskRuns(limit)`、`pruneTaskRuns(keep=200)`、`latestRunByTask()`。
- **B2** `backend/src/runtime/scheduler.ts`：运行前后写 `task_runs`（trigger: schedule|manual），运行中维护进程内 `running` 集合（单飞）；`runTaskNow(task)` 供手动触发（运行中返回 `task_running`）。
- **B3** 新增 `backend/src/web/routes/tasks.ts`：`GET /api/system/tasks`（`{name, schedule, next_run_at, last_run_at, last_result, running, last_duration_ms}`）、`POST /api/system/tasks/:name/run`（管理员 + CSRF；409 `task_running`；202 `{ok,run_id}`）；`registerTasksRoutes` 导出，由组合根装配。
- **B4** 页面：`backend/assets/web/templates/tasks.html` + `backend/assets/web/static/pages/tasks.js`（5s 刷新、手动触发按钮、状态徽标）；`base.html` 导航加入「任务」入口；`routes/registry.ts` 增端点。
- 验收：任务列表随设置动态变化；手动触发 running→ok；并发触发 409。

### Track C — 告警中心（M4）

- **C1** 新增 `backend/src/storage/alert-delivery.ts`：`recordDeliveryFailure(alertId, channel, target, error)`、`listDeliveryFailures(alertId?)`、`pruneDeliveryFailures(days=30)`。
- **C2** `backend/src/alerts/engine.ts`：`dispatch` 结果逐通道失败写 `alert_delivery_failures`（成功通道不写）。
- **C3** `backend/src/web/routes/alerts.ts`：`POST /api/alerts/bulk/ack`（ids≤200）、`POST /api/alerts/bulk/silence`、`GET /api/alerts/delivery-failures`、`POST /api/alerts/:id/resend`（仅失败通道，成功返回 `{ok,resent:[...]}`）。
- **C4** `backend/assets/web/templates/alerts.html` + `static/pages/alerts.js`：多选列、批量操作条、筛选（主机/类别/状态）、投递结果列与「重发失败通道」按钮。
- 验收：批量确认 3 条成功；静默后新告警不通知；失败通道可见且仅重发失败通道。

### Track D — 验收与发版

- `docs/superpowers/plans/2026-11-26-p1-acceptance.md`；CHANGELOG v0.3.0；版本号 0.3.0；发布 release workflow。
- 门禁：backend 全量 vitest 绿、typecheck 0；desktop typecheck 0、test:unit 绿；安装包构建成功。

## 执行切分（写作用域）

| 代理 | 文件 |
| --- | --- |
| impl-p1-collect | `backend/src/collect/collectors.ts`、`types.ts`、`backend/src/config/schema.ts`、`defaults.ts`、`backend/src/web/routes/overview.ts`、`backend/assets/web/templates/host.html`、对应测试 |
| impl-p1-tasks | `backend/src/storage/task-runs.ts`、`backend/src/runtime/scheduler.ts`、`backend/src/web/routes/tasks.ts`、`templates/tasks.html`、`static/pages/tasks.js`、`templates/base.html` 导航、`routes/registry.ts`、对应测试 |
| impl-p1-alerts | `backend/src/storage/alert-delivery.ts`、`backend/src/alerts/engine.ts`、`backend/src/web/routes/alerts.ts`、`templates/alerts.html`、`static/pages/alerts.js`、对应测试 |
| lead | `backend/src/storage/schema.ts`（已加表）、`backend/src/web/composition.ts` 装配、验收与提交 |