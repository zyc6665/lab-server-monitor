# SSH 配置自动导入与自动更新设计（v1.5）

状态：待用户批准（2026-11-08）
关联计划：`docs/plans/2026-11-08-ssh-config-and-auto-update-implementation.md`

## 1. 目标

把当前桌面客户端从“手工打包、解压、替换”升级为可分发的程序：

1. 自动读取本机 `%USERPROFILE%\.ssh\config`，解析所有可监控主机，用户在客户端里勾选、确认后导入；不读取或回显私钥内容。
2. 把项目发布到 GitHub 公开仓库 `zyc6665/lab-server-monitor`。
3. 客户端启动后自动检查 GitHub Releases 最新版本，发现新版本可一键下载、退出、替换文件并重启，保留现有 `config/`、`data/`、`logs/`。
4. 发布流程：打 tag → GitHub Actions 自动构建 Windows 绿色包与 SHA256 → 上传 Release；以后不再由本机手工打包上传。

## 2. 非目标

- 不做 NSIS 安装程序；继续绿色包形态。
- 不做代码签名；Windows SmartScreen 提示留给用户确认。
- 不做增量更新、灰度发布、自动回滚；更新失败时保留旧文件并记录日志，用户可重新下载完整包。
- 不读取任意路径的 SSH 配置；只读当前 Windows 用户的标准 `~/.ssh/config`。
- 不改变现有主机、告警、磁盘健康、SSH 终端逻辑。

## 3. 已确认决策

- 仓库：新建公开仓库 `zyc6665/lab-server-monitor`，客户端无需内嵌 GitHub Token。
- 发布形态：绿色包 + 应用内自动更新（用户选择）。
- SSH 配置只做“读取 → 勾选确认 → 导入”，不做后台静默添加。
- 更新检查在启动后自动进行；发现新版本显示提示，用户点击“下载并安装”后执行。默认不静默强制更新。
- 更新包下载必须校验 SHA256；校验失败拒绝安装并保留旧版本。

## 4. 现有基础

- `servermanage/host_import.py` 已有 `parse_ssh_config(text, *, home)`，支持 `Host`/`HostName`/`Port`/`User`/`IdentityFile`，会跳过 `Match`、通配符、`Include`，拒绝 `ProxyJump`/`ProxyCommand`。
- `servermanage/settings.py` 已有 `import_hosts(candidates, overwrite)`、`upsert_host`、`test` 等能力。
- `servermanage/web/routes.py` 已有 `POST /api/settings/hosts/import/preview`、`POST /api/settings/hosts/import`，请求体支持 `format: "ssh"` + `content`。
- `desktop/electron/main.js` 已有单实例、托盘、IPC、`desktopBridge`、`servermonitor-backend.exe` sidecar；`desktop/electron/paths.js` 已把数据固定到 `<appDir>/data`。
- `desktop/scripts/build-portable.ps1` 已能构建绿色包，但版本/zip 名目前硬编码 v1.4.1。
- 当前应用版本 1.4.1；本设计目标版本 **1.5.0**。

## 5. SSH 配置自动导入

### 5.1 后端接口

新增（登录 + 只读）：

`GET /api/settings/hosts/ssh-config`

- 固定读取 `Path.home() / ".ssh" / "config"`，不接受调用方传入路径。
- 文件存在：`parse_ssh_config(text, home=Path.home())`，返回：
  ```json
  {
    "source": "C:\\Users\\Administrator\\.ssh\\config",
    "exists": true,
    "candidates": [ {name, host, port, username, auth_type, key_path, tags, disk_mounts, group, owner, location, notes, warnings, valid} ],
    "errors": [],
    "warnings": []
  }
  ```
- 文件不存在：`200`，`{"exists": false, "candidates": [], "warnings": ["未找到 SSH 配置文件：..."]}`，页面提示用户手动使用连接向导。
- 同时返回 `existing_names`（已配置主机名）和每个候选的 `already_configured`，用于页面显示“已存在”标记。
- 不返回私钥内容，只返回路径；`key_path` 不存在时由解析器加入 `warnings`。

**解析与凭据补齐规则（避免真实配置导入失败）**：
- 以字节读取 `~/.ssh/config`，用 `host_import._decode`（UTF-8-sig → GB18030）解码，适配中文 Windows/BOM。
- 支持 `Host *` 默认块：把其中的 `User`/`Port`/`IdentityFile` 作为缺省值应用到具体主机；具体主机显式值优先。
- 支持 `%d`（本地 home）、`%h`（HostName）、`%u`（User）占位符；无法识别的 `%` token 保留原文并加 warning。
- 无 `User` 时按 OpenSSH 语义补当前 Windows 登录用户名。
- 无 `IdentityFile` 时：若 `~/.ssh/id_ed25519` 或 `~/.ssh/id_rsa` 存在，使用该默认私钥并加 warning “未指定 IdentityFile，使用默认私钥 …”；都不存在则 `key_path=None`，候选仍可导入但标记 `needs_credentials=true`。
- SSH 配置导入使用 `import_hosts(..., allow_missing_credentials=True)`：只校验 name/host/port，允许 `auth_type=key` 且 `key_path=None`（保存为“待补凭据”主机）；**不静默写入假凭据**。用户可在主机编辑页补私钥或密码。
- 现有通用批量导入/连接向导保持严格校验，不改变其语义。

新增（登录 + CSRF）：

`POST /api/settings/hosts/ssh-config/import`

请求：
```json
{ "candidates": [{"name":"a100-zyc","host":"202.119.189.245","port":22,"username":"zhouyc","auth_type":"key","key_path":"C:\\\\Users\\\\...\\\\.ssh\\\\id_ed25519", "...": "..."}], "overwrite": false }
```
- 只接受数组；每项必须是合法候选（name/host 必须有）。
- 调用 `SettingsService.import_hosts(candidates, overwrite=...)`；返回 `{ok, created, updated, skipped, failed}`。
- 调用 `_refresh_config(app)`。

### 5.2 前端交互

设置页“主机与 SSH”区增加按钮 **“读取本机 SSH 配置”**，打开对话框：

0. 应用每次启动后自动读取一次本机 SSH 配置（不显示私钥内容）；如果存在未配置候选，在概览页显示“发现 N 个 SSH 主机，点击确认导入”的提示条，点击打开同一对话框。用户也可以随时从设置页按钮手动打开。
1. 请求 `GET /api/settings/hosts/ssh-config`；显示来源路径、警告。
2. 表格列：勾选、别名、地址、端口、用户名、认证方式、私钥路径、状态（已存在/新增/私钥缺失）。
3. 默认勾选：未配置过且可解析的候选；已存在和无效候选默认不勾选，可手动勾选。
4. 支持全选/全不选；“导入选中”调用 `POST /api/settings/hosts/ssh-config/import`；成功后刷新主机列表并回到“主机与 SSH”分区。
5. 缺失私钥只显示警告，不阻止导入；用户可在“编辑主机”补 key 或密码。
6. 不显示私钥内容，不把 `~/.ssh/config` 全文写日志。

## 6. 自动更新

### 6.1 发布源

- 公开仓库：`https://github.com/zyc6665/lab-server-monitor`
- 查询最新稳定版：`GET https://api.github.com/repos/zyc6665/lab-server-monitor/releases/latest`
- Release 资产：
  - `服务器轮询监测工具-Windows-x64-v<version>.zip`
  - 同名 `.sha256`（文件内容为 64 位 hex）
- Release tag 必须为 `v<version>`，例如 `v1.5.0`。

### 6.2 客户端更新流程

新增 `desktop/electron/updater.js`（纯 Node，可单测）：

- `compareVersions(a, b)`：语义化版本比较，支持 `v` 前缀。
- `parseLatestRelease(json, currentVersion)`：读取 `tag_name`、`body`、`assets`；挑选匹配 `Windows-x64-v*.zip` 的 zip 和 `.sha256`；返回 `{available, latestVersion, notes, zipUrl, sha256Url}`。
- `downloadFile(url, destPath, expectedSha256)`：Node 22 内置 `fetch`（自动跟随 GitHub 302 重定向），带 `User-Agent` 与超时；下载后 `crypto.createHash('sha256')` 校验；不匹配删除文件并抛错。
- `prepareUpdate({ zipPath, appDir, exePath, pid })`：在 `<appDir>/data/updates` 生成 `apply-update.ps1` 并 `spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', script, '-AppDir', appDir, ...], {detached:true, windowsHide:true, stdio:'ignore'})`；返回日志路径。**参数用数组传递**，不拼接命令字符串。
- 更新前确认：Electron 收到“下载并安装”后必须调用 `quitApp()`（触发 `before-quit` 停 backend），而不是 `win.close()`（会只隐藏到托盘）。

`apply-update.ps1` 行为（事务式，失败保留可恢复副本）：

1. 等待当前 PID 退出（最多 60 秒）；超时则 `taskkill /PID <pid> /T /F`。
2. 检查并结束仍在运行的 backend：查 `Win32_Process` 中 `ExecutablePath` 位于 `<appDir>` 下的进程并 `Stop-Process -Force`，避免 `servermonitor-backend.exe` 文件锁。
3. 解压 zip 到 `%TEMP%\servermonitor-update-<guid>`；若 zip 根目录是 `servermonitor/`，以其为源；校验 `servermonitor.exe` 与 `resources/backend/servermonitor-backend.exe` 存在。
4. 备份当前 `<appDir>/servermonitor.exe`、`resources/app.asar`、`resources/backend/` 到 `<appDir>/data/updates/backup-<timestamp>/`。
5. 复制前再次确认进程已退出；对每个文件复制做 10 次重试（500ms 间隔），处理杀毒软件瞬时锁；**跳过整个 `config/` 目录**（只允许覆盖 `config/*.example`），并跳过 `data`、`logs`。
6. 全部复制成功后启动 `<appDir>/servermonitor.exe --start-hidden`；若复制任一步失败，用备份还原 `servermonitor.exe`、`app.asar`、`resources/backend/`，写 `data/updates/last-update-failed.json`，不再启动新版本。
7. 删除临时目录；全过程写 `<appDir>/data/updates/apply-update.log`（UTF-8）。脚本文件本身以 **UTF-8 BOM** 保存（PowerShell 5.1 中文/空格路径要求）。

### 6.3 Electron 主进程与 UI

- `desktop/electron/updater.js` 由 `main.js` 调用；仓库地址可用环境变量 `SERVERMONITOR_UPDATE_REPO` 覆盖，默认 `zyc6665/lab-server-monitor`。
- `preload.js` 增加：
  - `getAppVersion()`
  - `checkForUpdates()`
  - `downloadAndInstallUpdate()`
  - `onUpdateEvent(callback)`（主进程通过 `webContents.send('update:event', payload)` 推送进度）
- 设置页新增“应用与更新”卡片（仅 `desktop_mode` 显示）：
  - 当前版本、最新版本、检查状态、Release 说明摘要；
  - “检查更新”按钮；发现新版本时启用“下载并安装”；
  - 下载进度（百分比）；安装前弹确认“更新会退出程序并自动重启，是否继续”。
- 启动后延迟 3 秒自动检查一次；发现更新发送桌面通知/页面提示；用户点击才下载。
- 自动检查结果缓存到 `<appDir>/data/updates/last-check.json`：24 小时内不重复请求（手动“检查更新”可强制刷新）；遇到 GitHub 403/429 静默当作“暂时无法检查”，不影响使用。
- 不使用 `electron-updater`，避免其 Windows 仅支持 NSIS 的限制。

## 7. 发布流水线

### 7.1 仓库与分支

- 新建 public 仓库 `zyc6665/lab-server-monitor`。
- **不要推送现有私有开发历史**：现有仓库包含 `.superpowers/`、`samples/` 等内部过程文件，且旧 `.git/info/exclude` 不会随仓库分发。发布前在干净工作树上创建 orphan 分支并压成单个基线提交（`git checkout --orphan public-main` → 精简 `git add` → commit），再推送为 `main`；保留 `servermonitor-main/servermonitor-main` 这层目录结构（构建脚本依赖它）。
- 新增仓库根 `.gitignore`：`data/`、`logs/`、`.tmp/`、`.env`、`config.yaml`、`*.db`、`*.log`、`release/`、`dist/`、`desktop/build/`、`desktop/node_modules/`、`samples/`、`.superpowers/`、`desktop/release-electron/`。
- 首次推送前执行：`git grep -nE '(password|token|secret|BEGIN .*PRIVATE KEY)'`、`gh secret scan`（或 `run_secret_scanning`）确认无密钥；确认 `config/config.yaml`、`.env`、任何 sqlite/log 未被跟踪。
- 后续开发用 feature 分支 + PR。

### 7.2 版本号单一来源

新增 `tools/bump_version.py <version>`，同步更新：
- `pyproject.toml` 的 `project.version`
- `desktop/package.json` 的 `version`
- `servermanage/__init__.py` 的 `__version__`

`desktop/scripts/build-portable.ps1` 改为从 `pyproject.toml` 读取版本，zip 名动态 `...-v$version.zip`，不再硬编码；同时清理脚本注释、README、`使用说明.txt`、测试里的 `1.4.1` 固定字符串，改为读取版本或使用 `1.5.0`。

### 7.3 GitHub Actions

`.github/workflows/release-windows.yml`：

- 触发：`push` tag `v*`；`workflow_dispatch`（必填输入 `version`，如 `1.5.1`）。
- `workflow_dispatch` 不推送 tag（避免再次触发构建）；用 `softprops/action-gh-release` 的 `tag_name: v${{ inputs.version }}` 创建/更新 Release。
- `windows-latest`：
  1. checkout；setup Python 3.12 / Node 22 / pnpm。
  2. `pip install -e ".[build]"`（在 `servermonitor-main/servermonitor-main`）。
  3. `python tools/bump_version.py <tag去掉v>`（确保构建版本与 tag 一致）。
  4. `packaging/build-backend.ps1`。
  5. `desktop/scripts/build-portable.ps1`。
  6. 生成 zip SHA256 文件。
  7. `softprops/action-gh-release@v2` 上传 `release/*.zip` 和 `release/*.sha256`，`generate_release_notes: true`。
- 首版 v1.5.0 由本地构建 + `gh release create` 发布；Actions 用于后续版本。

## 8. 数据与安全

- SSH 配置只读；绝不上传或记录私钥内容；只把路径保存在本机 SQLite（与现有主机配置一致）。
- 更新检查只访问公开 GitHub API；不上传任何主机信息、遥测。
- 更新包必须 HTTPS + SHA256 校验；校验失败不执行。
- 更新辅助脚本只操作 `<appDir>` 与 `%TEMP%`，不请求管理员权限；不删除 `data`、`logs`、`config/config.yaml`。
- 公开仓库不包含任何密钥、`.env`、`config.yaml`、`data`、`logs`、`.tmp`；推送前用 `git grep` 和 secret scan 检查。

## 9. 测试

- Python：SSH config 接口（存在/不存在/解析候选/已存在标记/导入）；注入临时 `home` 的 `.ssh/config`（不依赖 `Path.home`/HOME 环境变量）；`proxyjump` 警告；`Host *` 默认值；缺失 IdentityFile 使用默认 `id_ed25519`；无凭据候选以 `allow_missing_credentials` 导入成功且标记待补。
- Node：`compareVersions`、`parseLatestRelease`（含 302/资产名匹配）、SHA256 校验、`prepareUpdate` 生成含 UTF-8 BOM/参数转义/备份步骤的脚本内容；不实际启动外部进程。
- Web：设置页按钮/对话框、更新卡片渲染、桌面 mode 隐藏/显示；无 CDN。
- 打包验证：backend 打包启动、`/setup`、`/hosts`、`/disk-health`、`/settings`、SSH 配置读取接口 200。
- 自动更新验收：v1.5.0 安装后发布 v1.5.1，运行 v1.5.0 → 检查到 v1.5.1 → 下载校验 → 退出替换 → 重启后 `/api/runtime` 返回 1.5.1。

## 10. 风险与处理

| 风险 | 处理 |
|---|---|
| 更新时文件被占用导致替换失败 | 等待 PID 退出 60s，超时 taskkill 整棵进程树；结束 appDir 下残留 backend；复制重试 10 次 |
| 更新中途失败导致新旧文件混合 | 先完整解压校验，备份 exe/app.asar/resources/backend，复制失败自动还原并写失败标记；不启动新版本 |
| 更新脚本中文/空格路径乱码 | 脚本 UTF-8 BOM；参数数组传 `-File`，不拼接命令字符串 |
| GitHub 下载 302 或 60 req/h 限流 | 用 fetch 跟随重定向；按 asset browser_download_url；缓存检查 24h；403/429 静默 |
| GitHub API 限流/断网 | 启动检查失败静默，仅“检查更新”按钮显示可重试错误 |
| 无代码签名 SmartScreen 拦截 | 文档说明；后续可加签名证书 |
| 绿色包目录不可写 | 启动时检测并提示“请把程序放在有写权限目录” |
| SSH config 含 `Include`/通配符 | 解析器跳过并展示警告，提示用连接向导补充 |
| 私钥路径在另一台机器不存在 | 导入时警告；DPAPI 绑定本机，换机需重新填写 |
| 更新 zip 带 data/config 覆盖用户数据 | 辅助脚本硬性排除 `data`、`logs`、`config/config.yaml` |

## 11. 验收标准

1. 设置页点击“读取本机 SSH 配置”，能看到本机 16 个候选主机（实际数量随配置变化），勾选后导入成功，主机列表出现。
2. `/api/settings/hosts/ssh-config` 不泄露私钥内容；缺失/ProxyJump 有明确警告。
3. GitHub 公开仓库可访问，v1.5.0 Release 有 zip 和 SHA256。
4. 客户端“应用与更新”显示当前版本 1.5.0；发布 v1.5.1 后可检查到新版本、下载、校验、退出替换、重启显示 1.5.1。
5. 更新后原 `data`（主机配置、SQLite）与 `logs` 保留，登录状态/设置不丢。
6. 全量 Python/Node 测试通过；绿色包冒烟通过。

## 12. 留给实现的决定

- 更新卡片放在设置页“应用与更新”分区；不单独做侧栏页面。
- 更新检查默认开启，首次延迟 3 秒；更新下载需用户点击确认。
- SSH 配置读取不提供任意路径参数；如需其他文件，继续用现有“批量导入”粘贴/上传。
- 首版不实现更新回滚；失败保留旧目录并写日志。
