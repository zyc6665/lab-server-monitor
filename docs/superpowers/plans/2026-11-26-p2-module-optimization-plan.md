# P2 功能深度实施计划（v0.3.1 – v0.3.3）

日期：2026-11-26
设计：`docs/superpowers/specs/2026-11-26-module-optimization-design.md` §7
基线：v0.3.0

## 发布切分

| 版本 | 模块 | 交付 |
| --- | --- | --- |
| v0.3.1 | M7 账号策略 + M5 报表预览/历史 | 命名规范与模板、chage 过期；报表预览/立即发送/发送历史 |
| v0.3.2 | M8 设置中心 + M2 数据治理 | 设置搜索/校验/未保存提醒/变更历史；保留策略/自动备份/体积趋势 |
| v0.3.3 | M11 桌面健壮性 | 崩溃日志、更新失败提示与日志入口、启动自检 |

## 通用约束

- 单栈 Node/TS；新表用 `CREATE TABLE IF NOT EXISTS` 幂等建表；时间 `nowIsoUtc()`。
- 变更历史只记录键名/是否改动，**绝不记录值**（含密钥）。
- 每版门禁：backend vitest 全绿 + typecheck 0；desktop typecheck 0 + test:unit 绿；安装包构建成功。

## v0.3.1

### M7 账号策略
- `user_monitoring.account_policy`：`naming_regex`（默认 `^[a-z][a-z0-9_-]{2,15}$`）、`templates`（standard/developer/readonly，含附加组与 sudo 命令白名单）、`default_template`、`expiry_days`（0=永不）。
- `users/admin.ts`：命名不合规 → plan `blocked`（中文原因）；模板生成附加组与 sudo 步骤；`expiry_days>0` 追加 `chage -E` 步骤；`plan_hash` 覆盖新字段。
- 设置页 user_monitoring 面板：正则只读展示、模板列表编辑、有效期天数。
- 测试：不合规 blocked；developer 模板步骤；90 天 chage 步骤。

### M5 报表预览/历史
- 新表 `report_runs(id, kind, variant, status, error, sent_at, recipients, created_at)`，保留最近 200 条。
- `GET /api/reports/preview?variant=technical|executive|weekly`（管理员；用现有 buildDailyReport/generateWeeklyReport + renderReport，返回 `{subject,text,html}`）。
- `GET /api/reports/history`（最近 50 条）。
- `POST /api/reports/send?variant=...`（立即发送，写 report_runs；SMTP 缺失 400 `smtp_not_configured`；失败记录 status=error 可重发）。
- 设置页 report 面板：「预览」（sandbox iframe/弹窗）、「立即发送」、「最近发送记录」。
- 测试：预览与 renderReport 输出一致；成功/失败写行；历史排序。

## v0.3.2

### M8 设置中心
- 新表 `config_history(id, section, changed_keys JSON, changed_by, changed_at)`，90 天清理；`saveSection` 成功后写（键名集合，值不落）。
- `settings.html/js`：左侧分组导航 + 搜索框（按标签/字段名过滤）、字段校验提示、未保存离开确认、sticky 保存条、底部「最近变更」。
- `GET /api/settings/history?limit=20`。
- 测试：搜索过滤、脏状态提示、变更历史无值字段。

### M2 数据治理
- `monitoring.retention`（metrics_days 90 / alerts_days 180 / disk_days 30 / users_days 180）；prune 任务读新值。
- `backup_schedule`（off/daily/weekly）+ `backup_keep`（7）；backup 任务写 `backups/auto-<date>.db` 并清理超额。
- 新表 `storage_samples(day, db_bytes, data_dir_bytes)`，每日采样保留 180 天；`/api/system/storage` 返回 `db_size_history`；设置页体积趋势。
- 磁盘健康趋势：主机级 status 曲线（近 7 天，不足提示）。
- 测试：prune 使用配置值；备份按份数清理；采样写入与查询。

## v0.3.3

### M11 桌面健壮性
- 主进程 `uncaughtException`/`unhandledRejection`/`render-process-gone` → `logs/crash-<ts>.log`；托盘「打开日志目录」增强。
- 更新页显示当前/最新版本与渠道；检查失败可重试并给出日志路径。
- 启动自检：数据目录可写、端口可用、后端健康 3 次失败弹窗 + 日志路径。
- 测试：崩溃写日志；更新失败提示；自检失败弹窗分支。

## 执行切分

- v0.3.1：`impl-p2-accounts`（M7）、`impl-p2-reports`（M5）；lead 负责 DDL/装配/验收。
- v0.3.2：`impl-p2-settings`（M8）、`impl-p2-data`（M2）；lead 负责 DDL/装配/验收。
- v0.3.3：`impl-p2-desktop`（M11）；lead 验收。
