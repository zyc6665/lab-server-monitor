# 服务器 HTML 日报巡检工具

Windows 桌面客户端版的服务器巡检工具：对多台 Linux 服务器做每日巡检，采集资源指标并生成 HTML 日报邮件。绿色包解压即用，**不依赖 Docker，也不需要单独安装 Python**。

## 版本与更新记录

- **更新历史**：完整版本记录已独立到 [CHANGELOG.md](CHANGELOG.md)（含 v0.1.7–v0.1.239 与桌面端 v1.2–v1.6）。
- **版本号规则**：程序包版本以 `pyproject.toml` / `desktop/package.json` / `servermanage/__init__.py` 三处为准，由 `tools/bump_version.py` 同步；桌面客户端对外发布版本对应 GitHub Release 标签 `v*`。
- **当前版本**：程序包 `0.1.239`，最新对外发布标签 `v0.1.239`（详见 [docs/VERSIONING.md](docs/VERSIONING.md)）。

| 渠道 | 版本标识来源 | 当前值 |
| --- | --- | --- |
| 程序包（pyproject / package.json / `__version__`） | 仓库内三处同步文件 | `0.1.239` |
| 本地绿色包产物 | `release/服务器轮询监测工具-Windows-x64-v*.zip` | `v0.1.239` |
| 对外发布（GitHub Releases） | `release-windows.yml` 打的 `v*` 标签 | `v0.1.239` |

> 版本线自 v0.1.237 起已归一（决策 A：留在 `0.1.x` 线）：历史桌面端 `v1.x` Release 已在 GitHub 标记为 **prerelease**，
> `desktop/electron/updater-core.js` 只认非 prerelease/draft、且与当前 major 一致的 Release，不再出现「已是最新却提示更新」的循环。详见 [docs/VERSIONING.md](docs/VERSIONING.md)。

## 它做什么

- 通过 SSH 连接多台 Linux 服务器
- 采集 CPU、内存、磁盘、在线用户、进程、NVIDIA GPU 信息
- 每天定时把一封 HTML 巡检日报发送到指定收件人
- Electron 桌面窗口 + 内置调度器 + 本地 Web 看板；关闭窗口后驻留系统托盘，后台继续监测
- 凭据（SSH 密码/私钥、邮箱密码、Webhook）用当前 Windows 账户的 DPAPI 加密后保存在本地数据库，界面不回显明文

## 你需要提前准备什么

- 一台 Windows 11 电脑（运行绿色包）
- 一个可发邮件的 SMTP 邮箱账号，以及对应的 SMTP 授权码
- 至少一台能通过 SSH 登录的 Linux 服务器
- 如果用私钥登录，再准备一个私钥文件

## 快速开始（Windows 绿色包）

### 1. 解压并保持目录完整

解压 `release/服务器轮询监测工具-Windows-x64-v<版本号>.zip` 后，目录结构如下：

```text
服务器轮询监测工具/
├── servermonitor.exe                            # Electron 主程序（入口）
├── resources\backend\servermonitor-backend.exe  # Python 后台 sidecar
├── config\
│   ├── config.yaml.example                      # 首次运行据此生成 config.yaml
│   ├── config.yaml                              # 首次运行自动生成
│   └── .env                                     # 可选
├── data\                                        # servermonitor.db、runtime.json、electron\
├── logs\                                        # servermonitor.log、desktop.log
├── 启动.bat
├── 停止.bat
├── 注册开机自启.ps1
└── 使用说明.txt
```

> 解压后请保持目录完整，不要把 `servermonitor.exe` 单独移动；`resources`、`config`、`data`、`logs` 必须与它位于同一目录。

### 2. 启动 / 停止 / 开机自启

- **启动**：双击 `启动.bat`（或直接双击 `servermonitor.exe`），显示独立主窗口；首次启动自动进入 `/setup` 初始化管理员密码。关闭窗口 = 最小化到系统托盘，后台继续监测；托盘菜单提供 显示主窗口 / 打开日志目录 / 复制看板地址 / 退出。
- **停止**：优先用托盘「退出」（会先优雅停止后台服务）；也可双击 `停止.bat` 强制结束 `servermonitor.exe` 与 `servermonitor-backend.exe`。
- **开机自启**：右键 `注册开机自启.ps1` →「使用 PowerShell 运行」。脚本创建计划任务 `ServerMonitorDashboard`（登录时触发），直接执行 `servermonitor.exe --start-hidden`，只在托盘运行、不弹窗口；可重复运行（先删除同名任务），权限不足时回退到「启动」文件夹快捷方式。

### 3. 首次使用：设置管理员并添加主机

1. 首次启动自动跳转 `/setup`，设置管理员密码后登录。
2. 进入「设置」页，在「主机」里添加要巡检的服务器：填写名称、地址、SSH 用户名，以及密码或私钥（凭据用 DPAPI 加密保存在本地，界面不回显原文）。
3. 在「通知 / 报告」里填写 SMTP 账号与收件人，设定每日发送时间。
4. 回到「概览」即可看到各主机状态；到点后自动发送 HTML 日报邮件。

### 4. 网页在线设置

启动后进入「设置」页即可修改主机与 SSH、监控与存储、通知、报告、磁盘健康、看板与安全等，全部在浏览器里完成，无需手工编辑配置文件；敏感值（SSH 密码/私钥、邮箱密码、Webhook 地址）用当前 Windows 账户的 DPAPI 加密保存在 `data\servermonitor.db`，界面永不回显原文。

## 构建绿色包（开发者，可选）

在装有 Node.js / pnpm 与 Python 3.11+ 的 Windows 上，于项目根目录执行：

```powershell
pwsh desktop/scripts/build-portable.ps1
```

脚本会构建 Python 后端 sidecar、执行 `pnpm install` 与 `pnpm run build`（electron-builder），把产物组装到 `desktop/build/portable/servermonitor/`，并压缩为 `release/服务器轮询监测工具-Windows-x64-v<版本号>.zip`。

## 高级：用配置文件初始化（可选）

软件默认在「设置」页完成全部配置；如需批量部署，也可以先用配置文件做种子：

1. 复制 `config/config.yaml.example` 为 `config/config.yaml`；
2. （可选）复制 `config/.env.example` 为 `config/.env`，填写 SMTP/SSH 密码等敏感值；
3. 首次启动后这些值会被读入，之后仍可在「设置」页修改并保存到 SQLite。

`config.yaml` 中形如 `*_env` 的字段填的是“环境变量名”，真实密码放 `config/.env`，不要把明文写进 `config.yaml`；`config/.env` 是可选的。

## 常见报错怎么处理

### 1. SMTP 认证失败

常见原因：`smtp.host` / `smtp.port` 写错、账号写错、密码填的是网页登录密码而不是 **SMTP 授权码**。

处理：在「设置 → 通知」核对 SMTP 地址、端口（多数 465 用 SSL）与授权码；保存后重试发送测试邮件。

### 2. SSH 登录失败

常见原因：服务器地址或用户名写错、22 端口不通、密码/私钥不对、防火墙拦截。

处理：先在电脑上用 `ssh 用户名@地址` 手动验证能登录，再回「设置 → 主机」核对字段。

### 3. 私钥不存在 / 无法读取

日志出现类似 `SSH key path does not exist: <路径>` 时，说明设置里填的私钥路径在该 Windows 电脑上不存在。请改成真实路径（例如 `C:\Users\你\.ssh\id_rsa`），并确认文件可读；私钥带口令时同时填入口令。

### 4. 收不到邮件

先检查：收件人是否写对、垃圾邮件箱、SMTP 是否报错（看 `logs\servermonitor.log`）、发送时间是否已到。

### 5. 打不开看板 / 端口被占用

用托盘菜单「复制看板地址」获取当前看板地址；若该端口被其它程序占用，关闭占用程序后重新启动客户端即可。

## 最后提醒

- 需要长期保留的是 `config\`、`data\`、`logs\` 三个目录；升级版本时先备份这三处。
- 换电脑后，已用 DPAPI 加密的敏感值无法解密，需要在「设置」页重新填写。
