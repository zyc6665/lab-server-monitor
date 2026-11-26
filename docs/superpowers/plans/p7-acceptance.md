# P7 验收与回归矩阵（Task 5）

分支：`refactor/single-stack-b1` 日期：2026-11-26（Asia/Shanghai） 本任务未改动 `servermanage/` 与产品代码，未 commit/push。

## 1. 端点覆盖

### 1.1 只读端点差分 `backend/test/diff/http/full-read-diff.test.ts`

- MATRIX 共 **34** 个请求：json 22 / page 9 / status 2 / text 1（守卫：≥34、json≥22、page≥8）。
- 结果：**32 pass + 2 allowlisted-diff，0 fail**；2 个 test 全部通过。
  - allowlisted：`/api/host/lab-01`（8 处差异）、`/api/users`（14 处差异）。
  - 观察项（非失败）：`/api/hosts`、`/api/disk-health` 在两栈均非路由，仅比状态码；404 content-type 不同（Node `application/json` / Python `text/html`）。
- 覆盖：overview（含 capacity 7/30/90、history 24h/7d/30d/90d、alert-history 7d）、settings / settings/hosts / collection-status、host detail/history/report、alerts、users / history / top / operations、system health/storage/host-keys，页面 `/ /hosts /host/lab-01 /alerts /settings /users /compute /disk-health /my`。

### 1.2 写流程差分 `backend/test/diff/http/write-flow-diff.test.ts`

- STEPS **10** 步：a_monitoring(PUT settings/monitoring)、b_alerts(PUT settings/alerts)、c_silence_add(POST silences)、c_alerts_after_silence(GET alerts?status=all)、c_silence_delete、d_ack(POST alerts/4/ack)、e_host_add(PUT hosts/lab-03)、e_hosts_after_add、e_host_delete、f_checks_run(POST host/lab-01/checks/run)。
- 用例 **19**：登录 1 + 每步 10 + silence/ack 语义 1 + 表比对 7。
- 表比对 7 张全部一致：`app_settings`、`app_secrets`、`alerts`、`alert_silences`、`host_latest_snapshot`、`host_check_history`、`host_check_snapshot`（`app_settings` 仅排除 allowlist 中的 `security` 段）。

## 2. Allowlist 条目与原因

来源：`backend/test/diff/http/read-allowlist.ts`

| 项 | 内容 | 原因 |
|---|---|---|
| ALLOWED_DIFFS `/api/users` | sudo 标志命名 + Node 独有 `usage_scan` | P5 记录：Node `sudo_ok` vs Python `sudo_<flag>`；`usage_scan` 为 Node 实时进度增强 |
| ALLOWED_DIFFS `/api/host/:name` | 摘要粒度 | Node 返回精简摘要；Python 返回完整页面上下文（alert_days/check_history/diagnostics/network/users 等），仅匹配两段路径，history/report 仍需完全一致 |
| VOLATILE_KEYS | generated_at, generatedAt, last_run_at, now, age_seconds, uptime_seconds | 请求时刻 now() 派生 |
| GLOBAL_MASK_KEYS | port, pid, url, runtime | 进程/环境指纹 |
| ENDPOINT_MASKS | `/api/settings`、`/api/settings/hosts`: key_path；`/api/system/health`: db_path, db_size_bytes, usage；`/api/system/storage`: db_path, usage | 路径分隔符拼写 / 各自临时库路径与磁盘用量 |
| ARRAY_SORT_KEY_PRECEDENCE | id, index, host_name, name, username, key, t, timestamp, start, day, host, label | 数组顺序无关化 |

归一化：ISO 时间按 µs 精度转回 UTC 瞬时值比较；浮点 `toFixed(6)`；对象键按集合比较。

`write-flow-diff.test.ts` 的 `WRITE_FLOW_ALLOWED_SECTIONS`：

- `security`：Python 独有的启动迁移标记。`servermanage/settings/core.py:66 _ensure_machine_binding` 写入 `machine_id`；`servermanage/settings/admin.py:139-151` 写入 `migrated_at`；`admin.py:209-217` 写入 `sudo_migrated_at`。Node 无 legacy YAML 导入 / DPAPI 机器绑定，写序列中没有步骤产生它。

## 3. E2E 链路 `backend/test/e2e/collect-e2e.test.ts`

3 个用例全部通过（基于真实 ssh2 桩服务器）：

1. 桩可应答单个 stage（hostname）。
2. 采集全部 **21** 个 stage（断言桩收到的命令数 = 21），产生 warning 级系统告警 `system:gpu-e2e-01:cpu`，availability 告警含 critical `availability:gpu-e2e-01:jupyter`，并完成报告渲染（text/html 正文）。
3. 错误密码：以认证错误拒绝，进程不崩溃。

三文件定向复跑：3 files / **24 tests passed**，17.88s。

## 4. P7 期间修复的真实差异

| 提交 | 修复 |
|---|---|
| 2937d71 | `toLocalIso` µs 精度抽为共享模块 `backend/src/web/local-iso.ts`（此前毫秒截断与 Python 6 位小数不一致）；同时落地完整只读差分 |
| 81e64a2 | E2E：真实 ssh2 桩上的采集链路 |
| eff721c | `saveSection` 只持久化提交的字段，`user_monitoring` 改为合并而非覆盖；check `timeout_seconds` 默认 5（与 Python 一致）；写流程差分 |

## 5. 三门禁复跑（2026-11-26 实测）

| 门禁 | 命令 | 结果 | 耗时 |
|---|---|---|---|
| Python | 仓库根 `python -m pytest -q`（pyproject：testpaths=tests） | **1892 passed, 1 skipped, 0 failed** | 128.06s |
| Node typecheck | `cd backend && pnpm run typecheck` | 通过（tsc --noEmit，exit 0） | — |
| Node test | `cd backend && pnpm test` | 97 files；**1925 passed, 1 skipped**（共 1926），0 failed | 33.69s |
| desktop typecheck | `cd desktop && pnpm run typecheck` | 通过 | — |
| desktop test:unit | `pnpm run test:unit`（vitest） | 5 files；**116 passed** | 0.57s |
| desktop test | `pnpm test`（node --test） | **94 pass, 0 fail, 0 skipped** | 7.33s |
| desktop lint | — | `desktop/package.json` 无 lint 脚本，未执行 | — |

备注（如实记录）：首次 Python 运行在测试结束后的 pytest 临时目录清理阶段打印 `PermissionError: [WinError 5]`（`%TEMP%\pytest-of-Administrator\pytest-current` 符号链接无法 unlink），进程 exit 0；属于 Windows 环境的 pytest 收尾问题，非测试失败。二次运行（`-p no:cacheprovider`）得到上表摘要行。
