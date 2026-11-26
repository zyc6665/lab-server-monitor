# P1 核心监控闭环验收（v0.3.0）

日期：2026-11-26
设计：`docs/superpowers/specs/2026-11-26-module-optimization-design.md` §6
计划：`docs/superpowers/plans/2026-11-26-p1-module-optimization-plan.md`
基线：v0.2.13

## 交付项

### M1 采集可视化与重试（Track A）
- `HostReport.stageTimings`：逐阶段 `{stage, ms, ok, error?}`；失败阶段按 `monitoring.stage_retries`（0–3，默认 1）重试一次，耗时累加；SSH 异常仍立即中止。
- 持久化：`toStorageReport` 写入 `stage_timings`（随快照 raw_json），`HostReportInput` 增可选字段；旧快照无该字段时详情返回空数组。
- 设置：`monitoring.stage_retries`（integer 0..3，默认 1），设置页新增输入框。
- 主机详情：`HostDetail.stage_timings` + `host.html` 折叠面板「采集耗时」（阶段/耗时/状态/错误，空态「暂无」）。
- 测试：`test/collect/collectors.test.ts`（7 例）、`test/web/host-stage-timings.test.ts`（7 例）、`test/config/schema.test.ts` 范围校验。

### M3 任务中心（Track B）
- 新表 `task_runs`（task/trigger/started_at/finished_at/status/error/duration_ms，保留最近 200 条）。
- 调度器：单飞（进程内 running 集合，调度与手动共用）、写 `task_runs`、`runTaskNow` 手动触发、`TaskRunningError`/`TaskNotFoundError`。
- API：`GET /api/system/tasks`、`POST /api/system/tasks/:name/run`（202/404/409 `task_running`）；`/tasks` 页面 + 导航「任务」，5s 刷新。
- 装配：`server.ts` 先起调度器再组合 Web，`composition.ts` 以 getter/实例注入 `registerTasksRoutes`（未启动时 GET `{tasks:[]}`、POST 503 `scheduler_unavailable`）。
- 测试：`storage-task-runs` 12、`scheduler-task-runs` 14、`web/tasks` 12。

### M4 告警中心（Track C）
- 新表 `alert_delivery_failures`（alert_id/channel/target/error/at，30 天清理）。
- 引擎：仅记录**抛错通道**的投递失败，成功通道不写；`notified_channels` 与重试/冷却语义不变。
- API：`POST /api/alerts/bulk/ack`（ids 1..200）、`POST /api/alerts/bulk/silence`（hours 1..720）、`GET /api/alerts/delivery-failures`、`POST /api/alerts/:id/resend`（仅失败通道；未知 404；再失败 502）。
- 页面：多选列、批量条（确认/静默+时长）、主机/类别/状态筛选、投递失败徽标与「重发失败通道」。
- 测试：`alert-delivery-storage` 7、`alerts/delivery-failures` 4、`web/alerts-track-c` 14。

## 门禁证据

- `pnpm --filter servermonitor-backend typecheck` → exit 0
- `pnpm --filter servermonitor-backend test` → **116 files / 2061 passed / 1 skipped**
- `cd desktop && pnpm exec tsc --noEmit` → exit 0
- `cd desktop && pnpm run test:unit` → **132 passed**
- `test/web/all-endpoints-smoke.test.ts` → `SMOKE problems: []`
- schema/legacy 兼容：22 张表（20 oracle + 2 Node-only）；旧库迁移与 `user_version` 不变。

## 已知差异 / 说明

- `task_runs` 与 `alert_delivery_failures` 为 Node-only 表，不参与 Python oracle 差分（golden 子集策略）。
- 「重发失败通道」默认 notifier 由 SMTP 设置构建；desktop 通道在无桌面桥注时重发会返回 502（后续可在组合根注入真实 notifier）。
- 批量确认按钮仍复用 app.js 的逐条 ack 循环；`/api/alerts/bulk/ack` 已实现并有测试，前端切换可后续跟进。
- `stage_retries` 未纳入 Python 差分（`/api/settings` 为 known difference，注释已更新）。