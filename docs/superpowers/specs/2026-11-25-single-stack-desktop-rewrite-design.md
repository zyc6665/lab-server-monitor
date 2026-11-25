# 单栈桌面化重构设计（B1：Electron + Node/TypeScript 后端）

- 日期：2026-11-25
- 基线版本：v0.1.239（commit `d6d116a`，tag `v0.1.239`）
- 工作分支：`refactor/single-stack-b1`
- 状态：设计定稿（builder 复审完成、8 项产品决策已确认；待用户批准后进入 writing-plans）
- 目标产物：可安装 / 可卸载 / 可自动更新的 Windows 桌面软件，单一技术栈，无 Python 运行时、无 `.bat`/`.ps1`。

---

## 1. 背景：为什么要这样做（Why）

当前发行形态是**两套世界观叠加**，用户明显感到"不像正常软件"：

1. **发行形态**：`desktop/electron-builder.yml` 的 `win.target` 是 `dir`（不产安装器），只会打出一个绿色便携目录；同时又并存旧的 PyInstaller 独立 exe 线（`packaging/build.ps1` → `dist/servermonitor/servermonitor.exe` + `启动.bat`）。Electron 只是个外壳，真正的后端是被当作 sidecar 拉起的 Python/Flask 进程（`resources/backend/servermonitor-backend.exe`）。
2. **脚本补丁**：因为没有安装器，才需要 `启动.bat`、`停止.bat`、`注册开机自启.ps1` 这类补丁脚本。
3. **数据/配置位置**：数据、配置、日志全部落在应用目录旁边（`desktop/electron/paths.js:48-70`），导致"目录不可移动、升级就是整目录替换"。
4. **多入口/多后台**：存在多处入口、Python 托盘 + Electron 托盘两套、两处"检查更新"逻辑。

结论：问题的根源不是某个功能缺失，而是**发行形态（便携目录 + 旁挂 Python sidecar）与"正常桌面软件"的形态（安装器 + 单一进程树 + 独立数据目录 + 安装器托管更新）不匹配**。本设计用 B1 方案把整条线收敛为单一 Node/TypeScript 技术栈。

---

## 2. 目标 / 非目标 / 反目标

### 2.1 目标（Goals）
- **单一技术栈**：Electron 主进程 + 后端服务全部使用 Node.js 22 / TypeScript；迁移完成后仓库内**不再有 Python 运行时依赖**（迁移期 Python 暂时保留作行为对照 oracle，交付前移除）。
- **正规安装器**：electron-builder + NSIS，支持**选择安装目录**（默认非 C 盘）、开始菜单、卸载程序、登录时自启。
- **数据目录可自定义**：安装向导 / 首启 / 应用内设置三处均可指定；默认 `{安装目录}\data`，并引导用户避免把数据落到系统盘；**绝不强制写 C 盘**。
- **单一进程树、单一托盘、单一入口**：无 `.bat`/`.ps1`，无 PyInstaller sidecar，托盘只保留 Electron 一套。
- **自动更新**：`electron-updater` + GitHub Releases（NSIS），替换现有 custom updater。
- **行为等价**：告警判定、调度 catch-up、报表内容、SSH 终端、容量预测等业务语义与现状**逐项等价**（用差分/对照测试证明）。
- **数据零迁移**：直接复用现有 SQLite 文件（同名同 schema），老库（含 legacy 结构）打开即自动升级。
- 全程保持测试绿、可回滚（分支 `refactor/single-stack-b1`，不直接动 main）。

### 2.2 非目标（Non-Goals，本次不做）
- 不改变前端交互与视觉（仅做模板引擎适配，前端 `static/` 与页面结构保持不变）。
- 不重写业务算法（1:1 移植，保留语义与魔法数）。
- 不做多租户 / 多管理员 / 权限体系重做（保留单管理员 + admin/user 两种视图模式）。
- 不采购代码签名证书（若用户无证书，则按无签名发布并在文档中说明 SmartScreen 提示）。
- 不支持 macOS / Linux（仅 Windows）。

### 2.3 反目标（Anti-Goals：出现即视为失败）
- 任何**数据丢失**或要求用户手工迁移 SQLite。
- 任何**业务回归**（告警漏报/误报、调度漏跑/重跑、报表内容变化、终端行为变化）。
- 再次引入第二运行时、第二托盘、启动脚本或 sidecar 可执行文件。

---

## 3. 硬约束（Constraints）

- **平台**：Windows x64；Node.js 22（沿用 Electron 45.2.3）；TypeScript。
- **数据兼容（最高优先级）**：
  - 复用同一 SQLite 文件与 schema（默认 `data/servermonitor.db`，由 `storage.db_path` 决定）。
  - 时间戳必须保持 **ISO-8601 UTC 文本**，形如 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`；范围查询依赖**字典序字符串比较**，格式不一致会直接破坏排序与过滤。
  - JSON 列（`app_settings.payload`、`host_latest_snapshot.raw_json`、`groups_json`、`steps_json`）以 UTF-8 JSON 文本存储。
  - 布尔以 `0/1` 存整数。
- **密钥兼容**：`app_secrets` 中的密文由 Python `ctypes CryptProtectData`（**当前用户作用域、无 entropy、`CRYPTPROTECT_UI_FORBIDDEN`**）加密。迁移后必须能解密**既有 blob**，因此必须使用等价的 DPAPI 调用（`win-dpapi`），**不能**直接用 Electron `safeStorage` 读取旧数据（safeStorage 的密钥派生/附加熵不同）。
- **HTTP 契约与前端复用**：保留 `/api/*` 路径与 JSON 契约、保留 15 个 HTML 模板与整个 `static/` 目录（Nunjucks 兼容层适配），使前端几乎零改动。
- **测试不可削减**：迁移期以现有 254 个测试文件（1892 passed / 1 skipped）为行为 oracle，迁移后须全部以 Node 测试 + 差分测试的形式重建到位。

---

## 4. 技术选型（多数为我的决定，见 §12；你的选择见 §11）

| 领域 | 选型 | 备选/理由 | 风险 |
|---|---|---|---|
| 桌面壳 / 主进程 | Electron 45 + TypeScript | 沿用现有版本，成熟 | 低 |
| 后端运行时 | Node 22，运行于 **Electron `utilityProcess`** 子进程 | 见 §5 论证：隔离同步 better-sqlite3 与 CPU 聚合，保留崩溃隔离与 HTTP/SSE 模型；比"内嵌 main"风险低 | 中 |
| HTTP 框架 | Express 4 | 中间件生态成熟（session/CSRF/static/SSE） | 低 |
| 模板引擎 | Nunjucks（Jinja 近亲）+ 兼容层 | 模板 ~90% 可直接复用（见 §6.2） | 低 |
| 数据库 | better-sqlite3（同步 API） | schema/查询 1:1；同步风格匹配现有阻塞式代码 | 低 |
| SSH | ssh2 | 支持 exec 与 PTY shell、`hostVerifier` 可复刻 TOFU/strict | 中 |
| 调度 | 自研 interval + calendar 循环（写入 `task_state`） | node-cron **不能**复刻 catch-up / `_current_period_target` 语义 | 中 |
| 邮件 | nodemailer | 复刻 SMTP/SSL/STARTTLS/重试 | 低 |
| Webhook | 原生 `fetch`/`https` | 复刻 wecom/dingtalk/feishu/通用 载荷 | 低 |
| 桌面通知 | Electron `Notification` | 取代 winotify | 低 |
| 托盘 | Electron `Tray`（已存在） | 收敛为唯一托盘 | 低 |
| 开机自启 | `app.setLoginItemSettings({ openAtLogin, args:['--start-hidden'] })` | 取代 `注册开机自启.ps1`/计划任务 | 低 |
| 密钥加密 | `win-dpapi`（读旧 blob 兼容）+ Node `crypto.pbkdf2` | PBKDF2-HMAC-SHA256 / 200000 轮 / 16B salt，格式保持一致 | 中 |
| 会话 | `express-session` + SQLite store | 保留 12h 永久会话、同名 cookie | 低 |
| CSRF | 自研 per-session token | 复刻 Flask 的 `session["csrf_token"]` + `X-CSRF-Token`/form 双通道 | 低 |
| 打包 | electron-builder **NSIS** 安装器 | assisted 安装器、可选安装目录、卸载、开始菜单 | 中 |
| 自动更新 | `electron-updater`（GitHub provider） | 替换 custom updater，产物含 `latest.yml` | 中 |
| 构建 | pnpm workspace + esbuild（后端 TS→单文件 CJS）+ tsc 类型检查 | 打包进 `app.asar`，无外挂 exe | 低 |

---

## 5. 目标架构

### 5.1 进程模型（关键决策）

```
servermonitor.exe (Electron main / main.ts)
├─ 负责：单实例锁、创建 BrowserWindow、Tray、最小化/关窗隐藏、
│        开机自启、生命周期、自动更新、数据目录解析、动态端口
├─ 启动 → utilityProcess('backend')   ← 单一 Node 子进程（非 Python）
│     └─ Express HTTP 服务，监听 127.0.0.1:<动态端口>
│         · 托管 templates + static（Nunjucks / express.static）
│         · 全部 /api/* 路由、SSE 终端流、文件下载
│         · better-sqlite3（同步）、scheduler、collector、alerts…
│         · 写 runtime.json {url,port,pid} 供 main 握手
└─ BrowserWindow 加载 http://127.0.0.1:<port>（渲染进程 = 现有前端，零改）
```

**为什么用 utilityProcess 而不是把后端塞进 main 进程**：
- better-sqlite3 是**同步**的，`COUNT/窗口函数/日汇总/周报`等聚合会**阻塞事件循环**；放在 main 会卡住窗口与 IPC。
- utilityProcess 是 Electron 官方支持的 Node 子进程，天然对应"原来 Python sidecar"的角色：保留**崩溃隔离**（后端崩溃不拖垮窗口）、独立的进程生命周期与重启策略。
- 保留 HTTP + 静态资源 + SSE 的模型，使**整个前端与 15 个模板原样复用**，也让"Python ↔ Node 差分对照"成为可能（同一套 API 可分别打到两个后端）。
- 仍然是"单一 Node/TS 技术栈、单一进程树（Electron 主 + 其子进程）"，不引入第二种运行时。

**为什么保留 HTTP（而不是 IPC 直连）**：前端是纯 vanilla JS + `fetch('/api/*')`，SSE 终端、静态资源、模板渲染全部现成；改为 IPC 需要重写整个前端数据层，违背"前端零改"。HTTP 监听仅绑定 `127.0.0.1`，不影响安全性。

### 5.2 目录布局

安装目录（向导可选；默认 `D:\Tools\ServerMonitor`，无 D 盘回退 `%LOCALAPPDATA%\Programs\ServerMonitor`）：
```
{安装目录}\
  servermonitor.exe            # Electron 主程序
  resources\app.asar           # 前端模板/静态资源 + 打包后的 backend bundle
  ...electron 运行时...
  Uninstall 服务器轮询监测工具.exe
```

数据目录（可自定义；**默认与安装目录解耦**：取第一个非系统固定盘，如 `D:\ServerMonitorData`；无此类盘时回退 `%LOCALAPPDATA%\ServerMonitor` 并明确提示；拒绝或强警告网络/可移动盘。这样即便 per-machine 装到 Program Files 也不受影响）：
```
{数据目录}\
  servermonitor.db             # SQLite（直接复用旧库文件）
  config\config.yaml           # 仅作 seed / 高级用户可编辑（真正持久化在 DB）
  config\.env                  # 可选
  logs\                        # 日志（放这里而非安装目录，规避 Program Files 写权限）
  runtime.json                 # 端口握手（仅运行期）
  backups\                     # 备份
```
- 数据目录的"指针"存于稳定位置：**HKCU\Software\ServerMonitor\DataDir**（单用户桌面，`{安装目录}\instance.json` 为备选，见 §12）。这样即便升级/重装到新安装目录，只要指针不变，数据目录不变。
- **首启探测**：若新数据目录无 `servermonitor.db`，但检测到旧版 `data/servermonitor.db`（便携目录旁），提示"导入现有数据"（复制到新数据目录，原子替换）。是否自动探测见 §11-Q6。
- 兼容：仍支持 `--config`/`--dotenv` 语义，但不再有 Python 进程参数。

### 5.3 安装器与发行形态
- **NSIS assisted 安装器**：`oneClick:false`、`allowToChangeInstallationDirectory:true`、开始菜单/桌面快捷方式、卸载程序；卸载默认**不删除数据目录**（询问）。
- 删除：`启动.bat`/`停止.bat`/`注册开机自启.ps1`、PyInstaller `packaging/backend.spec`/`build-backend.ps1`、`resources/backend` sidecar、旧 `custom updater` + `apply-update.ps1`。
- 自动更新：`electron-updater` 读取 Release 的 `latest.yml`（CI 产出），校验 sha512 后静默/提示更新；GitHub provider，仅同 major、排除 prerelease。
- **存量用户迁移**：现有绿色便携用户下载并运行新安装器即可；首启自动探测旧 `data/servermonitor.db` 并导入（§7.7），无需手工迁移。

---

## 6. 组件与移植映射（模块级）

> 现状测绘结论来自三份只读审计（存储 / Web+配置 / 业务+Electron 生命周期），关键事实内联如下，implementer 可据此直接实现。

### 6.1 存储层 → `backend/src/storage/*`（better-sqlite3）
- **表清单（21 张）**：`host_metrics_history`、`host_latest_snapshot`、`disk_controller_snapshot`、`disk_vd_snapshot`、`disk_pd_snapshot`、`disk_health_snapshot`、`alerts`、`task_state`、`host_daily_summary`、`app_settings`、`app_secrets`、`alert_silences`、`ssh_audit_sessions`、`host_check_snapshot`、`host_check_history`、`host_user_snapshot`、`host_user_baseline`、`host_user_scan_state`、`host_user_usage_history`、`user_operations`（+ `sqlite_sequence`）。DDL 集中在 `servermanage/storage/base.py:39-370`。
- **连接**：`busy_timeout=10000`、`synchronous=NORMAL`、`journal_mode=WAL`（新库）；无 `foreign_keys`、无 FK 约束。`auto_vacuum=INCREMENTAL`（仅新库），旧库在 `maintain_database` 里做一次性 `VACUUM`。**每次操作独立打开连接**（无连接池）；`init_storage` 用锁 + 已初始化集合，且**显式 close**（避免 Windows 上 `-wal` 被占用）。
- **迁移（必须复刻）**：
  - `host_metrics_history` 缺 `net_rx_bytes`/`net_tx_bytes`/`temperature_c` → `ALTER TABLE ADD COLUMN`（可空）。（pre-v0.1.75 老库）
  - `host_daily_summary` 缺 `tz` 列 → 重建表 + `INSERT ... SELECT` + 打 tz 标记（PK 由 `(day,host_name)` 变 `(day,host_name,tz)`）。
  - `host_user_snapshot` 缺 `usage_readable` → `ADD COLUMN ... DEFAULT 1`。
- **写入并发**：`BEGIN IMMEDIATE` 用于 `persist_host_reports`、`save_host_check_results`、`append_host_check_history`、`insert_alert`、`save_host_user_scan_result`、`save_host_user_snapshot`、`save_user_scan_state`、`upsert_user_baseline`。better-sqlite3 用 `db.transaction(fn).immediate(...)`（或显式 `BEGIN IMMEDIATE`）复刻。
- **时间封装**：所有时间经 `nowIsoUtc()` → `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`；`day` 键为本地日期 `YYYY-MM-DD`。**禁止**用 `Date.toISOString()`（缺微秒、且毫秒位与 Python 不一致会破坏字典序？→ 需格式化补齐 6 位微秒）。
- **纯 SQL 特性**：使用 `AVG/CASE/ROW_NUMBER() OVER`、`ON CONFLICT ... DO UPDATE`，需 SQLite ≥3.25（better-sqlite3 自带现代版本）。
- **批量/裁剪**：`_delete_rows_in_chunks(chunk=500)` 用 `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT ?)`；`prune_host_metrics` 每 host 保留最新 100 行（`LIMIT 1 OFFSET n` 取阈值，避免全表窗口函数）。
- **备份/恢复/校验**：`backup`（Python 同步 → better-sqlite3 `.backup()` 为异步 Promise，需 await 封装）；`restore`（源以只读打开）；`validate_backup_database`（16 字节 `SQLite format 3\0` 头 + `PRAGMA integrity_check` + 必含 `app_settings`/`app_secrets`）；`database_integrity`（`PRAGMA quick_check`，带 TTL 缓存）。
- **保留的魔法数**：`busy_timeout=10000`、check-history `keep=60`、delete `chunk=500`、`host_metrics_max_points=100`、`disk_health_retention_days=7`/`max_batches=100`、`host_daily_summary_retention_days=90`、`alert_history_retention_days=30`、`ssh_audit_retention_days=30`、user usage `retain_days=180`/`min_interval_hours=12`。

### 6.2 Web / 认证 / 设置 → `backend/src/web/*`（Express + Nunjucks）
- **路由 1:1 保留**（约 40+ 端点）。分组：auth（`/setup`、`/login`、`/logout`、`/api/settings/password`）、overview（`/api/overview*`、`/`）、hosts（`/api/settings/hosts*`、`/api/host/<name>*`、`/hosts`、`/host/<name>`）、users（`/api/users*`、`/users`）、alerts（`/api/alerts*`、`/api/settings/silences*`、`/alerts`）、disk-health（`/disk-health`）、settings_api（`/api/settings*`、`/settings`）、system（`/api/system/*`、`/api/logs*`、`/api/runtime`）、ssh_terminal（`/api/ssh/sessions*`，SSE stream）、pages（`/compute`、`/api/compute`、`/my`、`/api/my/summary`、`/terminal`）。**保留 endpoint 名作为 `url_for` 映射键**。
- **中间件链（复刻 `before_request`）**：① setup 门控（未初始化：`/api`→428 `setup_required`，页面→`/setup`）→ ② CSRF（POST/PUT/DELETE，除 `/login`、`/setup`）→ ③ 认证（未登录：`/api`→401，页面→`/login`）→ ④ user-mode 路径白名单（越权：`/api`→403 `admin_only`，页面→`/my`）。
- **会话**：cookie 名 `servermonitor_session`（+可选后缀），`httpOnly`、`sameSite=Lax`、`secure` 默认 **关**（loopback HTTP）、`maxAge=session_lifetime_hours`（默认 12h）。secret 优先 `dashboard.session_secret`，否则随机生成并持久化。
- **密码哈希**：PBKDF2-HMAC-SHA256 / 200000 轮 / 16B 随机 salt，存 `{hash,salt,iterations,username}` 到 DPAPI blob `SECRET_ADMIN`；校验用常量时间比较。
- **登录限流**：每 IP 60s 窗口 5 次失败，第 6 次 429；`X-Forwarded-For` 仅在直连为 loopback 时信任首跳；上限 4096 条。
- **SSRF 防护**：`dns.lookup` 解析后拒绝 loopback/private/link-local/reserved/multicast/unspecified；允许清单内主机名，或 `SSRF_ALLOW_PRIVATE` 逃生开关；webhook URL 同样校验。
- **DPAPI**：`win-dpapi` 读写 `app_secrets`；`current_machine_id = sha256(MachineGuid + username)`，不匹配则清空密钥并 `force_setup`（保留该行为）。
- **模板兼容层（Jinja → Nunjucks）**：注册过滤器 `stamp`（ISO→`%m-%d %H:%M`）、`anchor`（slug）、`rate`（bytes/s）、`format`（printf `'%.1f'|format(v)`）、`tojson`（≈`dump`）；全局 `url_for(endpoint, **params)`（endpoint→path 映射）、`asset_url`（带 `?v=APP_VERSION`）、`csrf_token()`；暴露 `request.query`、`session` 对象。需替换的 Jinja 专有写法：`namespace()`（host.html 两处 → 路由预计算或可变对象）、`selectattr('status','equalto','active')`/`select`（→ 自定义 filter 或预计算计数）、`request.args.get`（→ `request.query`）。**前端 `static/` 整目录原样复用**（其从 `<meta name="csrf-token">` 取 token）。
- **设置契约**：`GET /api/settings` → `public_settings()`（secrets 只回布尔，如 `password_configured`/`url_configured`）；`PUT /api/settings/<section>`（`dashboard` 改动返回 `restart_required`；错误码 404/400/403/409 保持）。
- **设置 schema**（保持字段/校验/默认值）：`monitoring`（poll_interval 600、concurrency 8、各种 retention、tray_enabled、mode、member_account…）、`dashboard`、`ssh`（connect_timeout 10 / command_timeout 20 / host_key_policy）、`smtp`、`alerts`（阈值 cpu/mem/disk/gpu_memory 90%、disk_temperature_c 55、cooldown 60、offline_failures 2、consecutive_periods 2 clamp 1..10…）、`report`、`disk_health`、`hosts[]`。

### 6.3 采集 / SSH / 解析 → `backend/src/collect/*`
- 每主机**一条 SSH 连接**跑 22 个固定命令阶段（`build_command_map`），按顺序并发 `collect_all_hosts`（并发默认 8）。
- `ssh2`：密码或私钥认证（支持 inline key_data+passphrase 与 key 文件）；`hostVerifier` 复刻 `tofu`/`strict`/`insecure`（known-hosts JSON 以 SHA256 指纹存）；keepalive 30s（exec 与 shell 均设）；**仅对瞬态错误**做一次 1.0s 退避重试，认证错误不重试；`invoke_shell` PTY（`xterm-256color`, 120×30）供 Web 终端；sudo **只经 stdin 喂密码**（`sudo -S -p ''`），永不进 argv/日志，区分 `SudoAuthError`/`SudoUnavailable`。
- 解析器 `parse_host_metrics` 等纯函数 1:1 移植（CPU 差分、内存、df、网络、`nvidia-smi`、docker、进程），用 `tests/fixtures` 做 fixture 对照。

### 6.4 调度 / 运行时 → `backend/src/runtime/*`
- `should_run`：`last_run_at is None` 或 `interval<=0` 或 `now-last>=interval`。
- 报表任务用日历目标：`is_report_due = target<=now and (last_run_at is None or last_run_at<target)`（漏跑只补一次）。
- `_current_period_target`：按间距推断日/周/其他（`<=2d`→今日 hh:mm、`<=14d`→本周、否则下次）避免新装重复发报。
- tick 夹取 1..60s；失败任务仍占用时间槽并记录 `error: Type: msg`（截断 500 字符）。
- `task_state` 持久化（`last_run_at`/`last_result`），沿用 SQLite 表。

### 6.5 告警 / 通知 → `backend/src/alerts/*`
- 规则函数**纯、无 I/O**；指纹 = 小写冒号拼接。阈值**含等号**（`>=`）；缺失指标（`None`）跳过、绝不当作 0。可用性告警仅 `failed`/`error` 为 critical。
- 连续周期门控：每 `(host,fingerprint)` present-streak 达到 effective periods（per-host 覆盖，否则 `alerts.consecutive_periods`，默认 2、clamp 1..10）才触发；恢复需同等周期缺席；坏→好→坏重置为 1。
- `AlertEngine.process`：去 silence → `_should_skip` 去重/冷却 → 单条或 `aggregate_by_host` 聚合（"主机 X N 项告警"）。`_should_skip`：`error_increase` 必发；`acknowledged` 抑制；无 `notified_channels` ⇒ 重试（不消耗冷却）；否则冷却 `cooldown_minutes`（默认 60），冷却后若 `repeat_while_active=false` 仅更高严重度才再通知。恢复发一条 info/`(host,category)`；`skip_prefixes` 不自动恢复。
- Silence 优先级 `all > group > host`，每次读库（无缓存）。
- 通知：nodemailer（SMTP/SSL/STARTTLS、3 次线性重试 3s×attempt、认证失败立即中止）、`fetch` webhook（wecom/dingtalk/feishu/通用，2xx 且 `errcode==0` 才成功，timeout 10s）、Electron `Notification`（永不抛）。

### 6.6 报表 / 周报 → `backend/src/report/*`
- 主机顺序 = `config.servers` 顺序；日报上下文含 total/success/failed + `failed_hosts`；主题 `"{prefix} {YYYY-MM-DD}"`。
- 周报范围 = 上一个本地周一..周日（tz 感知）；分类需 `_MIN_SAMPLES_FOR_CLASSIFICATION=3`；强度 `cpu*0.5 + mem*0.3 + gpu*0.2`（无 GPU 时 `/0.8` 归一）；busy≥70 降序、idle≤20 升序；服务检查读**当前**快照；SVG 趋势需 ≥2 点，否则"数据不足"。
- 报表模板：把 `report.py` 用的 Jinja 报表模板转 Nunjucks（或 EJS），内联 SVG 手移植，保证邮件 HTML 语义等价。

### 6.7 磁盘健康 / 容量 / 用户 / 诊断 → `backend/src/{disk,capacity,users,diagnostics}/*`
- `disk_health.py`（storcli RAID/盘位解析、健康规则、温度阈值 55℃）纯解析 + 规则移植，用 `tests/fixtures/storcli` 驱动。
- `capacity.py`（线性斜率→阈值 ETA）、`disk_capacity.py`（挂载点状态/最大百分比）。
- `user_scan.py`/`user_collection.py`/`user_admin.py`：只读 `/etc/passwd`+`/data` 扫描；受控账号开通（`build_plan`/`execute_plan`/`PlanCache` TTL 600s、最多 32 计划、命令超时 120s；`du` 预算 `max(60, usage_timeout)`、每账号 `timeout -k 10`、部分结果续算）。
- `diagnostics.py`：按严重度排序的主机诊断行。

### 6.8 桌面壳 → `desktop/src/main/*`（main.ts）
- 单实例锁（`requestSingleInstanceLock`）、窗口、`Tray`（菜单：显示主窗口/复制看板地址/打开日志目录/退出）、最小化/关窗隐藏到托盘、双击恢复、`window-all-closed` 重建托盘。
- 开机自启：`app.setLoginItemSettings`（`--start-hidden`）；取代 `注册开机自启.ps1`。
- 生命周期：启动 `utilityProcess('backend')` → 轮询 `runtime.json`（≤30s，提前退出即致命）→ 加载 URL；异常退出按 `[2000,5000,10000,20000,30000]`ms 退避重启后固定 30s；退出时先优雅关闭后端（发信号/关闭 stdin 等），超时再强杀进程树。
- `paths.ts`：解析安装目录、数据目录（读 HKCU 指针）、日志目录；不再从 appDir 旁取数据。
- 自动更新：`electron-updater`（`autoUpdater.checkForUpdates`、下载、`quitAndInstall`），IPC 暴露 `update:check/download/install`；保留 UI `settings-update.js` 的"检查更新"入口。

---

## 7. 数据与兼容（必须逐条满足）

1. **同一 SQLite 文件**：迁移后继续读 `storage.db_path`；默认 `data/servermonitor.db`。不重命名表/列/PK/索引。
2. **老库升级路径**：`journal_mode=delete` 的 legacy 库（12 表、`host_metrics_history` 少 3 列）打开即执行幂等 DDL + 加法迁移；不重建整表（除 `host_daily_summary` 缺 `tz` 的必要重建）。
3. **时间/JSON/布尔格式**与现状**逐字节兼容**（供既有行继续参与比较/排序/解析）。
4. **备份校验契约**保持（含 `app_settings`+`app_secrets` + `integrity_check` 才认作合法备份）。
5. **密钥**：`win-dpapi` 原样 flags 解密旧 blob；机器 id 变更→清密钥→force_setup 行为保留。
6. **迁移安全网（必须）**：任何会改动 schema 的启动迁移（含 `host_daily_summary` 重建）前，先原子复制一份 `backups/pre-migrate-<version>-<ts>.db`；迁移在事务内执行，任一步失败则回滚并**中止启动**（不带着半迁移库运行）；成功后方可继续。"升级前备份 + 损坏即恢复"是"数据不丢"反目标的唯一保障。
7. **旧配置导入**：首次运行时把既有 `config.yaml` + `.env` 的定制项**一次性导入** DB（字段映射见 §6.2 schema）；此后 DB 为唯一权威，`config.yaml` 仅作 seed，界面只读展示并提供「从 yaml 重新导入」按钮；首次之后对 yaml 的修改被忽略（明确提示），避免静默丢失或双重来源。

---

## 8. 迁移策略：分阶段 + 差分对照（Strangler 思路）

> 真正的"绞杀者"在单体重写里表现为：Python 后端在迁移期**继续存在并作为行为 oracle**，Node 后端逐模块达到等价，最后统一切断 Python。每一步都可独立验证、可回滚。

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0 脚手架** | pnpm 工作区、`backend`/`desktop` TS 骨架、esbuild 打包、electron-builder NSIS 骨架、CI job | 空后端 `/api/system/health` 起得来；安装器能装/卸空壳 |
| **P1 存储层** | better-sqlite3 复刻全部表/迁移/仓库 API/备份 | 打开真实旧库 + legacy fixture 通过；与 Python 同输入同输出对照 |
| **P2 Web/认证/设置** | Express + Nunjucks 渲染全部页面；`/api/settings` 1:1；登录/CSRF/限流/SSRF | 全部页面 200；登录流程；设置读写；模板 golden |
| **P3 采集/SSH/解析** | ssh2 采集、22 阶段、解析器 | fixture 对照；真实主机冒烟（或 mock） |
| **P4 调度/告警/通知** | scheduler catch-up、AlertEngine、通知三通道 | catch-up 时序对照；告警状态机用例对照 |
| **P5 报表/磁盘/用户/容量/诊断** | 上述模块移植 | 报表 HTML 对照；storcli fixture；用户计划 |
| **P6 Electron 集成** | utilityProcess 生命周期、托盘、单实例、端口、数据目录选择、首启导入 | 打包前后端联动；崩溃恢复；托盘行为 |
| **P7 差分验证** | 对同一 DB 副本回放 `/api/*` 与定时任务，逐字段 diff | 差异清零；全量 Node 测试绿 |
| **P8 收尾发布** | NSIS 安装/卸载/自启/electron-updater；移除 Python/packaging/ps1/旧 sidecar；文档 | 安装到自定义非 C 目录→运行→升级→卸载保留数据；CI release 成功 |

每阶段门禁：新增 Node 测试通过 + 关键路径差分通过 + 不破坏迁移期 Python 基线（1892 passed / 1 skipped 仍绿）。

---

## 9. 测试与验证

- **Python 作 oracle（迁移期）**：保留现有 254 个测试文件；对纯函数（parsers/alerts/scheduler/report/capacity）构造"同一输入→同一输出 JSON"的对照测试。
- **Node 单测（vitest）**：保留现有依赖注入缝（注入 `clock`/`runner`/`ssh factory`/`scheduler`），复用 `tests/fixtures`。
- **DB 兼容测试**：内置 legacy `servermonitor.db` fixture，open→migrate→断言 schema/查询结果。
- **API 契约 golden**：对 `/api/*` 生成脱敏 golden 快照并比对。
- **E2E（Playwright / Electron）**：首启 `/setup` → 登录 → 概览 → 添加主机 → 终端 冒烟。
- **安装器/升级测试**：静默安装到自定义目录 → 启动 → 卸载保留数据；用本地 update server 模拟 electron-updater。

### 9.1 "diff = 0" 等价判据（明确规范化）
- **冻结不稳定源**：测试注入固定 `clock`/`uuid`/随机数；动态端口、PID、机器名、运行时长一律掩码。
- **时间**：比较前把 ISO 时间戳解析回 UTC 再比，允许 µs 级差异；报表日期用注入的本地时区。
- **浮点**：统一 `toFixed(6)` 或相对误差 ≤1e-6 后比较（避免 0.1+0.2 噪声）。
- **顺序**：对无显式排序的集合，按**显式排序键**（如 host_name/category/created_at）规范化后再比；禁止依赖 DB 返回顺序。
- **易变实时数据**：`host_latest_snapshot` 的实时指标/uptime 不纳入 golden，改用「结构 + 关键字段」断言。
- **结论**：以上规范化后，`/api/*` 的稳定字段必须**逐字节相等**；任何不等即视为回归（gate 失败）。差分 harness 输入 = 同一 DB 副本 + 注入时钟 + 屏蔽网络（SSH/SMTP 用录制 fixture）。

---

## 10. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| DPAPI 旧 blob 无法解密 | 用户密钥丢失 | 用 `win-dpapi` 同 flags；专项迁移测试 |
| 时间戳格式不一致 | 排序/范围查询错乱 | 统一 `nowIsoUtc()` 6 位微秒；对照测试 |
| 调度 catch-up 语义偏差 | 漏报/重复报表 | 自研调度 + 时序对照 |
| utilityProcess 生命周期/SSE/SSH 终端 | 终端断流、重启竞态 | 沿用现有握手+退避；专项 E2E |
| Nunjucks 缺 `namespace`/`selectattr`/`format` | 模板报错 | 兼容层 + 少量模板改写 |
| NSIS per-user 与"非 C 默认"冲突 | 默认仍落 C | 向导默认策略 + 可改（见 §11） |
| electron-updater 对安装目录写权限 | 更新失败 | per-user 安装可写；per-machine 需 UAC 提示 |
| 无代码签名 → SmartScreen 警告 | 首次运行体验差 | 需证书；否则文档说明 |
| 体积（Electron 运行时） | 包体较大 | 与现 430MB 解压同量级，可接受 |

---

## 11. 已确认的产品决策（用户 2026-11-25 拍板）

1. **安装范围**：`per-user` 免管理员安装。
2. **默认目录**：安装 `D:\Tools\ServerMonitor`，数据 `D:\ServerMonitorData`；无 D 盘时各自回退到 `%LOCALAPPDATA%` 下（`...\Programs\ServerMonitor` / `...\ServerMonitor`）。二者均可自定义。
3. **发行形态**：只发 NSIS 安装器，彻底收敛（不保留便携 zip）。
4. **代码签名**：无证书，按无签名发布，文档说明 SmartScreen 首次运行提示。
5. **更新引擎**：`electron-updater`（GitHub 公开仓库，CI 产出 `latest.yml`）。
6. **旧用户迁移 / 首启导入**：安装器首启自动探测旧 `data/servermonitor.db` 并复制导入；`config.yaml` / `.env` 一次性导入 DB。
7. **运行环境**：仅 Windows 10/11 桌面、单用户使用。
8. **降级策略**：只前进、出问题发修复版，配"升级前自动备份"。

---

## 12. 我做的决定（Builder 可质疑，但默认按此执行）

- 后端运行于 **Electron `utilityProcess`**（非 main 内嵌）——隔离同步 DB 与聚合计算、保留崩溃隔离。
- **保留 HTTP + 前端零改**（Express + Nunjucks 兼容层，`static/` 原样）。
- 选型：Express / Nunjucks / better-sqlite3 / ssh2 / nodemailer / 自研调度 / `win-dpapi` / `electron-updater`。
- 数据目录指针存 **HKCU 注册表**（`HKCU\Software\ServerMonitor\DataDir`），默认 `{安装目录}\data`；日志放数据目录下 `logs\`。
- 迁移期**保留 Python 作 oracle**，P8 统一移除 Python / `packaging/` / `.bat` / `.ps1` / 旧 sidecar。
- **升级路径**：不单独做迁移工具；新安装器首启自动探测旧 `data/servermonitor.db` 并复制导入（用户已确认）。
- **迁移安全网**：任何 schema 迁移前强制备份 + 事务回滚（§7.6）。
- **旧配置**：一次性把 `config.yaml`/`.env` 导入 DB，DB 为权威（§7.7）。
- **等价判据**：按 §9.1 规范化后，稳定字段逐字节相等才算通过。
- **数据目录与安装目录解耦**（§5.2），以规避 per-machine 写权限问题。

---

## 13. 验收标准（Definition of Done）

- 安装器可装到**自定义非 C 目录**、可卸载（默认保留数据）、开始菜单、登录自启、单托盘、**无任何 `.bat`/`.ps1`、无 Python 运行时**。
- 全部页面与 `/api/*` 契约与旧版一致（golden diff 通过）。
- 现有 `servermonitor.db`（含 legacy）**直接可用**、自动升级、密钥可解密。
- 告警/调度/报表/终端行为**对照通过**。
- Node 单测 + 差分测试 + E2E 全绿；CI release 成功发布可安装版本。

---

## 14. 附录：现状快速索引（as-is，供实现参考）

- **Electron 现生命周期**：`main.js` 以 `--headless --parent-stdin --config <cfg> [--dotenv <f>]` 拉起 `servermonitor-backend.exe`，env `SERVERMONITOR_DESKTOP=1`/`PYTHONIOENCODING=utf-8`，`cwd=appDir`；`runtime.json {url,port,pid}`；`waitForRuntime` 250ms×30s；`startWithRetry({attempts:2})`；崩溃退避 `[2,5,10,20,30]s` 后固定 30s；`stop()` 关 stdin→等 7s→`taskkill /T /F`。
- **关键文件**：存储 DDL `servermanage/storage/base.py:39-370`；init/migrations `base.py:805-864,440-464,568-603,937-981`；默认库路径 `servermanage/models.py:143`；配置解析 `servermanage/config.py:96-109`；Web 守卫 `servermanage/web/routes/__init__.py:427-539`；SSRF `servermanage/web/routes/_core.py:608`；密码/DPAPI `servermanage/security.py`；设置契约 `servermanage/settings/sections.py:71-224`；schema `servermanage/settings/schema.py:57-615`；打包 `desktop/electron-builder.yml`、`desktop/scripts/build-portable.ps1`、`packaging/`。
- **现状体量**：Python 后端约 2.67 万行（storage 5002 / routes 5759 / 核心 13416 / settings 2562）；测试 254 文件 / 37794 行；桌面壳 JS 若干。
