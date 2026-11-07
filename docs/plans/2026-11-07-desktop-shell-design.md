# 服务器轮询监测工具桌面版设计（Electron）

- 日期：2026-11-07
- 状态：已确认（2026-11-07 用户批准）
- 相关设计：`docs/plans/2026-11-06-pc-polling-monitor-design.md`、`docs/plans/2026-11-06-web-settings-monitoring-design.md`、`docs/plans/2026-11-06-v1.2-usability-design.md`

## 1. 目标

把现有 Windows 绿色包从“后台网页服务 + 手动打开浏览器”升级为“独立桌面软件”：

- 双击启动后直接出现独立 Windows 应用窗口，不再打开浏览器；
- 窗口内显示现有看板、主机详情、告警和设置页面；
- 关闭窗口时最小化到系统托盘，监测继续运行；真正退出从托盘菜单选择；
- 保留现有全部功能、数据、配置和网页界面；
- 保留局域网其他电脑用浏览器访问看板的能力（原有密码登录和访问控制不变）；
- 仍是绿色包：解压后双击启动，不写注册表，不要求安装。

## 2. 非目标

- 不把网页界面重写成 Win32/WPF/Qt 原生控件；
- 不改变现有采集、解析、告警、报告、配置、数据库语义；
- 不新增监控指标、不改变权限模型；
- 不做安装程序（Setup.exe）、自动更新、代码签名；
- 不改变 Docker/Linux 的 YAML/.env 使用方式。

## 3. 已确认的用户决策

- 用户原话（m04576）：“需要打开浏览器，我觉得就做成独立软件比较好”。
- 用户确认（m04579/m04582）：独立窗口、关闭后最小化到托盘继续监测。
- 用户经确认（2026-11-07）：**保留局域网其他电脑用浏览器访问看板**，继续使用现有密码登录。
- 用户经确认（2026-11-07）：分发方式仍为**绿色包**，不做安装程序。
- 用户经确认（2026-11-07）：桌面技术栈选择 **Electron + Python sidecar**。背景：Tauri 2 更“新”，但本机没有 Rust/rustc/cargo 和 Microsoft C++ 生成工具，Tauri 需要额外安装数 GB 原生构建链；Electron 用现有 Node 即可构建，是主流桌面方案。

## 3.1 Electron builder check 落定（实现决定）

1. **设置页改地址/端口**：网页保存 dashboard 段会返回 `restart_required`。Electron 不忽略这个标记：主进程显示“需要重启后台以应用新的监听地址”，用户确认后通过 stdin 控制通道让 Python 侧优雅退出并重新拉起 sidecar，窗口在新端口可用后重新加载；启动期间页面提示"正在应用设置"。
2. **托盘/浏览器归属**：Electron 是唯一托盘和窗口所有者；Python `--headless` 永不启动 pystray、永不打开浏览器。桌面模式下设置页隐藏 `tray_enabled` 和 `open_browser_on_start` 两项（API 返回 `desktop_mode=true` 供页面判断），避免双托盘或每次弹浏览器。
3. **Windows 防火墙**：绿色包附带 `允许局域网访问.ps1`（管理员权限运行，`New-NetFirewallRule` 按当前 `servermonitor-backend.exe` 的真实路径添加 TCP 入站规则，规则名固定 `服务器轮询监测工具`）；`使用说明.txt` 说明首次启用局域网访问需运行一次。Electron 启动时若检测到无对应规则，在设置页/托盘提示，但不静默修改防火墙。
4. **Electron userData 与单实例**：启动最早阶段 `app.setPath('userData', <appDir>/data/electron)`，使 Electron 状态、缓存、锁都在绿色包目录内；单实例锁因此按解压目录生效，不同文件夹的两套实例互不影响。
5. **端口可见性**：托盘菜单增加“复制看板地址”（复制 `http(s)://<host>:<port>`）；`/settings` 顶部显示当前实际地址和端口；`logs/desktop.log` 记录启动 URL。端口顺延后 LAN 同事能拿到真实地址。
6. **启动方式**：手动启动用 `servermonitor.exe`（显示窗口）；`启动.bat` 也显示窗口，作为兼容入口。开机自启的计划任务直接调用 `servermonitor.exe --start-hidden`（`Register-ScheduledTask` 的 `-Argument` 传参），不再依赖 `启动.bat` 转发参数。
7. **v1.2→v1.3 升级**：交付/构建时把现有 `config/`、`data/`、`logs/` 原样保留，只替换程序目录和 backend；安装说明写明覆盖升级路径。另提供空白 `config/config.yaml.example` 供新电脑使用，不把 `data/servermonitor.db` 发给其他人。
8. **具体非回环监听地址**：桌面模式只支持 `dashboard.host` 为 `0.0.0.0`、`::`、`127.0.0.1` 或空；若配置为具体非回环 IP，启动时明确报错“桌面版请使用 0.0.0.0 或 127.0.0.1”，避免首次 `/setup` 的 loopback-only 限制导致 403。局域网访问仍通过 `0.0.0.0` 提供。
9. **编码**：Electron spawn backend 时设置 `PYTHONIOENCODING=utf-8`，避免中文日志在 GBK 控制台编码下损坏。

## 4. 架构

### 4.1 组成

```
servermonitor.exe (Electron 主进程)
  ├── BrowserWindow -> http://127.0.0.1:<port>  (现有网页 UI)
  ├── Tray / 单实例 / 生命周期 / 错误提示
  └── 子进程: servermonitor-backend.exe (PyInstaller 打包的 Python 后端)
        └── waitress + 调度器 + SQLite + 现有采集/告警/报告
```

- **Electron 主进程**：唯一负责窗口、托盘、单实例、开机自启参数、后端进程生命周期和日志转发；不承载业务逻辑。
- **Python backend sidecar**：保留现有 `MonitorService`、waitress、调度器、SQLite、告警、报告、网页 API；去掉桌面窗口/托盘职责，只作为无界面 HTTP 服务。
- **网页 UI**：现有模板、CSS、JS、`/setup`、`/login`、`/api/*` 全部原样复用。
- **局域网访问**：Python 后端仍按 `dashboard.host/port` 监听；Electron 窗口在桌面模式只访问 `127.0.0.1`（具体地址限制见 §3.1 第 8 条和 §4.4）。

### 4.2 Electron 版本与依赖

- `desktop/package.json` 独立管理 Node 依赖：`electron@^45.2.3`、`electron-builder@^26.18.0`（构建时下载 Electron 二进制）。
- 主进程使用 CommonJS；不需要额外前端构建链，页面直接由 Python 服务提供。
- `electron-builder` 目标为 `dir`（解压即用的 `win-unpacked`），不生成安装程序。

### 4.3 Python sidecar 打包

- 新增 `packaging/backend.spec`：入口 `servermanage/__main__.py`，`console=False`，输出 `servermonitor-backend.exe`（onedir）。
- PyInstaller 收集现有 Python 依赖、模板、静态文件和 `tzdata`；不需要 pystray/Pillow（headless 模式不加载托盘），但可以在 spec 中保留以降低风险。
- Electron 包把 backend 目录放入 `resources/backend/`；主进程按路径启动，不通过 PATH 查找。
- 启动参数固定包含 `--headless --parent-stdin`，并显式传 `--config <appDir>/config/config.yaml`、可选 `--dotenv <appDir>/config/.env`。

### 4.4 窗口地址与端口

- Python 后端先按现有 `find_available_port` 选择实际端口，并写 `data/runtime.json`。
- Electron 读取 `data/runtime.json` 的 `port` 后加载窗口。
- 窗口 URL：
  - `dashboard.host` 为 `0.0.0.0`、`::`、`127.0.0.1` 或空：`http://127.0.0.1:<port>`；
  - 为具体非回环 IP/主机名：桌面模式启动时报错并提示改用 `0.0.0.0` 或 `127.0.0.1`（见 §3.1 第 8 条），不进入窗口。
- 局域网浏览器的访问路径与监听语义完全不变。

## 5. 启动与生命周期

### 5.1 启动顺序

1. Electron `app.requestSingleInstanceLock()`；拿不到锁时，第二个实例触发已有窗口的 `show/focus` 后退出。
2. 解析程序目录：`appDir = path.dirname(process.execPath)`（开发模式为项目根）。
3. 启动 Python sidecar：
   - 参数 `--headless --parent-stdin --config <appDir>/config/config.yaml`（`.env` 存在时追加）；
   - `cwd = appDir`；
   - `stdio = ['pipe','pipe','pipe']`；
   - 把 stdout/stderr 追加到 `logs/desktop.log`。
4. 轮询 `data/runtime.json`（最多 30 秒）直到拿到实际 URL；加载 `BrowserWindow`。
5. 窗口加载完成后，根据 `--start-hidden` 决定显示或仅驻留托盘。
6. 显示窗口时禁用菜单栏，保留标准标题栏和任务栏图标。

### 5.2 关闭与退出

- 用户点窗口 X：`event.preventDefault()` → `win.hide()`；后台和服务继续运行。
- 托盘“显示主窗口”：`win.show()` + `win.focus()`。
- 托盘“退出”：先关闭窗口、发 EOF 给 backend 的 stdin（触发 Python 优雅停止调度器和 waitress），最多等待 3 秒；超时则 `taskkill /pid <backend> /t /f`；最后 `app.quit()`。
- `before-quit` 只执行一次清理，避免托盘退出和系统关机重复触发。
- 托盘不可用时：窗口关闭改为退出程序，避免出现隐藏且无法找回的窗口。

### 5.3 开机自启

- 保留 `注册开机自启.ps1`，注册计划任务指向 `启动.bat --start-hidden`（不写 Run 注册表）。
- `启动.bat` 只负责启动 `servermonitor.exe --start-hidden`；手动双击 `servermonitor.exe` 不带该参数，默认显示窗口。
- 开机自启不得弹出主窗口，只在托盘运行。

### 5.4 后端异常

- backend 启动失败或 30 秒内未写出 `runtime.json`：显示原生错误对话框，写 `logs/desktop.log`，退出。
- backend 运行中异常退出：显示“后台服务已停止”对话框；保留窗口显示错误页，用户可退出后重启。
- 不在后台自动无限重启，避免掩盖配置错误。

## 6. 界面与交互

- 应用标题：`服务器轮询监测工具`。
- 默认窗口大小 1280×800，最小 1024×700，可最大化。
- 登录/首次设置：沿用现有 `/setup` 和 `/login`；桌面窗口首次启动仍要求设置管理员密码。
- 页面内容、导航、筛选、设置分区、告警操作全部保持现状；不新增桌面专用页面。
- 托盘菜单：显示主窗口 / 打开日志目录 / 退出。
- 窗口/任务栏图标使用统一 `.ico`；标题栏不显示 localhost 或端口。

## 7. 技术改动

### 7.1 新增 `desktop/`

- `desktop/package.json`：Electron、electron-builder、启动脚本。
- `desktop/electron/main.js`：单实例、窗口、托盘、菜单、生命周期、错误对话框。
- `desktop/electron/backend.js`：解析 appDir、启动/停止 Python sidecar、stdout/stderr 日志转发、读取 `runtime.json`。
- `desktop/electron/paths.js`：`resolveAppDir()`/`configPath()`/`backendPath()`，开发和打包模式分开解析。
- `desktop/build/icon.ico`：窗口/托盘图标。
- `desktop/electron-builder.yml`：`appId`、`productName`、`directories.output=release-electron`、`extraResources` 指向 backend 目录、`win.target=dir`。

### 7.2 Python 改动

- `servermanage/__main__.py` / `servermanage/app.py`
  - 增加 `--headless`（不启动窗口/托盘，只跑服务）；
  - 增加 `--parent-stdin`（读取 stdin；EOF 时优雅停止，供 Electron 控制生命周期）；
  - `--config` 不再强制必填：无参数时默认解析可执行文件目录下的 `config/config.yaml`；
  - `--start-hidden` 仅桌面模式使用（Electron 传参，不影响 headless）。
- `servermanage/tray.py`：不再用于桌面版主路径；保留代码供 `--headless` 之外兼容，不在 Electron 包内调用。
- `servermanage/configure_logging`：`console=False` 时容忍 `sys.stderr is None`。

### 7.3 打包与目录

- Python：`pyinstaller packaging/backend.spec` → `dist/backend/servermonitor-backend/`。
- Electron：`pnpm install` → `pnpm run build` → `release-electron/win-unpacked/`。
- 绿色包组装：
  - `servermonitor.exe`（Electron 主程序）
  - Electron 运行时文件（`resources/` 等）
  - `resources/backend/`（Python sidecar）
  - `config/config.yaml`、`config/.env`（可选）、`data/`、`logs/`
  - `启动.bat`、`停止.bat`、`注册开机自启.ps1`、`使用说明.txt`、`README.md`
- 产物压缩为 `release/服务器轮询监测工具-Windows-x64-v1.3.zip`。

## 8. 安全与数据

- 桌面窗口不绕过登录：仍使用现有 `/setup` + 管理员密码 + CSRF。
- 局域网访问仍走现有鉴权；不因为桌面化放宽访问。
- Electron 安全设置：
  - `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`；
  - 不加载远程页面，只允许本地后端 URL；
  - `will-navigate` 阻止跳到外部站点，`setWindowOpenHandler` 一律 deny；
  - 不新增 preload 暴露 Node API（当前页面不需要）。
- SQLite、DPAPI、配置合并、告警引擎、日志全部沿用，不迁移数据。
- sidecar 只监听现有配置的地址；桌面窗口访问本机/配置地址，不额外开放端口。

## 9. 测试计划

- Python：
  - 全量 520 个现有测试通过；
  - 新增 `--headless` / `--parent-stdin` 生命周期测试（EOF 触发停止、无窗口导入）；
  - `--config` 默认解析测试（临时 appDir）。
- Electron：
  - 单实例：第二次启动触发 `second-instance` 且不创建新窗口；
  - backend 启动失败/超时：显示错误并退出；
  - 窗口关闭：隐藏而不是销毁，托盘 show/exit 回调正确；
  - 路径解析：开发模式与打包 `resources/backend` 模式。
- 打包冒烟：
  - 启动 `servermonitor.exe --headless` 可用 `/setup`、`/api/overview`；
  - 启动 Electron 绿色包，窗口能打开 `/setup`、`/login`、`/api/overview`；
  - 托盘关闭/恢复/退出手工验证一次。
- 验收：原有 520 测试 + 新增 Python 测试全绿；Electron 冒烟与人工托盘验收通过。

## 10. 验收标准

1. 双击 `servermonitor.exe` 直接出现独立窗口，不打开浏览器；
2. 窗口内可完成登录、看板、设置、告警操作；
3. 点 X 后窗口隐藏，托盘图标仍在，监测继续，托盘“显示主窗口”可恢复；
4. 托盘“退出”后进程完全退出，Python 子进程不再残留，端口释放；
5. 局域网另一台电脑仍可通过浏览器访问并密码登录；
6. 首次启动仍进入 `/setup` 设置管理员密码；
7. 原有 520 项测试全部通过，新增桌面生命周期测试通过；
8. 打包目录无控制台黑框，`logs/servermonitor.log` 与 `logs/desktop.log` 正常写入。

## 11. 留给实现者的决定

- Electron 版本锁定具体小版本、是否启用 pnpm 工作区；
- 托盘图标/窗口图标的具体像素和风格；
- backend 日志转发的具体格式（前缀、时间戳、滚动）；
- 打包脚本的目录复制细节和 `electron-builder.yml` 字段；
- 是否用 `tree-kill` 或 `taskkill` 作为 Windows 后端强制清理手段。

## 12. 用户确认记录

- 2026-11-07：用户确认“独立窗口 + 关闭到托盘继续监测”（m04582）；
- 2026-11-07：用户确认保留局域网浏览器访问；
- 2026-11-07：用户选择绿色包分发；
- 2026-11-07：用户选择 Electron + Python sidecar（Tauri 因缺少 Rust/MSVC 构建链不采用）。
