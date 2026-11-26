# P2 验收报告 — Web 路由层 + 全站装配（Python → Node/TypeScript）

分支：`refactor/single-stack-b1`　·　Python oracle：`servermanage/web/*`（未改动）　·　Node 实现：`backend/src/web/*`

## 门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Node 类型检查 | `pnpm --filter servermonitor-backend typecheck` | ✅ 0 errors |
| Node 全量单测 | `pnpm --filter servermonitor-backend test` | ✅ **49 files / 777 passed, 1 skipped**（基线 48/772/1，本任务 +1 文件 / +5 用例） |
| 打包冒烟 | `backend/test/bundle.smoke.test.ts`（内含 `node build.mjs` + 无 node_modules 的裸 `resources/backend/main.cjs` 启动） | ✅ 通过；`dist/main.cjs` 1.79 MB，health-only 启动不加载原生模块 |
| Python 文件是否被改 | `git diff --name-only main..HEAD \| grep '^servermanage/'` | ✅ 空（零改动） |

> 1 个 skip 仍为 `dpapi.test.ts` 的“DPAPI 不可用”防御性分支。

## 端点总数

对装配后的 Express app 做路由内省（`app.router.stack` 中的 route layer）：

| 分类 | 数量 |
| --- | --- |
| **路由处理器合计** | **80** |
| 其中 `/api/*` JSON 端点 | 65 |
| 其中页面 / 认证端点（10 个页面 + setup/login/logout/改密） | 15 |
| 静态资源 | `/static/*` 由 `express.static` 中间件挂载（不计入 route layer） |

注册顺序（`backend/src/web/composition.ts`）：`auth → overview → hosts → settings → alerts → users → system → pages → disk-health → ssh-terminal`，与 P2 计划及 Python blueprint 注册顺序一致。

## 集成测试用例

`backend/test/web/integration.test.ts` — **5 个用例**（真实 SQLite + `initSchema` + `loadConfig` + supertest，单个 `createServerApp` 实例跑完整生命周期）：

1. `gates an uninitialised instance behind first-run setup` — 未初始化：`GET /api/overview` → 428 `setup_required`；`GET /` → 302 `/setup`；`GET /setup` → 200 HTML。
2. `creates the admin, logs in, and serves every page` — `POST /setup`（密码 ≥8）→ 302 `/login`；同一 app 实例 setup 守卫动态解除 → `GET /login` 200；`POST /login` → 302 `/` 并下发 `servermonitor_session`；带 cookie 访问 `/`、`/hosts`、`/alerts`、`/users`、`/settings`、`/disk-health`、`/compute`、`/my`、`/terminal` 全部 200 且为 HTML。
3. `serves the key JSON APIs to an authenticated session` — `/api/system/health`、`/api/overview`、`/api/settings`、`/api/alerts`、`/api/users`、`/api/compute`、`/api/my/summary` 全部 200 `application/json`。
4. `rejects anonymous API access and returns JSON 404 for unknown routes` — 未登录 `GET /api/overview` → 401 `unauthorized`；`GET /api/nope` → JSON 404 `not_found`；`GET /static/style.css` → 200 `text/css`（静态目录用仓库 `servermanage/web/static` 绝对路径）。
5. `startServer assembles the full app when db + config are injected` — 真实监听 `startServer({port:0,db,config})`：`GET /setup` 200（P0 health-only 无此路由）、`GET /api/overview` 428（证明路由存在且 setup 门禁生效），验证 `server.ts` 注入分支装配全站。

## 本任务交付/改动

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `backend/src/web/routes/overview.ts` | 改 | 仅加 `export`（`buildOverview`/`buildHostDetail`/`buildHostReport`，逻辑未动）+ 新增 `createOverviewBuilders(db,config)` 工厂，供 hosts 注入。 |
| `backend/src/web/composition.ts` | 新增 | `createServerApp({db,config,deps?,staticDir?,mountStatic?})`、`CompositionDeps`（各模块 deps 的 `Partial`）、`buildDefaultDeps(db,config)`；装配全部 10 个路由模块。 |
| `backend/src/server.ts` | 改 | `StartServerOptions` 增加可选 `db`/`config`；两者都传时 `await import('./web/composition')` 用 `createServerApp` 装配全站，否则维持 P0 仅 health 的 `createApp()`；`--port`/`--runtime`/runtime.json 行为不变。 |
| `backend/src/web/app.ts` | 改（1 行） | setup 守卫改为每请求求值 `() => publicSettings(db).setup_required === true`，与 Python oracle 的动态读一致（同一 app 实例 setup 后可进入登录）。 |
| `backend/src/web/middleware/setup-guard.ts` | 改 | `required: boolean \| (() => boolean)`，函数值在 handler 内求值；布尔值仍向后兼容（middleware 测试不变）。 |
| `backend/build.mjs` | 改 | `external` 增加 `@primno/dpapi`（与 `better-sqlite3` 同为原生模块）；composition 惰性 import，health-only 启动不 require，裸 `main.cjs` 冒烟仍通过。 |
| `backend/test/web/integration.test.ts` | 新增 | 见上，5 用例。 |
| `docs/superpowers/plans/p2-acceptance.md` | 新增 | 本文件。 |
| `.superpowers/sdd/single-stack-rewrite-plan/progress.md` | 追加 | P2 段。 |

## 与 Python oracle 的已知差异（路由层占位）

以下为 P2 有意保留的占位/降级，均不伪造数据，留待 P3+ 迁移真实实现：

1. **主机操作类占位**：`probeHost`/`runner`/`runHostChecks`/`prepareHostCheck`/`collectContainerStats`/`collectionStatus`/`collectHosts` 等未注入真实 SSH/采集服务，相关端点返回占位/空结果或明确错误；hosts 页/详情回退到本地 store-backed builder（注入后改用 overview builders）。
2. **账号写操作占位**：users 的 refresh/plan/execute 等依赖 `monitorService`/`admin` API，未注入时为占位状态，无真实扫描/执行。
3. **SSH 终端 manager**：`sshSessions` 缺省为 `undefined`，`POST /api/ssh/sessions` 返回 502 `{"error":"ssh_failed","message":"SSH 终端功能尚未迁移"}`；终端页 `/terminal` 仍渲染。
4. **compute / my 真数据**：`buildComputeSummary` / `buildMySummary` 未迁移，使用默认占位摘要。
5. **hosts diagnostics 深度**：`disk.controllers`、`check_history`、`users`、`diagnostics`、`alert_days` 等字段多为 TODO 占位，深度不及 Python。
6. **无 300s 缓存**：Python 侧 overview/诊断的 300 秒 TTL 缓存未移植，Node 每次请求实时构建。
7. **jsonify 键序**：JSON 字段集合与语义对齐，但不保证与 Flask `jsonify` 的键顺序逐字节一致（对象键序无契约）。

## P2 完成 / 遗留 P3+ 依赖

**P2 完成**
- 全部 10 个路由模块（auth/overview/hosts/settings/alerts/users/system/pages/disk-health/ssh-terminal）已实现并单测覆盖。
- 全站装配根 `createServerApp` 就绪；`startServer({db,config})` 可启动全站，缺省仍为 health-only。
- 中间件门禁链（setup/CSRF/auth/usermode）与静态资源挂载打通；setup 动态守卫与 oracle 对齐。
- 集成验收：未初始化 428/302、setup+login、全页面 200、关键 JSON API 200、匿名 401、JSON 404、静态 200 全绿。
- 门禁：typecheck 0；49 files / 777 passed / 1 skipped；打包冒烟通过；Python 零改动。

**遗留 P3+ 依赖（真实实现，需后续任务注入 deps）**
- SSH/采集执行层：`probeHost`、`runner`、`runHostChecks`、`prepareHostCheck`、容器 stats、采集状态/触发、hosts 导入的 SSH config 预览真实读写。
- SSH 终端 `SshSessionManager`（create/input/resize/close/stream 的真实 PTY 会话）。
- users 监控与管理：`UsersMonitorService`、`UsersAdminApi`、计划执行 job。
- compute / my 真实摘要（`compute_mod.build_compute_summary`、`_core._build_my_summary`）。
- 系统诊断/备份恢复/日志导出的完整实现（当前路由已接，deps 缺省为占位）。
- overview/诊断 300s TTL 缓存（若需与 oracle 性能对齐）。
- hosts 详情/诊断字段补全（disk controllers、check history、users、diagnostics 等）。

## 结论

**P2 DoD 达成**：全站装配根可一键组装所有路由，`startServer` 支持注入 db+config 启动全站且不破坏 P0 健康启动与打包；集成验收覆盖首启→登录→全页面与关键 API；typecheck/test 全绿，Python 零改动。剩余真实数据/执行能力均以显式占位暴露，留待 P3+ 注入。
