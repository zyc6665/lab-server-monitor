# P2 阶段一验收（v0.3.1：M7 账号策略 + M5 报表中心）

日期：2026-11-27
计划：`docs/superpowers/plans/2026-11-26-p2-module-optimization-plan.md`

## 交付

### M7 账号策略
- `backend/src/config/schema.ts`：`FieldType` 新增 `object_list`；`user_monitoring.account_policy`（naming_regex / templates[] / default_template / expiry_days）。
- `backend/src/users/admin.ts`：`AccountPolicy` / `AccountPolicyTemplate` 类型；`buildPlan` 读取策略——命名不合规 → `blocked=true` + 中文原因；模板生成附加组（`gpasswd -a`）与 sudo 白名单（`/etc/sudoers.d/<name>`）步骤；`expiry_days>0` 追加 `chage -E <UTC日期>`；全部物化为 `steps`，`plan_hash` 自动覆盖。
- `backend/src/web/routes/users.ts` + `backend/src/users/execute-service.ts`：`/api/users/plan` 读取 `loadEffectiveSettings(db).user_monitoring.account_policy` 并透传到 `buildPlan`（修复"策略休眠"）。
- `settings.html` / `settings.js`：只读命名规范、默认模板、有效期、模板 JSON 编辑（含 JSON 编解码）。

### M5 报表中心
- 新表 `report_runs`（storage/schema.ts，23 表 / 44 语句）。
- `backend/src/storage/report-runs.ts`：record/list/latest/prune。
- `backend/src/web/routes/reports.ts`：`GET /api/reports/preview`、`GET /api/reports/history`、`POST /api/reports/send`、页面 `GET /reports`。
- `backend/assets/web/templates/reports.html` + `static/pages/reports.js`（sandbox iframe 预览、发送、历史轮询，textContent-only）；导航「报表」。

## 门禁
- 后端 vitest **120 files / 2093 passed / 1 skipped**；`tsc --noEmit` 0。
- 桌面 `pnpm run test:unit` **132 passed**；typecheck 0。
- 新增测试：`test/config/account-policy.test.ts`(6)、`test/users/account-policy.test.ts`(9)、`test/storage/report-runs.test.ts`(7)、`test/web/reports-routes.test.ts`(9)。

## 残余/后续（v0.3.2、v0.3.3）
- M8 设置中心（搜索/校验/变更历史）、M2 数据治理（保留策略/自动备份/体积趋势）。
- M11 桌面健壮性（崩溃日志、更新失败提示、启动自检）。
- M7 可选增强：模板跨字段校验（重名/默认模板不存在）。
