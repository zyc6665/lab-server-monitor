# 网页在线配置与监控增强设计

- 状态：已确认（2026-11-06 用户批准）
- 适用工程：`servermonitor-main/servermonitor-main`
- 关联设计：`docs/plans/2026-11-06-pc-polling-monitor-design.md`
- 关联实施：`docs/plans/2026-11-06-pc-polling-monitor-implementation.md`

## 一、背景与目标

工具已作为 Windows 绿色包交付，当前配置仍依赖 `config/config.yaml` 和 `config/.env`。实际使用场景是：实验室服务器管理人员每人拿到压缩包，在自己电脑上运行独立实例，各自维护主机、SSH 账户和通知渠道；使用者毕业以后，工具要能交接给下一位管理员长期使用。

因此需要把配置能力搬到网页里：除首次启动设置管理员密码外，日常所有配置都在浏览器完成，不再要求使用者编辑 YAML 或环境变量文件。同时补齐三项监控能力：日报/周报启停、当前登录用户、按主机配置的磁盘容量监控目录。

## 二、已确认需求

1. **全量网页配置**：主机与 SSH 账户、邮件、Webhook、看板密码、日报/周报、告警阈值、轮询频率、保留天数、时区、磁盘健康规则等都能在网页新增和修改。
2. **每台电脑独立实例**：每个人拿到压缩包在自己电脑运行一套，配置各自独立，不做中央服务器或多用户权限体系。
- **Docker 部署保留**：Docker/Linux 仍按原来的 `config.yaml` + `.env` 方式运行，不提供网页写入敏感凭据的能力；网页配置页在 Docker 下以只读/说明状态呈现。Windows 绿色包是完整网页配置的目标平台。
3. **凭据保护**：SSH 私钥/口令、邮箱密码、Webhook 密钥默认绑定本机 Windows 账户加密保存；整个工具文件夹被拷到别的电脑后，这些凭据不能直接解开或使用。每台电脑重新填写。
4. **首次启动**：第一次打开网页必须强制设置管理员密码，之后才能进入配置页。
5. **日报/周报**：启用状态可在网页修改，保存后立即改变调度；日报/周报时间、主题前缀、收件人等也纳入网页配置。
6. **当前登录用户**：概览页显示每台服务器当前登录人数；主机详情页显示用户名、终端、登录时间、来源地址。只展示，不因新用户登录而告警。
7. **磁盘容量监控项**：默认只监控 `/` 和 `/data`；每台主机可在网页增加、删除监控目录；目录不存在时显示“未挂载”并标记异常/提醒，不静默隐藏。
8. **配置入口**：入口放在网页“设置”页，替换现有只读设置页。

## 三、非目标 / Anti-goals

- 不做中央控制台、账号体系、角色权限、多人同时编辑同一个实例。
- 不做配置在电脑之间的自动同步。
- 不把 SSH 私钥、邮箱密码、Webhook 密钥以明文或可逆的固定密钥写入 YAML/`.env`。
- 不改变已经完成并验证的磁盘健康（storcli）逻辑；本次只增加容量监控目录的筛选与配置。
- 不实现非 storcli 磁盘的“未纳管盘”健康采集（既有设计已正式 defer）。
- 不在 1.1 提供“导出/导入非敏感配置模板”；交接时直接复制示例配置、在网页重填凭据。
- 不引入前端构建链（保持 Flask + Jinja2 + 原生 JS）。

## 四、关键设计决策

### 4.1 配置保存在 SQLite，YAML 只作初始种子

新增 `app_settings` 表保存网页配置，新增 `app_secrets` 表保存加密后的敏感值。启动时读取 `config.yaml` 生成默认 `AppConfig`，若数据库已有保存的配置则覆盖对应区段。之后网页保存只写数据库，不改 `config.yaml`、不改 `.env`。

理由：
- 用户明确要求不再改 `config`/`.env`；数据库是程序自己的数据，原子写入和回滚更简单。
- 绿色包升级只需替换 exe，`data/servermonitor.db` 保留配置。
- YAML 继续承担极少量的启动引导项：`storage.db_path`、`dashboard.host/port` 的初值、以及从旧版本升级时的种子主机列表。

保存粒度：每个配置区段一行（`general`、`dashboard`、`alerts`、`report`、`disk_health`、`hosts`、`ssh`），值为 JSON。读取时整段覆盖，不做字段级 diff；避免 YAML 与数据库字段合并产生歧义。

### 4.2 敏感值用 Windows DPAPI 加密

新增 `servermanage/security.py`：

- `protect_secret(data: bytes) -> bytes` / `unprotect_secret(blob: bytes) -> bytes`，通过 `ctypes` 调用 `crypt32.dll` 的 `CryptProtectData` / `CryptUnprotectData`，使用当前 Windows 用户作用域（不传 `CRYPTPROTECT_LOCAL_MACHINE`），并带 `CRYPTPROTECT_UI_FORBIDDEN`。
- 非 Windows（Docker/Linux）不启用 DPAPI 与网页敏感配置：继续使用原有 YAML/`.env`，设置页对应分区显示“Docker 部署请编辑 config.yaml/.env”，`/setup` 与网页密码管理不启用。DPAPI 调用失败时，Windows 版也拒绝保存敏感配置并在页面报错；绝不静默降级为明文。
- `SecretStore` 封装 `app_secrets(name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, updated_at TEXT NOT NULL)`：`get(name)`、`get_bytes(name)`、`set(name, value)`、`delete(name)`、`has(name)`。

保存对象：
- 主机密码：`host:<name>:ssh_password`
- 私钥内容：`host:<name>:ssh_key`（PEM/OpenSSH 私钥全文）
- 私钥口令：`host:<name>:ssh_passphrase`
- SMTP 密码：`smtp:password`
- Webhook URL（含密钥）：`webhook:url`
- 会话签名密钥：`dashboard:session_secret`
- 管理员密码不保存明文或可解密值；PBKDF2-HMAC-SHA256 哈希、随机盐和迭代次数作为一条 DPAPI 加密记录存放在 `app_secrets('dashboard:admin_password')`（JSON `{hash, salt, iterations}`）。`GET /api/settings` 永不返回该记录；`setup_required` 以该记录是否存在计算。

私钥上传：设置页支持上传文件或粘贴文本，限制 256 KB。私钥内容只存加密后的 BLOB，不落盘为明文文件。`SSHClientWrapper` 改动为：当 `AuthConfig.key_data` 存在时，用 `paramiko.PKey.from_private_key(io.StringIO(key_data), password=passphrase)` 得到 `pkey` 并传给 `SSHClient.connect(pkey=...)`；保留旧的 `key_path` 方式兼容现有配置。

### 4.3 首次启动强制设置管理员密码

- 判定条件：`app_secrets` 中没有管理员密码哈希，并且环境变量/旧 `.env` 的 `DASHBOARD_PASSWORD` 为空 → `setup_required=True`。
- 所有页面请求（除 `/setup`、`/static/*`）重定向到 `/setup`；所有 `/api/*` 返回 `428 Precondition Required`。
- `/setup` 只允许来自 loopback（`127.0.0.1` / `::1`）的请求，防止局域网内别人在密码设置前抢占实例；非本机访问显示“请在本机打开此页面完成初始化”。
- 表单要求用户名（默认 `admin`）、密码、确认密码；密码至少 8 位。保存 PBKDF2 哈希后生成随机 `dashboard:session_secret` 并通过 DPAPI 保存，随后进入登录页。
- 升级已有实例：若 `.env` 中仍有 `DASHBOARD_PASSWORD`，照旧可登录，不强制重设；管理员可在设置页修改密码，保存后数据库哈希优先于 `.env`。
- **旧凭据自动迁移**：Windows 版首次以新配置方式启动时，如果 `app_secrets` 为空而 YAML/`.env` 中已有 SSH 密码、私钥、SMTP 密码或 Webhook URL，启动过程会逐项加密写入 `app_secrets`（一次性、幂等）；失败时只记录警告并在设置页提示“请重新填写”，绝不覆盖或删除旧配置。
- **换电脑强制重新初始化**：`app_settings('security')` 保存 `machine_id`（Windows `MachineGuid` + 当前用户名派生）。启动时比对，若检测到数据库来自另一台电脑（`machine_id` 不一致）或关键秘密无法用本机 DPAPI 解密，则清除管理员密码记录与全部 `app_secrets`，进入 `setup_required`；主机清单、轮询参数、报告设置等非敏感配置保留，管理员重新设置密码并重填各主机凭据，避免数据库被直接拷走后继承旧管理员身份。

### 4.4 设置页保存立即生效，端口类改动重启生效

- 普通配置（主机、告警、报告、磁盘目录、轮询频率）保存后在同一进程内生效：`SettingsService.save()` 校验 → 写数据库事务 → 重建 `AppConfig` → 调用 `MonitorService.apply_config(config)` 停止并重建调度任务。
- 保留 `Scheduler.stop()` / `start()`；每次保存后重建任务列表，使轮询间隔、日报/周报时间、启用状态立即改变。
- `dashboard.host`、`dashboard.port` 改动写入数据库并标记 `restart_required=True`，页面提示“已保存，重启程序后生效”。当前进程不尝试迁移监听端口。
- 修改管理员密码或其他关键凭据后，使其他会话失效（保留当前会话）。

## 五、配置模型变更

### 5.1 数据模型

`servermanage/models.py` 调整：

- `HostConfig` 新增 `disk_mounts: list[str] = ["/", "/data"]`（用 `field(default_factory=lambda: ["/", "/data"])`），表示容量监控目录；仅用于容量展示与阈值，不影响 storcli 物理盘健康。
- `AuthConfig` 新增 `key_data: str | None = None`，用于解密后驻留内存的私钥内容。
- `WeeklyReportConfig` 新增 `weekday: int = 4`（0=周一，默认周五），使周报日期可在网页配置。
- `DashboardAuthConfig` 新增内存字段 `password_hash: str | None`、`password_salt: str | None`、`password_iterations: int = 200_000`（只用于运行时校验，不写入 `app_settings` 的公开 payload；持久化在加密的 `app_secrets('dashboard:admin_password')`）；`password`/`password_env` 保留为旧配置兼容。
- `AppConfig` 结构不变，仍由 `config.load_config()` 或新的 `settings_service` 构造。

### 5.2 数据库表

`servermanage/storage.py` 的 `init_storage()` 增加：

```sql
CREATE TABLE IF NOT EXISTS app_settings (
    section TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_secrets (
    name TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL,
    updated_at TEXT NOT NULL
);
```

无需改动既有监控表。`host_latest_snapshot` 的 `raw_json` 已包含 `metrics.logged_in_users` 与 `metrics.disk_usage`，无需新增列。

### 5.3 配置读取顺序

新增 `servermanage/settings_service.py`：

```text
load_effective_config(config_path, db_path) -> AppConfig
  base = config.load_config(config_path)          # YAML 种子
  overrides = SettingsRepository(db_path).load()   # 数据库区段
  return build_config(base, overrides, SecretStore(db_path))
```

- `build_config` 对每个区段逐个覆盖；主机区段一旦存在就整体替换 YAML 主机列表。
- 旧实例第一次启动没有 `app_settings` 行：使用 YAML 配置（含 `.env` 的密码/密钥），页面“设置”展示这些值（敏感项显示“已配置”，不回显明文）。
- 第一次网页保存后，数据库对应区段成为唯一来源。

## 六、设置页信息架构

保留 `/settings` 路由，改为可编辑页面，左侧分区（移动端为顶部标签）：

1. **主机**
   - 列表：名称、地址、端口、用户、认证方式、磁盘目录、磁盘健康是否启用。
   - 新增/编辑：名称（创建后不可改）、地址、端口、用户名、认证方式（密码/私钥）、密码或上传私钥+口令、标签、容量监控目录（多行，默认 `/`、`/data`）、storcli 路径覆盖、该主机是否启用磁盘健康。
   - 测试连接按钮：使用未保存的表单值尝试 SSH `hostname`，显示成功/错误原因。
   - 删除主机：二次确认；历史数据保留，不再轮询。
2. **监控与存储**：状态轮询秒数、磁盘健康轮询秒数、并发数、历史保留天数、时区、数据库路径（只读展示；修改需重启）。
3. **通知**
   - 总开关、桌面通知、邮件、Webhook 三类渠道开关。
   - 邮件：SMTP 主机、端口、用户名、密码、发件人、收件人（多个，逗号或分号分隔）。
   - Webhook：类型（企业微信/钉钉/通用）、URL；敏感 URL 不回显。
   - 阈值：CPU、内存、磁盘、GPU 显存、磁盘温度。
   - 冷却分钟、持续告警是否重复、离线判定次数。
   - 邮件测试、Webhook 测试按钮。
4. **报告**
   - 日报：启用、时间、主题前缀。
   - 周报：启用、星期几、时间、主题前缀、忙碌/空闲阈值。
   - 领导摘要：启用、收件人、主题前缀。
   - 没有配置 SMTP 时启用日报/周报，保存时提示错误并阻止。
5. **磁盘健康**：总开关、使用 sudo、storcli 候选路径、6 条告警规则开关。
6. **看板与安全**：管理员用户名、修改密码（需当前密码）、监听地址、端口、会话有效期；修改端口提示重启。

保存方式：
- 每个分区一个 `POST` 表单/JSON，保存成功显示内联提示；不需要一次提交整页。
- 所有敏感输入框为空时表示“保持原值”，不覆盖已保存密钥；提供“清除”复选框。

## 七、监控功能变更

### 7.1 当前登录用户

- 数据来源已有：`commands.WHO_STAGE = "who"`，`parse_who()` 生成 `LoggedInUser(username, terminal, login_at, remote_host)`，并保存在 `HostMetrics.logged_in_users` 与快照 JSON。
- `web/routes.py` 的 `_host_row` 增加 `logged_in_user_count`：按**去重用户名**计数（同一用户多个终端/tmux 会话只算 1 人）；另返回 `logged_in_sessions` 为会话总数供详情展示。
- 概览表格增加“登录用户”列，显示去重人数；主机详情增加“当前登录用户”表格（用户名、终端、登录时间、来源）；无记录显示“无”。
- 不新增告警规则。

### 7.2 磁盘容量按主机筛选

- 每台主机 `HostConfig.disk_mounts` 默认 `["/", "/data"]`。
- `_disk_percent` / `_extract_disk_used_percent` 增加 `mounts` 参数：只统计 mountpoint 精确匹配的 `DiskUsageRow`，忽略 tmpfs 等虚拟文件系统；`/` 与 `/data` 之外的行仍在快照 JSON 中但不参与展示/阈值。
- 主机详情磁盘表只显示配置的挂载点；每个配置项输出 `present: bool`。缺失时显示 `未挂载` 徽标。
- 概览 `disk_percent` 取配置挂载点中的最大使用率；`disk_missing` 返回缺失的挂载点列表，页面显示警告徽标。
- 缺失挂载点**只在页面标记**（徽标 + 详情“未挂载”），不进入 AlertEngine、不产生桌面/邮件/Webhook 通知；避免没有 `/data` 的主机每天重复告警。
- `evaluate_system_alerts` 增加可选 `disk_mounts: list[dict]`：只对实际存在的配置挂载点逐项应用容量阈值（消息中含挂载点名称），缺失挂载点不产生事件。保留原 `disk_percent` 参数以兼容旧测试/调用。
- `persist_host_reports` 的 `disk_used_percent` 改为按该主机 `disk_mounts` 计算的最大值；历史周报保持单值语义。
- 修改主机监控目录后下一轮采集开始生效，历史数据不重算。

### 7.3 日报/周报调度

- `MonitorService` 重建任务时读取 `report.daily_enabled`、`report.daily_time`、`report.weekly.enabled`、`report.weekly.weekday`、`report.weekly.time`。
- 周报任务不再硬编码周五（当前 `app.py` 中 `weekday=4`），改为 `config.report.weekly.weekday`。
- 周报/日报邮件发送仍依赖 `smtp`；`smtp is None` 时跳过并记录日志，页面在保存时阻止“启用报告但无 SMTP”的配置。

## 八、API 设计

新增路由（均在现有登录保护内，除 `/setup`）：

- `GET /api/settings`：返回可公开的配置（敏感字段只返回 `configured: true/false`，不返回值）。
- `PUT /api/settings/<section>`：保存 `general|monitoring|alerts|report|disk_health|dashboard` 区段；返回 `{"ok": true, "restart_required": bool}`。
- `GET /api/settings/hosts` / `POST /api/settings/hosts` / `PUT /api/settings/hosts/<name>` / `DELETE /api/settings/hosts/<name>`。
- `POST /api/settings/test-ssh`：表单主机连接参数，返回 `{ok, message}`。
- `POST /api/settings/test-email`、`POST /api/settings/test-webhook`。
- `POST /api/settings/password`：当前密码 + 新密码。
- `/setup` GET/POST 页面；`/api/*` 在 setup 模式返回 428。

安全：
- 所有写操作要求登录会话；单管理员。
- 每个写请求校验 CSRF token（session 内随机值，表单 hidden + `X-CSRF-Token`）。
- 登录失败按 IP 简单限速（内存计数，5 次/分钟），不持久化。
- Cookie `HttpOnly`、`SameSite=Lax`；LAN 访问仍使用密码。
- 任何日志不得输出密码、私钥、邮箱密码、Webhook URL。

## 九、运行时与组件变更

- `servermanage/web/__init__.py`：`create_app` 接收 `settings_service` 或 `config_provider`，`app.config["CONFIG"]` 改为读取当前有效配置；新增 `setup_required` 状态。
- `servermanage/web/routes.py`：增加设置 API、设置页、首次启动重定向；`_build_overview` / `_build_host_detail` 增加登录用户与磁盘目录字段。
- `servermanage/web/templates/settings.html`：完整重写为分区表单。
- `servermanage/web/static/settings.js`：提交、测试连接、显示错误；原生 JS，无 CDN。
- `servermanage/app.py`：`MonitorService` 增加 `apply_config(new_config)`；任务函数继续读取 `self.config`；`start()` 的周报任务使用配置 weekday。
- `servermanage/settings_service.py`：新增，负责配置合并、校验、持久化、构建 `AppConfig`、DPAPI 解密、密码哈希。
- `servermanage/security.py`：新增 DPAPI 封装与 PBKDF2 密码哈希。
- `servermanage/config.py`：新增 `load_config_from_mapping` 或允许空 `servers`（首次启动无主机时也能启动），同时保留 `load_config(path)` 兼容旧入口。
- `servermanage/storage.py`：增加 `app_settings` / `app_secrets` 表与通用读写函数；`init_storage` 幂等升级。
- `servermanage/ssh_client.py`：支持内存私钥（`pkey`）。
- `servermanage/models.py`：字段扩展。

## 十、首次启动与旧配置迁移

1. 新压缩包不带真实密码：`config/.env` 可不存在或为空；`config/config.yaml` 只包含 dashboard 初始 host/port 与 storage.db_path，以及可选示例主机。
2. 首次启动 → `setup_required=True` → 浏览器本机打开 `/setup` → 设置管理员密码 → 进入设置页 → 添加主机/SSH 凭据。
3. 旧实例升级：
   - 保留原 `config.yaml` 与 `.env`；无 `app_settings` 时按旧配置运行。
   - 首次启动自动把 YAML/`.env` 中可用的 SSH/SMTP/Webhook 凭据加密迁入 `app_secrets`；设置页敏感项显示“已配置”。
   - 首次保存设置页后，数据库对应区段覆盖旧 YAML；以后不再依赖 `.env`。
   - 旧 `key_path` 认证方式继续可用；网页可改为上传私钥或密码。
4. **换电脑交接**：把整个文件夹复制到另一台电脑后，启动检测到 `machine_id` 不一致或 DPAPI 解不开旧秘密，就清除管理员密码与全部密钥，强制新管理员在本机 `/setup` 重新设置；主机清单等非敏感配置保留，各主机 SSH 凭据需重新填写。
5. 删除主机：只从配置移除，历史快照保留；不做自动清库，避免误删审计数据。

## 十一、错误处理

- 保存失败不改变内存配置：先校验全部字段，再单事务写库；写库失败原配置继续运行。
- 测试连接/测试通知失败只返回错误信息，不写入配置。
- DPAPI 不可用、无法解密旧密钥时：页面提示“本机无法解密此凭据，请重新填写”，主机标记配置错误，不阻塞其他主机采集。
- 无法解析的配置项保存时返回 400 + 字段级错误信息。

## 十二、测试策略

- `tests/test_security.py`：DPAPI 往返、错误 BLOB、非 Windows 分支（mock）、PBKDF2 校验。
- `tests/test_settings_service.py`：YAML 种子、数据库覆盖、区段整体替换、主机 CRUD、秘密不进入公开 API、密码哈希。
- `tests/test_settings_api.py`：未登录 401、CSRF 缺失拒绝、首次启动 428/重定向、保存后 `resolved config` 生效、端口改动 `restart_required`。
- `tests/test_web_api.py` 扩展：`/api/overview` 的 `logged_in_user_count`、`/api/host/<name>` 的登录用户列表和磁盘 `present`。
- `tests/test_alert_rules.py` 扩展：按 `disk_mounts` 逐目录阈值、缺失目录 warning。
- `tests/test_storage.py` / `test_storage_extended.py`：新表初始化幂等、设置读写、秘密读写。
- `tests/test_integration_smoke.py` 扩展：临时数据库 + 设置保存 + `MonitorService.apply_config` 后任务重建；不依赖真实 SSH。
- 真实机器回归：4 台现有主机（a100/v100/4090/h100）在完成 sudoers 后，容量列表只显示 `/`、`/data`；`who` 无登录用户时显示 0；网页设置保存后状态轮询继续正常。

## 十三、打包与交付

- 新版绿色包不再要求 `config/.env` 提供看板密码；`启动.bat` 不再硬性检查 `.env`，仅在文件存在时加载。
- `config/config.yaml.example` 增加可选的设置页引导说明；README 更新：
  - 第一次启动如何在本机设置密码；
  - 如何在网页添加主机与 SSH 私钥；
  - 凭据绑定本机 Windows 账户，换电脑需重新填写；
  - 端口改动需重启。
- 仍使用 PyInstaller `--onedir`；新增模块 `security.py`、`settings_service.py` 要进入 spec 的 hiddenimports/收集范围（常规 Python 模块会被自动收集，打包后需实际启动验证）。
- 版本号建议提升到 `1.1.0`。

## 十四、Builder 自行决定的事项（供检查）

- 设置数据按区段整段覆盖，不做字段级 merge。
- 主机 `name` 创建后不可修改（避免历史数据归属混乱）。
- 删除主机保留历史数据。
- 端口/监听地址修改只保存，不自动重启。
- 首个管理员由 `/setup` 创建，且只允许 loopback 访问。
- 磁盘缺失目录只在页面标记，不产生通知（用户已确认）。
- 设置页使用 Jinja2 表单 + 原生 JS，不引入前端框架。
- 敏感输入框留空表示保持原值，另设“清除”操作。
- Docker/Linux 保持 YAML/.env 模式，不开放网页敏感配置；Windows 版才启用 DPAPI。
- 换电脑复制数据库时强制重新 `/setup` 并重填凭据。

## 十五、已解决的检查问题

1. **Docker/Linux**：保留现有 Docker 部署，但只走 YAML/.env、不开放网页敏感配置；Windows 绿色包是网页配置目标平台。
2. **旧凭据迁移**：首次启动自动把旧 YAML/.env 中的可用凭据加密迁入 DPAPI；失败只提示重填，不静默丢失。
3. **换电脑交接**：检测到不同电脑后清除管理员密码与全部密钥，强制新管理员本机 `/setup`；非敏感配置保留。
4. **管理员密码存储**：哈希+盐+迭代次数作为 DPAPI 加密记录放 `app_secrets('dashboard:admin_password')`，公开设置 API 永不返回。
5. **当前登录人数**：按去重用户名计数；详情页展示全部会话。
6. **缺失挂载点**：只在页面标记“未挂载”，不产生告警通知。
7. **导出/导入模板**：1.1 不做，列为非目标。
8. **管理员用户名**：允许修改，需当前密码；修改后其他会话失效。
