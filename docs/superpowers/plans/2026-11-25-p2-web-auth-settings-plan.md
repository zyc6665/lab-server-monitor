# P2 — Web / 认证 / 设置 迁移实施计划（Python/Flask → Node/Express+Nunjucks）

> **For agentic workers:** 本计划按任务逐条执行（subagent-driven）。步骤用 `- [ ]` 跟踪。

**Goal:** 在 `backend/src/{config,web}/*` 用 Express 5 + Nunjucks 1:1 复刻现有 Flask Web 层与设置契约：约 60 个路由、中间件链（setup 门控→CSRF→认证→user-mode 白名单）、设置 schema/校验/默认值、登录/密码/限流/SSRF；复用现有 `servermanage/web/static/` 与 15 个模板；保持 Python 基线不变。

**Architecture:** Express 应用 + 中间件复刻 Flask `before_request` 顺序；设置以 `storage.settings`（P1 已完成）为权威存储，`schema.ts` 定义字段/默认值/校验；模板用 Nunjucks + Jinja 兼容过滤器/全局（`url_for`/`asset_url`/`csrf_token`/`stamp`/`anchor`/`rate`/`format`/`tojson`）；前后端仍走 HTTP + JSON（前端 static 零改动）。

**Tech Stack:** Express 5、Nunjucks、better-sqlite3（P1）、`@primno/dpapi`（P1）、`cookie-session`/自实现签名 cookie、`node:crypto`（PBKDF2）、`node:dns`（SSRF）、vitest+supertest。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md`（§5、§6.2、§7、§9；Python 源码 `servermanage/web/*`、`servermanage/settings/*`、`servermanage/config.py` 为行为 oracle）。

## Global Constraints

- 路由、endpoint 名、URL 与 JSON 契约 **1:1**（前端 static 不改）。
- Cookie：名 `servermonitor_session`，`httpOnly`、`sameSite=Lax`、`secure` 默认关，`maxAge=session_lifetime_hours`（默认 12h）。
- 密码：PBKDF2-HMAC-SHA256，**200000** 轮，16B 随机 salt；常量时间比较；存 `{hash,salt,iterations,username}` 于 DPAPI blob `SECRET_ADMIN`。
- 登录限流：每 IP **60s 窗口 5 次失败，第 6 次 429**；`X-Forwarded-For` 仅直连为 loopback 时信任首跳；表上限 4096。
- SSRF：`dns.lookup` 后拒绝 loopback/private/link-local/reserved/multicast/unspecified（除非 `SSRF_ALLOW_PRIVATE` 或已在允许清单）。
- 设置默认值（照 `settings/schema.py`）：monitoring.poll_interval=600、concurrency=8；ssh.connect_timeout=10、command_timeout=20；alerts 阈值 cpu/mem/disk/gpu_memory=90、disk_temperature_c=55、cooldown_minutes=60、offline_failures=2、consecutive_periods=2(clamp 1..10)。
- 不修改 `servermanage/`（Python 保持 oracle 与基线绿：**1892 passed / 1 skipped**）。
- 时间/JSON/布尔格式沿用 P1 `nowIsoUtc`/`dumpJson`。
- 静态资源整目录复用 `servermanage/web/static/`；`<meta name="csrf-token">` 由模板注入。

## Review Focus（最易踩、测试须钉住）
1. 中间件**顺序**错误会把未初始化/未登录请求放行或返回错误状态码（`/api`→428/401/403；页面→`/setup`、`/login`、`/my`）。
2. CSRF 必须对所有 POST/PUT/DELETE 生效，**但 `/login`、`/setup` 例外**；token 不匹配→403。
3. 设置读取不得泄漏 secrets（只回 `<name>_configured`/`url_configured` 布尔）；`dashboard` 段保存返回 `restart_required`。
4. 限流需在**认证失败**时计数、成功登录清零；第 6 次 429。
5. SSRF 必须拦截 `127.*`/`10.*`/`172.16-31.*`/`192.168.*`/`169.254.*`/`::1`/`fc00::/7` 等，且 `localhost` 解析后按 IP 判定。

## File Structure

- `backend/src/config/`：`schema.ts`（字段/类型/默认值/校验）、`defaults.ts`、`service.ts`（DB 读写/合并/redaction）、`hosts.ts`（主机设置 CRUD/导入/probe）、`admin.ts`（维护/备份/导出/密钥状态）、`silences.ts`。
- `backend/src/web/`：`app.ts`（组装）、`middleware/`（`setup-guard.ts`、`csrf.ts`、`auth.ts`、`usermode.ts`、`errors.ts`）、`session.ts`、`security/`（`password.ts`、`ratelimit.ts`、`ssrf.ts`）、`templating.ts`（Nunjucks + 过滤器/全局 + url_for 映射）、`routes/`（按组：`auth.ts`、`overview.ts`、`hosts.ts`、`settings.ts`、`alerts.ts`、`users.ts`、`system.ts`、`pages.ts`、`ssh-terminal.ts`）。
- 复用：`servermanage/web/templates/`（15 个）、`servermanage/web/static/`。

---

### Task 1: 配置模块（config.py → config/）

**Files:** Create `backend/src/config/{paths,env,config}.ts`, `backend/test/config/*.test.ts`. Oracle `servermanage/config.py`(680).
**Interfaces — Produces:** `loadConfig(env?:NodeJS.ProcessEnv): AppConfig`（含 `dbPath`、`host`、`port`、`logDir`、`dataDir`、`servers: HostConfig[]`、`tls?`、`appVersion`）；`normalizeHost(raw)`。
- [ ] Step 1-4：测试 `loadConfig` 默认值/环境覆盖/路径解析/host 归一化（含内联 key_data、passphrase），实现，`pnpm --filter servermonitor-backend test` 绿。
- [ ] Step 5：commit `feat(p2): config module (paths/env/servers)`。

### Task 2: 设置 schema 与默认值（settings/schema.py+core.py → config/schema.ts+defaults.ts）

**Files:** Create `backend/src/config/{schema,defaults}.ts`, `backend/test/config/schema.test.ts`. Oracle `servermanage/settings/schema.py`(615)、`core.py`(149)。
**Produces:** `SETTINGS_SCHEMA: Record<section, FieldSpec>`、`DEFAULT_SETTINGS: Settings`、`validateSection(section, payload): {value,errors}`、`coerceSection`。
- [ ] Step 1-4：测试字段/类型/默认值/clamp（含 consecutive_periods 1..10、阈值 90/55）与 404/400 错误分支；实现；绿。
- [ ] Step 5：commit `feat(p2): settings schema + defaults + validation`。

### Task 3: 设置服务（合并 DB+默认、redaction、保存语义）

**Files:** Create `backend/src/config/service.ts`, `backend/test/config/service.test.ts`. Consumes P1 `storage/settings.ts`；Task 2。
**Produces:** `loadEffectiveSettings(db)`、`publicSettings(db)`（secrets→布尔）、`saveSection(db, section, payload): {restartRequired:boolean}`、`deleteSection`。
- [ ] Step 1-4：测试默认合并、secrets 脱敏、`dashboard`→`restart_required`、404/400；实现；绿。
- [ ] Step 5：commit `feat(p2): settings service (merge/redact/save)`。

### Task 4: 主机设置（settings/hosts.py → config/hosts.ts）

**Files:** Create `backend/src/config/hosts.ts`, `backend/test/config/hosts.test.ts`. Oracle `servermanage/settings/hosts.py`(612)。
**Produces:** `listHosts/upsertHost/deleteHost`、`previewHostImport`、`importHosts`、`parseSshConfig`、`previewSshConfigImport`、`testHostsBatch`（注入 runner 桩）。
- [ ] Step 1-4：测试 upsert/delete/import 预览/ssh-config 解析/批量测试（注入桩）；实现；绿。
- [ ] Step 5：commit `feat(p2): host settings CRUD/import/ssh-config`。

### Task 5: 设置 admin 与 silences（settings/admin.py + sections.py + silences.py）

**Files:** Create `backend/src/config/{admin,sections,silences}.ts`, tests. Oracle `settings/admin.py`(426)、`sections.py`(488)、`silences.py`(114)、`service.py`。
**Produces:** `maintenance`、`backupInfo`、`restoreFromUpload`、`exportConfig`、`secretStatuses`、`mergeSections`、`listSilences/addSilence/deleteSilence`。
- [ ] Step 1-4：测试维护/备份/恢复/导出/密钥状态/silence CRUD；实现；绿。
- [ ] Step 5：commit `feat(p2): settings admin/sections/silences`。

### Task 6: Express 应用骨架 + 中间件链

**Files:** Create `backend/src/web/{app.ts,session.ts}`, `backend/src/web/middleware/{setup-guard,csrf,auth,usermode,errors}.ts`, `backend/test/web/middleware.test.ts`. Oracle `servermanage/web/__init__.py`(181)、`routes/_core.py` 的 before_request。
**Produces:** `createApp({db,config,services}): express.Express`；中间件按 ①setup→②csrf→③auth→④usermode 顺序；`sessionId(req)`；错误→JSON/HTML 分支。
- [ ] Step 1-4：supertest 测试 428/401/403/CSRF 403/顺序；实现；绿。
- [ ] Step 5：commit `feat(p2): express app + middleware chain`。

### Task 7: Nunjucks 模板兼容层 + url_for/static

**Files:** Create `backend/src/web/templating.ts`, `backend/test/web/templating.test.ts`；`backend/src/web/routes/registry.ts`（endpoint→path 映射）。
**Produces:** `configureNunjucks(env, {appVersion})` 注册 `stamp/anchor/rate/format/tojson` 过滤器、`url_for/asset_url/csrf_token` 全局、`request.query/session`；静态目录挂载 `/static`；页面渲染 helper `render(res, template, ctx)`。
- [ ] Step 1-4：测试过滤器输出（stamp 例、rate 例、url_for 映射、asset_url `?v=`）、模板渲染 hello；实现；绿。
- [ ] Step 5：commit `feat(p2): nunjucks templating + url_for/static`。

### Task 8: 认证安全件（password/ratelimit/ssrf）

**Files:** Create `backend/src/web/security/{password,ratelimit,ssrf}.ts`, tests. Oracle `routes/auth.py`、`routes/_core.py`。
**Produces:** `hashPassword/verifyPassword`（PBKDF2 200000/16B/常量时间）、`LoginRateLimiter`（5/60s/IP/4096，XFF 信任规则）、`assertSafeTarget(urlOrHost)`（dns.lookup+私网拒绝+`SSRF_ALLOW_PRIVATE`）。
- [ ] Step 1-4：测试哈希往返/错误密码、限流第 6 次 429+成功清零、SSRF 各类 IP；实现；绿。
- [ ] Step 5：commit `feat(p2): password/ratelimit/ssrf`。

### Task 9: auth 路由（setup/login/logout/change-password）

**Files:** Create `backend/src/web/routes/auth.ts`, `backend/test/web/auth.test.ts`. Consumes Task6-8、DPAPI。
**Produces:** `GET/POST /setup`、`GET /login`+`POST /login`、`POST /logout`、`POST /api/settings/password`。
- [ ] Step 1-4：supertest 测试首启 setup→登录→cookie→改密→登出；错误 401/429；实现；绿。
- [ ] Step 5：commit `feat(p2): auth routes`。

### Task 10: overview 路由 + 页面

**Files:** Create `backend/src/web/routes/overview.ts`, `backend/test/web/overview.test.ts`. Consumes P1 storage、Task7。
**Produces:** `/`、`/api/overview`、`/api/overview/capacity|history|alert-history|report`。
- [ ] Step 1-4：测试 JSON 形状 + 页面 200 渲染；实现；绿。
- [ ] Step 5：commit `feat(p2): overview routes + page`。

### Task 11: hosts 路由 + 页面

**Files:** Create `backend/src/web/routes/hosts.ts`, `backend/test/web/hosts.test.ts`. Oracle `routes/hosts.py`(610)。Consumes Task4。
**Produces:** 20 个 hosts 端点（列表/upsert/delete/import/probe/collect/checks/containers/copy/test-batch/ssh-config）+ `/hosts`、`/host/<name>`。
- [ ] Step 1-4：测试关键端点 JSON + 页面 200；实现；绿。
- [ ] Step 5：commit `feat(p2): hosts routes + pages`。

### Task 12: settings 路由 + 页面

**Files:** Create `backend/src/web/routes/settings.ts`, `backend/test/web/settings.test.ts`. Oracle `routes/settings_api.py`(253)。Consumes Task3/5。
**Produces:** `GET /api/settings`、`PUT /api/settings/<section>`、`POST /api/settings/test-ssh|test-email|test-desktop|test-webhook`、`GET /settings`。
- [ ] Step 1-4：测试 public 脱敏、dashboard→restart_required、测试端点（注入桩）、404/400/403/409；页面 200；实现；绿。
- [ ] Step 5：commit `feat(p2): settings routes + page`。

### Task 13: alerts 路由 + 页面

**Files:** Create `backend/src/web/routes/alerts.ts`, `backend/test/web/alerts.test.ts`. Oracle `routes/alerts.py`(153)、`settings/silences.py`。
**Produces:** `/api/alerts`、`/api/alerts/<id>/ack`、`/api/settings/silences`(GET/POST)、`/api/settings/silences/<id>`(DELETE)、`/alerts`。
- [ ] Step 1-4：测试列表/ack/silence CRUD/页面 200；实现；绿。
- [ ] Step 5：commit `feat(p2): alerts routes + page`。

### Task 14: users 路由 + 页面

**Files:** Create `backend/src/web/routes/users.ts`, `backend/test/web/users.test.ts`. Oracle `routes/users.py`(424)。Consumes P1 `storage/users.ts`。
**Produces:** 11 个 users 端点 + `/users`（refresh/plan/execute/status 走注入桩）。
- [ ] Step 1-4：测试端点 JSON + 页面 200；实现；绿。
- [ ] Step 5：commit `feat(p2): users routes + page`。

### Task 15: system 路由（host-keys/health/storage/maintenance/backup/restore/config-export/logs/runtime）

**Files:** Create `backend/src/web/routes/system.ts`, `backend/test/web/system.test.ts`. Oracle `routes/system.py`(275)。Consumes P1 `storage/runtime.ts`、Task5。
**Produces:** 11 个 system 端点。
- [ ] Step 1-4：测试 health/storage/backup/restore/config-export/logs/runtime；实现；绿。
- [ ] Step 5：commit `feat(p2): system routes`。

### Task 16: pages（compute/my/terminal）+ ssh_terminal SSE 骨架

**Files:** Create `backend/src/web/routes/pages.ts`, `backend/src/web/routes/ssh-terminal.ts`, tests. Oracle `routes/pages.py`(89)、`routes/ssh_terminal.py`(191)。
**Produces:** `/compute`、`/api/compute`、`/my`、`/api/my/summary`、`/terminal`；ssh 会话 record/end/list + SSE stream（P3 前用注入桩，`exec` 占位）。
- [ ] Step 1-4：测试页面 200 + 会话 CRUD + SSE 头；实现；绿。
- [ ] Step 5：commit `feat(p2): pages + ssh terminal skeleton`。

### Task 17: 全站装配 + golden 渲染 + 验收

**Files:** Create `docs/superpowers/plans/p2-acceptance.md`；`backend/test/web/all-pages.test.ts`（15 模板全部 200、登录后所有页面、未登录跳转、CSRF 403）。
- [ ] Step 1：装配全部路由到 `createApp`，跑全站 smoke。
- [ ] Step 2：`pnpm --filter servermonitor-backend typecheck` + `test` 全绿；`python -m pytest -q` → 1892 passed / 1 skipped；关键 JSON 与 Python 对照（overview/settings/hosts 列表）。
- [ ] Step 3：写 `p2-acceptance.md`，commit `test(p2): P2 acceptance`。

---

## P2 完成定义（DoD）
1. 约 60 个路由全部注册、URL/endpoint/JSON 契约与 Flask 一致；15 个模板全部可渲染 200。
2. 中间件 4 段顺序正确，428/401/403 分支符合 spec；CSRF 除 login/setup 外强制。
3. 设置读取脱敏、保存语义（dashboard→restart_required）、默认值/校验与 schema.py 一致。
4. 前端 `servermanage/web/static/` 零改动可用。
5. Node 测试全绿；Python 基线 1892 passed / 1 skipped 不变。
