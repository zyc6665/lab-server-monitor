# P7 差分验证与端到端实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用现有 Python 实现作为 oracle，对 Node 单栈后端做全量差分回放（读端点 + 写流程），并用真实 SSH 桩跑通一条端到端采集/告警/报表链路，证明行为等价。

**Architecture:** 单一共享种子数据库（Python 生成），双栈各自启动只读/读写副本，规范化后逐端点/逐流程比对；E2E 用 Node `ssh2` 服务器桩模拟被监控主机，驱动已打包后端完成一次采集周期。

**Tech Stack:** TypeScript / vitest / better-sqlite3 / ssh2 / Node http；oracle 侧复用 `servermanage` + Flask test client。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md` §9（差分与验收策略）

## Global Constraints

- 不得修改 `servermanage/`（Python 仅作 oracle，`git diff main..HEAD -- servermanage/` 必须为空）。
- Python 基线始终 1892 passed / 1 skipped。
- 所有 Node 侧新增文件须 `tsc` 0 错、vitest 全绿且不得回退既有计数。
- 差分归一化仅允许：时钟冻结、端口/pid 掩码、μs 截断、浮点 1e-6、显式排序键、易变实时字段排除（见 spec §9.1）；不得为「对齐」而放宽到忽略业务字段。
- 已知差异必须显式列入 allowlist 并附原因，不得静默通过。

## Review Focus

1. 分页/区间边界（`days`/`range` 非法值、`limit` 边界）两栈返回码与报文一致。
2. 时区与时间格式（墙钟 vs UTC 微秒）跨午夜/夏令时的呈现一致。
3. 空数据集（无主机、无指标、无告警）页面与 API 不 500、结构稳定。
4. 写流程的事务副作用（silence 生效转 resolved、ack 状态、设置持久化）与 Python 落库一致。
5. SSE/长连接与错误路径（SSH 认证失败、主机不存在）的报文与状态码一致。

---

### Task 1: 共享种子数据库生成器

**Files:**
- Create: `backend/test/diff/seed/build_seed.py`
- Create: `backend/test/fixtures/seed/servermonitor-seed.db` (generated)
- Test: `backend/test/diff/seed/seed.test.ts`

**Interfaces:**
- Produces: `build_seed.py` 生成一个含 ≥3 主机、90 天指标、若干告警/静默/磁盘/用户数据的 SQLite 库；`seed.test.ts` 断言表/行数与时间格式。

- [ ] 用 `servermanage.storage` 直接构造种子库（避免手工 SQL 漂移），写入 `backend/test/fixtures/seed/servermonitor-seed.db`。
- [ ] 测试断言：`host_latest_snapshot` ≥3 行；`host_metrics_history` 覆盖 90 天；存在 active/ack/resolved 告警各 ≥1；存在 1 条 silence；`collected_at` 全部匹配 `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$`。
- [ ] Commit `test(p7): shared differential seed database`.

### Task 2: 全量只读端点差分

**Files:**
- Create: `backend/test/diff/http/full-read-diff.test.ts`
- Create: `backend/test/diff/http/read-allowlist.ts`
- Modify: `backend/test/diff/http/dump_python.py`（如需扩展 dump 范围）

**Interfaces:**
- Consumes: Task 1 种子库；Python 侧用 Flask test client 对每个 GET 端点 dump JSON/HTML。
- Produces: 逐端点 `deepEqual(normalize(node), normalize(python))`；allowlist 之外 0 差异。

- [ ] 枚举所有 GET 端点（`/api/overview*`, `/api/settings`, `/api/hosts`, `/api/host/:name*`, `/api/alerts`, `/api/users*`, `/api/system/*`, `/api/disk*`, 页面 `/`, `/hosts`, `/host/:name`, `/alerts`, `/settings`, `/users`, `/compute`, `/my*`）。
- [ ] 规范化：掩码 `port/pid/url`、µs→ms、浮点 1e-6、数组按显式 key 排序、排除 `generated_at/last_run_at` 等易变字段（写入 `read-allowlist.ts` 注释原因）。
- [ ] 断言：allowlist 外差异为 0；已在 P5 记录的 2 处已知差异（`/api/users` sudo 标志、`/api/host/:name` 摘要粒度）保留在 allowlist。
- [ ] Commit `test(p7): full read-endpoint differential against python oracle`.

### Task 3: 写流程差分

**Files:**
- Create: `backend/test/diff/http/write-flow-diff.test.ts`

**Interfaces:**
- Consumes: Task 1 种子库副本；两栈各跑同一操作序列。
- Produces: 操作后 DB 快照（按表 dump 排序）逐表相等；HTTP 状态与关键字段相等。

- [ ] 序列：setup→login（建 session）；PUT `/api/settings/monitoring`；POST/DELETE `/api/settings/silences`（验证范围内 open 告警转 resolved）；POST `/api/alerts/:id/ack`；PUT `/api/settings/hosts` 增删主机；POST `/api/host/:name/checks/run`（打桩）。
- [ ] 比对：`app_settings`、`app_secrets`（仅键名集合）、`alerts`、`alert_silences`、`host_latest_snapshot` 表 dump；状态码与响应关键字段。
- [ ] Commit `test(p7): write-flow differential and transactional side effects`.

### Task 4: 端到端采集链路（真实 ssh2 桩）

**Files:**
- Create: `backend/test/e2e/fake-ssh-server.ts`
- Create: `backend/test/e2e/collect-e2e.test.ts`
- Create: `backend/test/e2e/fixtures/*.txt`（各 stage 命令的 stdout 样例）

**Interfaces:**
- Produces: `startFakeSshServer({commands}) → {port, close}`（基于 `ssh2.Server`，按命令回放 fixture）。
- 验证：`collectHostReport` 经真实 SSH 连接完成 21 stage，产出 HostMetrics；随后告警引擎对高 CPU 触发 alert；`renderReport` 生成日报非空。

- [ ] 桩服务器支持密码认证、exec 通道，按 `command` 返回对应 fixture，未知命令返回空成功。
- [ ] 测试：连接→采集→`parseHostMetrics` 字段齐全；注入 95% CPU 数据→`evaluateSystemAlerts` 产生 critical 事件；`renderReport` text/html 非空且含主机名。
- [ ] Commit `test(p7): end-to-end collect-alert-report over real ssh2 stub`.

### Task 5: 验收与回归矩阵

**Files:**
- Create: `docs/superpowers/plans/p7-acceptance.md`

- [ ] 记录：端点覆盖数、差分通过数、allowlist 条目与原因、E2E 链路结果、Python/Node/desktop 三门禁数字。
- [ ] 复跑全量门禁并写入报告。
- [ ] Commit `test(p7): P7 acceptance report`.
