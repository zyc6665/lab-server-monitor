# P4 验收报告：调度 / 告警 / 通知

阶段：P4（设计 §8 路线表）— 分支 `refactor/single-stack-b1`
状态：**DONE**（2026-11-26）

## 交付

| 任务 | 提交 | 内容 |
| --- | --- | --- |
| 计划 | `75bb146` | 12 任务计划 |
| T1 | `4c609e1` | `src/runtime/schedule-time.ts`：naive↔UTC 瞬时/civil 墙钟换算、`shouldRun/isReportDue/currentPeriodTarget/computeDailyFire/computeWeeklyFire`（53 测试） |
| T2 | `02e41e1` | `src/runtime/scheduler.ts`：`ScheduledTask`/`Scheduler`（interval + calendar、catch-up、tick 1–60s、失败仍占槽）（26） |
| T3 | `9227a7e` | `src/alerts/rules.ts`：系统/可用性/用户/磁盘告警规则、`fingerprintFor`、中文文案（60） |
| T4 | `941885c` | `src/alerts/streak.ts`（连续门控）、`src/alerts/silence.ts`（all>group>host，含 category/fingerprint 窄 scope）（42） |
| T5 | `c955f43` | `src/alerts/{mailer,webhook,desktop}.ts`：SMTP 重试、webhook 四类 payload、桌面通知永不抛（33） |
| T6 | `8f25805` | `src/alerts/engine.ts`：`AlertEngine`/`Notifier`（silence→streak→冷却/ack/重试→聚合→持久化→分发→恢复）（44） |
| T7 | `ebde6fc` | `src/runtime/availability.ts`：tcp/http/process/service 检查、`runHostChecks`；composition 注入（114） |
| T8 | `929b8f1` | `src/runtime/{maintenance,log-cleanup}.ts`：目录大小、日志/更新/缓存清理（31） |
| T9 | `bdf5c9b` | `src/runtime/instance.ts`：端口选择、`runtime.json` 读写（19） |
| T10 | `33bc8b0` | `src/runtime/wiring.ts`（collect/daily-report/weekly-report/prune）+ `server.ts` 启停调度 + hosts 巡检延迟字段映射 + system 轮转日志清理 |
| T11 | `62b32d3` | `test/diff/scheduler-alerts/`：Python oracle 对照（26 时间点、12 剧本，`diff==[]`） |
| T12 | 本文件 | 验收 |

## 门禁（最终实测）

- `pnpm --filter servermonitor-backend typecheck` → exit 0
- `pnpm --filter servermonitor-backend build` → `dist/main.cjs` 1,924,007 字节；bundle smoke 通过
- `pnpm --filter servermonitor-backend test` → **76 files / 1472 passed / 1 skipped**
- `python -m pytest -q` → **1892 passed / 1 skipped**（114.26s）；`git status servermanage` 为空（Python 零改动，仍为行为 oracle）

## 已知差异（有意/待后续阶段）

- `AlertEngine` 为 async（Node 无法同步阻塞 SMTP/HTTP）；Python 的连续周期门控在 `app.py`，Node 折叠进 `engine.process`。
- `resolve` 不改时间戳：全仓库与 Python 存储层均无 `resolved_at` 列。
- `streak` 触发用 `=== periods`，Python 用 `>= periods`；仅当运行中热更新调小 periods 时有差异（已在 `streak.test.ts` 记录）。
- `recover` 需调用方以"该指纹存在 open 告警"门控（engine 内已按 `open_alert_fingerprints` 处理）。
- `daily-report` / `weekly-report` 已注册但 `run` 为占位 `skipped: report not migrated`（TODO **P5**）。
- `prune` 用完整 `pruneRetention`（比 oracle 的 `retention_cleanup` 子集更宽，有意）。
- 未注册 `disk_poll` / `user_scan` 任务（属 P5 磁盘/用户迁移）。
- `collect` 任务：仅 `success:true` 报告进历史，快照按报告尽力写（storage 语义）。

## 残留占位（后续阶段吸收）

- `collectHosts` / `collectionStatus` 聚合视图、`users` 监控服务、SSH session manager。
- 报表生成与邮件发送（P5）。
