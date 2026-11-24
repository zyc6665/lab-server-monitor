# 第一阶段架构设计：模块边界、巨文件拆分、API 约定与工程基础

> 作者：GLM5.4（架构）　日期：2026-11-23　状态：待 zzz 确认后执行
> 分工：架构 GLM5.4 / 前端 kimi / 后端 DS / UI 混元
> 原则：**在现有基础上演进，不推倒重写**；每一步可独立合并、可回滚、测试全绿。

## 0. 现状诊断（只读盘点）

| 层 | 现状 | 问题 |
| --- | --- | --- |
| 采集/服务 | `servermanage/*.py` 约 40 个模块，职责基本清晰（collectors / parsers / storage / scheduler / alerts / report / notify） | `storage.py` 159KB、`settings.py` 89KB 两处巨型文件 |
| Web | `web/routes.py` 178KB：约 2 500 行辅助函数 + `register_routes()` 内 **79 个路由 + 1 个 `before_request`** | 所有路由塞在一个函数里，无法按领域测试与导航 |
| 存储 | `storage.py` 159KB：**无 class，约 100 个模块级函数（公开约 65 个）** | 单文件过重，但已是函数式，拆分用重导出即可 |
| 前端 | `web/static/app.js` 170KB 单文件 + 7 个按页面拆出的 js | 共享 formatter / 状态散落在 `app.js` |
| 桌面 | Electron 主进程 + Python sidecar，IPC 与自动更新已成型 | 与 Web 层耦合点集中在 `backend.js` |
| 工程 | pytest 60+ 文件、Electron 测试 12 个，但 CI 只有 `release-windows.yml` | 测试没在 CI 跑；双版本号（0.1.236 vs v1.6.1）导致更新循环 |

## 1. 目标分层与模块边界

```
┌────────────────────────── desktop/electron ──────────────────────────┐
│ main.js / preload.js / backend.js   ← 只做窗口、托盘、sidecar 生命周期  │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ HTTP (localhost) + IPC
┌──────────────────────── servermanage.web ────────────────────────────┐
│ routes/  (按领域拆分的 Blueprint)                                      │
│   auth · overview · hosts · users · alerts · disk_health · settings   │
│   system · ssh_terminal · pages                                       │
│ → 只做：参数校验、权限、序列化；不写业务逻辑                            │
└──────────────────────────────┬───────────────────────────────────────┘
                               │ 服务层（Python 函数 / 类）
┌──────────────────────── servermanage (services) ─────────────────────┐
│ MonitorService · SettingsService · AlertEngine · UserScanService      │
│ Scheduler · ReportBuilder · Notifier                                  │
│ → 业务规则、事务边界、对外副作用（SSH/SMTP/Webhook）                     │
└──────────────────────────────┬───────────────────────────────────────┘
                               │仓储接口
┌──────────────────────── storage (repositories) ──────────────────────┐
│ HostRepo · MetricRepo · AlertRepo · SettingsRepo · UserRepo …         │
│ → 纯 SQLite 读写，无业务判断                                           │
└──────────────────────────────────────────────────────────────────────┘
```

依赖方向只允许 **web → services → storage**，禁止反向 import。

## 2. 三个巨文件的拆分方案

### 2.1 `web/routes.py`（178KB）→ `web/routes/` 包

按现有闭包名的前缀自然分组，**10 个路由模块**（每个文件一个 `register_*(app)` 函数）。**不用 Flask `Blueprint` 类**：Blueprint 会自动给 endpoint 加前缀（`pages.my_page`），而模板中 29 处 + `routes.py` 内 8 处 `url_for()` 用的是裸 endpoint，前缀化会全部 `BuildError`。因此每个模块用模块级视图函数 + `app.add_url_rule(rule, endpoint="<原名>", view_func=...)` 显式保留裸 endpoint，模板与 `url_for` 零改动。DS 盘点已核实边界：

| 新文件 | 迁入路由（节选） | 行数估计 |
| --- | --- | --- |
| `routes/__init__.py` | `register_routes(app)` 保持原签名：逐个调用各模块 `register_*(app)` + **唯一一次** `before_request(_require_login)` | 兼容层 |
| `routes/auth.py` | `setup/login/logout/change_password`、`_login_failures` 等（状态已在 `app.extensions["login_failures"]`） | ~300 |
| `routes/overview.py` | `api_overview*`、`overview_page`、`api_overview_report` | ~250 |
| `routes/hosts.py` | `api_host*`、`hosts_page`、`host_page`、collection/probe/copy/import | ~600 |
| `routes/users.py` | `api_users*`、`users_page`、`_user_write_host` | ~500 |
| `routes/alerts.py` | `api_alerts`、`api_ack_alert`、silence CRUD、`alerts_page` | ~200 |
| `routes/disk_health.py` | `disk_health_page`（含页面内组装逻辑，需下沉到 service） | ~200 |
| `routes/settings_api.py` | `api_get_settings`、`api_put_settings_section`、`settings_page`、test_*（**改名避开与 `servermanage/settings.py` 同名**） | ~400 |
| `routes/system.py` | health/storage/maintenance/backup/restore/config_export/logs/runtime | ~350 |
| `routes/ssh_terminal.py` | 会话创建、input/resize/stream/close、审计 | ~250 |
| `routes/pages.py` | compute/my/terminal 页面及对应轻量 API | ~150 |
| `routes/_state.py` | 仅放跨文件 helper：`_terminal_denied`、`_find_host`、`_terminal_session_or_none`、`_finish_ssh_audit`、`_user_write_host`（可变状态已在 `app.extensions` / 模块级，**不新建状态容器**） | ~150 |

**执行方式**：`routes/` 包内一律**绝对导入**（`from servermanage.web.routes import ...`），禁止相对导入，避免 `settings` 同名混淆。`register_routes()` 签名不变，`web/__init__.py` 不改。每个模块一次 PR，`tests/test_*_api.py` 对应迁移；M1 第一个 PR 加一条 `test_route_endpoints` 锁住全部裸 endpoint 名，防止后续误改。模块级 `_build_*` 数据构造函数（`_build_overview` / `_build_user_rows` / `_build_host_detail`）暂留原处，不阻塞 M1。

### 2.2 `storage.py`（159KB）→ `storage/` 包（函数式重导出，**非类门面**）

DS 盘点确认 `storage.py` 没有任何 class，因此不做 Repo 类化，只按表域拆文件并重导出：

- `storage/base.py`：连接管理、迁移、`_connect()`、通用工具
- `storage/hosts.py` / `metrics.py` / `alerts.py` / `users.py` / `runtime.py`：按函数归属拆分
- `storage/__init__.py`：**重导出全部公开函数 + 显式 `__all__`**（约 50 个名字，含被 `app.py` 直接 import 的私有 `_extract_disk_used_percent`），旧路径 `from servermanage import storage; storage.X(...)` 继续可用
- 已知外部调用点：`app.py` 18 个 import、`web/routes.py` 约 70 处、`alerts.py` 5 个、`user_collection.py` 7 个、`scheduler.py` 2 个、`weekly.py` 3 个、`capacity.py` 1 个、`main.py` 1 个

### 2.3 `settings.py`（89KB）→ `settings/` 包

- `settings/schema.py`：各 section 的 Pydantic/dataclass 定义与默认值
- `settings/service.py`：读写、校验、`on_config_changed` 回调
- `settings/secrets.py`：DPAPI / env 凭据的加解密
- `settings/wizard.py`：首次设置向导

## 3. API 约定（前后端共同遵守）

1. 路径：`/api/<domain>/<resource>[/<id>[/<action>]]`，动作类用 POST（`/api/hosts/<name>/probe`）
2. 响应包裹：`{"ok": true, "data": ...}` 或 `{"ok": false, "error": {"code", "message"}}`；现有接口先保持原样，新接口一律用此格式，旧接口逐步迁移
3. 时间统一 ISO 8601 带 `Z`；字节用整数，前端负责格式化（formatter 抽成 `web/static/lib/format.js`）
4. 写操作必须带 `X-CSRF-Token`（已有机制），前端统一走 `lib/api.js` 的 `request()` 封装
5. 错误码表：`AUTH_REQUIRED / FORBIDDEN / NOT_FOUND / VALIDATION / CONFLICT / UPSTREAM_SSH / INTERNAL`

## 4. 版本号归一（需 zzz 二选一）

- **推荐 B：抬升到 1.x 线**。理由：自动更新用 `app.getVersion()` 与 Release 标签比较，线上已有 `v1.6.1` 用户，走 A 会让已升级用户被判"降级"。
- 执行：`python tools/bump_version.py 1.6.2`，发 `v1.6.2` 标签；README/CHANGELOG 不再写死版本。
- `build-portable.ps1` 产物命名加 `-local` 后缀，避免误分发。

## 5. 测试 CI

新增 `.github/workflows/ci.yml`：
- `backend`: Python 3.11，`pip install -e .[dev]`，`pytest -q`
- `desktop`: Node 20 + pnpm，`pnpm install --frozen-lockfile`，`pnpm test`
- 触发：push 到 main、PR；release 工作流依赖 ci 通过

## 6. 实施顺序与里程碑

| # | 任务 | 负责 | 产出 | 依赖 |
| --- | --- | --- | --- | --- |
| M0 | 版本号归一 + CI 工作流 | GLM5.4 | `bump_version 1.6.2`、`ci.yml` | zzz 选 A/B |
| M1 | `routes.py` → Blueprint 拆分 | DS | `web/routes/` 包，`register_routes` 兼容 | M0 |
| M2 | `lib/api.js` + `lib/format.js` 抽取，`app.js` 按页面拆 | kimi | `web/static/lib/`、`pages/` | 无（可与 M1 并行） |
| M3 | CSS 设计令牌（颜色/间距/圆角/字号/暗色模式） | 混元 | `tokens.css`，各 css 改引用令牌 | 无 |
| M4 | `storage.py` → 仓储拆分 | DS | `storage/` 包 + 门面 | M1 |
| M5 | `settings.py` 拆分 | DS | `settings/` 包 | M4 |
| M6 | UI 统一打磨（表格/卡片/对话框/状态色） | 混元 + kimi | 按令牌表改组件 | M2, M3 |

每个里程碑单独分支 → 测试全绿 → 合并；M1/M2/M3 可并行。

## 7. 兼容策略

- 所有对外入口（`register_routes`、`storage.*` 函数名、`SettingsService`、`create_app` 参数）签名不变，内部重组
- 数据库 schema 本阶段不动，不做迁移
- Electron `backend.js` 对 HTTP 接口的调用不改路径
- 旧接口响应格式保持，新格式只用于新增接口

## 8. 风险

- `routes.py` 拆分时闭包共享的局部状态（登录失败计数、SSH 会话表）需提升为模块级或挂到 `app.config`，否则多文件后失效 → M1 第一步先处理
- `storage.py` 内部函数互相调用多，拆文件后同表域函数放同一模块，跨表域调用走绝对导入；`__init__.py` 的 `__all__` 用测试锁住（`test_storage_public_api`：断言旧名字全部可导入）
