# P5 验收报告 — 报表 / 磁盘 / 用户（branch refactor/single-stack-b1）

日期：2026-11-26
计划：`docs/superpowers/plans/2026-11-26-p5-report-disk-users-plan.md`

## 范围
移植 `report.py` + 六模板渲染、`disk_health.py`、`disk_capacity.py`、`user_scan.py`、`user_admin.py`、`user_collection.py`、`usermode.py`、`weekly.py` 到 Node/TS，并接线调度任务（disk-poll / user-scan / daily-report / weekly-report）与 Web 组合根。

## 提交
| Task | commit | 内容 |
|---|---|---|
| plan | `cd5c825` | P5 实施计划（13 任务） |
| T1 | `80036c1` | users/usermode.ts（模式归一化，'admin'\|'user'） |
| T2 | `c0b682a` | disk/capacity.ts（挂载容量状态，warning90/critical95） |
| T3 | `9260e2f` | disk/parse.ts（storcli 解析，11 fixtures，oracle diff==[]） |
| T4 | `8d72825` | disk/evaluate.ts（健康评估，40 场景 diff==[]；media/other/error_increase=warning 按 Python） |
| T5 | `5e46c48` | disk/report.ts + collect.ts（snapshot→report，5 fixture diff==[]；微秒精度） |
| T6 | `8246490` | users/scan.ts（passwd/group/usage 解析，oracle diff==[]） |
| T7 | `12ca631` | users/admin.ts（buildPlan/PlanCache/executePlan + 防篡改/过期） |
| T8 | `b95d5f6` | users/collection.ts（runUserScan 编排 + 持久化） |
| T9 | `228c2ac` | report/model.ts + context.ts + svg.ts（6 daily/3 weekly/7 chart diff==[]） |
| T10 | `d5abfdf` | report/render.ts（六模板零改动，22 TEXT+22 HTML 逐字节相等） |
| T11a | `856bbf4` | report/assemble.ts + daily/weekly 报表任务（真实实现） |
| T11b | `6ae6586` | disk-poll/user-scan 任务 + composition 注入（users monitorService/admin、hosts collectHosts/collectionStatus、disk-health 汇总统一） |
| T12 | `eb2c674` | 跨栈 HTTP golden 差分（15 端点：13 精确一致 + 2 已知差异） |

## 门禁
- `pnpm --filter servermonitor-backend typecheck`：exit 0
- backend vitest：**91 files / 1833 passed / 1 skipped**（P4 末 76/1472）
- Python pytest：**1892 passed / 1 skipped**（`servermanage/` 零改动）
- 打包冒烟：见下（dist/main.cjs 构建 + smoke）

## 差分证据
- 磁盘：storcli 解析 11 fixture、评估 40 场景、report 5 组 snapshot 重建 —— 全部 `diff==[]`。
- 用户：passwd/group/usage 解析与 plan 结构与 Python oracle `diff==[]`。
- 报表：context 6/3/7 场景 `diff==[]`；六份模板渲染 22 TEXT + 22 HTML 与 Jinja2 逐字节相等。
- HTTP：`backend/test/diff/http/` 15 端点矩阵，13 精确一致（未登录 3 + 登录 10），2 已知差异见下。

## 已知差异（有据可查）
- `GET /api/users`：Node sudo 标志字段名为 `sudo_ok`（Flask 用不同命名），且 Node 额外附带 `usage_scan` 实时进度对象；底层数据一致，属 Node 增强。
- `GET /api/host/<name>`：Node 返回精简摘要，`alert_days/check_history/collection_uptime/diagnostics/network/uptime_strip/users` 由页面层另行组合（页面 context 由 overview builders 提供）。
- 泛化：jsonify 键序不保证、无 300s capacity 缓存（均为 P2 遗留，不影响语义）。

## 仍未接线（后续阶段）
1. 用户告警事件：`runUserScan` 未接收 AlertEngine，故 user added/removed 类告警事件暂未由采集路径发出（`evaluateUserAlerts` 规则已实现，留待 P6/P7 接线）。
2. SSH 执行 `PlanRunner`：`executePlan` 为同步而 `SshClient` 为异步，`runExecuteJob` 暂 undefined —— plan 预览/校验端到端可用，execute 仍留 running。
3. SSH session manager（终端代理）仍为占位（P6 Electron 集成阶段处理）。
4. settings schema `report` 段缺 `executive` 字段（测试经 `saveAppSettings` 注入；生产需补 schema）。

## 结论
P5 完成：报表/磁盘/用户逻辑 1:1 移植且差分全绿，调度任务与组合根已接线，Python 基线未受影响。进入 P6（Electron 集成）。
