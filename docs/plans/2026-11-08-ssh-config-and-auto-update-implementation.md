# SSH 配置自动导入与自动更新实施计划（v1.5）

Goal: 实现 SSH 配置自动读取/勾选导入，GitHub 公开发布与客户端自动更新，版本 1.5.0。
Architecture: 现有 Flask + SQLite + Electron/PyInstaller 绿色包；新增 SSH 配置只读接口、批量导入模式、Electron 更新器（GitHub Releases + SHA256 + 事务式 PowerShell 替换）。
Tech Stack: Python 3.12 / Flask / pytest；Electron 45.2.3 / Node 22；PowerShell 5.1；GitHub Actions。
Spec: `servermonitor-main/servermonitor-main/docs/plans/2026-11-08-ssh-config-and-auto-update-design.md`

## Global Constraints

- 保持 Windows 绿色包；不引入安装程序、代码签名、增量更新或回滚框架。
- 所有新代码必须兼容现有 Python/Node 测试；不得降低当前 639 Python / 49 Node 基线。
- 所有秘密只存本机（DPAPI / SQLite），绝不写日志或返回前端明文。
- 更新包必须 HTTPS 下载并校验 SHA256；失败必须保留可用旧版本或可恢复备份。
- 路径/中文/空格必须使用参数数组和 UTF-8 BOM 处理，不允许拼接 shell 字符串。
- 发布仓库固定 `zyc6665/lab-server-monitor`（public）；不得把 `data/`、`logs/`、`config/config.yaml`、`.env`、`*.db`、`*.log`、`.tmp/`、`.superpowers/`、`samples/` 推送到公开仓库。
- 版本单一来源：`pyproject.toml`、`desktop/package.json`、`servermanage/__init__.py` 必须一致。

## Review Focus

1. SSH config 解析是否覆盖真实 16 个 Host：缺 User、缺 IdentityFile、Host * 默认、BOM/GBK、ProxyJump 警告。
2. `allow_missing_credentials` 是否只作用于 SSH 配置导入，不改变现有通用导入/连接向导的严格校验。
3. 更新脚本是否真正等待进程退出、结束 appDir 下 backend、处理文件锁、备份/还原、保留 data/logs/config。
4. GitHub API 是否跟随 302、使用 `browser_download_url`、匹配资产名而非 glob、校验 64 hex SHA256。
5. 版本 bump 是否在 electron-builder 之前生效；workflow_dispatch 是否不重复触发 tag 构建。
6. 公开仓库是否无秘密、无内部过程文件、构建路径仍为嵌套 `servermonitor-main/servermonitor-main`。

---

## Task 1: SSH 配置解析默认值与宽松导入

Files:
- Modify `servermonitor-main/servermonitor-main/servermanage/host_import.py`
- Modify `servermonitor-main/servermonitor-main/servermanage/settings.py`
- Add `servermonitor-main/servermonitor-main/tests/test_ssh_config_import.py`

Steps:
1. 在 `host_import.py` 增加 `apply_import_defaults(result: ParseResult, text: str, *, home: Path, default_username: str | None = None) -> ParseResult`：
   - 解析 `Host *` 默认块（`User`/`Port`/`IdentityFile`），也支持配置文件顶部全局键值（如存在）。
   - 对每个 `HostCandidate`：`username` 为空时依次使用 `Host * User`、`default_username`；`port` 为空/0 时用 `Host * Port` 或 22；`key_path` 为空时检查 `home/.ssh/id_ed25519`、`home/.ssh/id_rsa`，存在则填入并追加 warning `未指定 IdentityFile，使用默认私钥: ...`，都不存在则保持 None 并追加 `未指定 IdentityFile，导入后需补私钥或密码`。
   - 展开 `%d`→`str(home)`、`%h`→HostName、`%u`→username；未知 `%` token 保留并警告。
   - 重新计算 `HostCandidate.valid`（name/host/port 合法即可；凭据缺失不置 invalid）。
   - `default_username` 建议由调用方传 `getpass.getuser()`；解析器自身不依赖 `Path.home()`。
2. 在 `settings.py` 的 `SettingsService.import_hosts` 增加 keyword-only `allow_missing_credentials: bool = False`：
   - `_validate_import_candidate(candidate, allow_missing_credentials=...)`：当 `True` 时，不要求 key_path/密码，只校验 name/host/port；当 `False` 保持原行为。
   - `_apply_host_secrets` 对 `allow_missing_credentials=True` 且无凭据的候选跳过写入，不抛错；已有凭据仍写。
   - `upsert_host` 的公开路径保持严格（不新增宽容默认）。
3. 测试（至少 10 个）：
   - `Host *` 的 User/Port/IdentityFile 默认应用；具体 Host 显式覆盖；
   - 缺 User 使用 `default_username`；
   - 缺 IdentityFile 且存在 `id_ed25519` 时自动填入 + warning；
   - 缺 IdentityFile 且无默认 key 时 `key_path is None`、valid=True、warning；
   - `%d/%h/%u` 展开；未知 token 警告；
   - `allow_missing_credentials=True` 导入 key_path=None 成功，且不写秘密；默认 `False` 仍拒绝；
   - 现有 `tests/test_host_import.py`、`tests/test_settings_service.py` 全绿。
4. 运行：`python -m pytest tests/test_host_import.py tests/test_settings_service.py tests/test_ssh_config_import.py -q`；全量 `python -m pytest -q`。

Commit: `feat: allow ssh config import with default and missing credentials`

## Task 2: SSH 配置只读与导入 API

Files:
- Modify `servermonitor-main/servermonitor-main/servermanage/web/routes.py`
- Add `servermonitor-main/servermonitor-main/tests/test_ssh_config_api.py`

Steps:
1. 新增 `read_ssh_config(home: Path | None = None) -> dict` helper（模块级，便于测试）：
   - `home = home or Path.home()`；路径固定 `<home>/.ssh/config`。
   - 不存在：返回 `{source,exists:False,candidates:[],errors:[],warnings:["未找到 SSH 配置文件: ..."]}`。
   - 存在：按字节读，`servermanage.host_import._decode` 解码；`parse_ssh_config` → `apply_import_defaults(..., default_username=getpass.getuser())`；算 `existing_names` 与每候选 `already_configured`。
   - 不返回私钥内容，只返回 `key_path`。
2. `GET /api/settings/hosts/ssh-config`：需登录；调用 helper；200 JSON。
3. `POST /api/settings/hosts/ssh-config/import`：
   - 需登录 + CSRF + `_ensure_writable`。
   - 校验 `candidates` 为 list，每项 name/host 必填；调用 `service.import_hosts(candidates, overwrite=..., allow_missing_credentials=True)`。
   - `_refresh_config(app)`；返回 `{ok, created, updated, skipped, failed}`。
4. 测试：
   - 临时 home 下构造 UTF-8 与 GB18030 配置；断言 16 个候选、缺失 key 警告、Host * 默认；
   - 未登录 401；CSRF 缺失 400；GET 不返回私钥 file 内容；
   - POST 导入无凭据候选成功；重复候选 skipped；全量回归。
5. 运行 focused + full。

Commit: `feat: add ssh config read and import apis`

## Task 3: SSH 配置前端自动读取与确认导入

Files:
- Modify `servermanage/web/templates/overview.html`
- Modify `servermanage/web/templates/settings.html`
- Add `servermanage/web/static/ssh-config-dialog.js`
- Modify `servermanage/web/static/settings.js`
- Modify `servermanage/web/static/style.css`
- Add `tests/test_ssh_config_ui.py`

Steps:
1. 设置页“主机与 SSH”区新增按钮 `#ssh-config-open-button` “读取本机 SSH 配置”；新增 `#ssh-config-dialog`（复用 settings-dialog 样式），表格列：勾选/别名/地址/端口/用户/认证/私钥/状态；底部“全选/全不选/取消/导入选中”；状态文本区。
2. 新增 `ssh-config-dialog.js`：
   - `openSshConfigDialog()`：GET `/api/settings/hosts/ssh-config`，渲染行；默认勾选 `!already_configured && valid`，已存在/无凭据仍可手动勾选；`needs_credentials` 显示“需补凭据”标签。
   - `importSelected()`：POST `/api/settings/hosts/ssh-config/import`，携带所选候选（保留 name/host/port/username/auth_type/key_path/tags/disk_mounts/group/owner/location/notes），CSRF；成功后关闭并 `window.location.reload()`（立即刷新）。
   - 所有文本用 `textContent`；错误显示在对话框内。
3. 应用启动自动检测：在 `overview.html` 加隐藏提示条 `#ssh-config-banner`，`app.js` 页面 load 后调用 GET ssh-config；若未配置候选 >0 显示“发现 N 个 SSH 主机，点击确认导入”，点击打开同一对话框。仅当登录后可见（页面本身已鉴权）；用户忽略后不反复弹出。
4. 测试：`tests/test_ssh_config_ui.py` 断言 settings/overview 有按钮/对话框/banner、脚本引用、不含 `innerHTML` 拼接敏感值。

Commit: `feat: add ssh config import dialog and startup banner`

## Task 4: Electron 更新器核心模块

Files:
- Add `desktop/electron/updater-core.js`
- Add `desktop/test/updater-core.test.js`

Steps:
1. 导出纯函数：
   - `compareVersions(a,b): -1|0|1`，去除 `v` 前缀，按数字段比较，支持 `1.5.0`、`1.5.0-beta.1`（预发布低于正式）。
   - `selectReleaseAssets(releaseJson)`：`tag_name` 必须 `v<semver>`；资产名以 `服务器轮询监测工具-Windows-x64-v` 开头且 `.zip` 结尾；对应 `.sha256` 资产；返回 `{version,notes,zipUrl,sha256Url,zipName}`，无匹配返回 null；使用 `browser_download_url`，不拼 URL。
   - `isUpdateAvailable(current, latest)`。
   - `verifySha256(filePath, expectedHex)`（Node crypto）。
   - `readChecksumText(text)`：trim，必须 `/^[0-9a-fA-F]{64}$/`，否则 null。
   - `buildApplyScript({appDir, exePath, zipPath, pid})`：返回含 UTF-8 BOM 的 PowerShell 脚本字符串；脚本必须包含：等待 PID、结束 appDir 下 backend、解压到 `%TEMP%`、校验文件、备份 `servermonitor.exe/resources/app.asar/resources/backend`、复制跳过 `data/logs/config`（仅允许 `config/*.example`）、10 次重试、失败还原、启动 `--start-hidden`、写日志。
2. 测试：版本比较 8 组、资产选择（含中文名/多个资产/缺失 sha/非法 tag）、校验和校验、脚本包含关键步骤与 BOM、路径含空格/中文时仍为参数化 `-AppDir`。
3. 运行 `cd desktop && node --test test/updater-core.test.js`。

Commit: `feat: add electron updater core`

## Task 5: Electron 更新器集成（IPC / 主进程）

Files:
- Add `desktop/electron/updater.js`
- Modify `desktop/electron/main.js`
- Modify `desktop/electron/preload.js`
- Add `desktop/test/updater.test.js`

Steps:
1. `updater.js`：
   - `createUpdater({app, appDir, currentVersion, repo, fetchImpl, fsImpl, pathImpl, spawnImpl, logger, clock})`。
   - `check({force=false})`：24h 缓存 `data/updates/last-check.json`；GET `https://api.github.com/repos/<repo>/releases/latest`，`User-Agent: servermonitor-updater`，15s 超时；403/429 返回 `{ok:false,reason:'rate_limited'}` 不抛；无新版本返回 `{ok:true,available:false}`。
   - `downloadAndInstall()`：下载 zip 到 `data/updates/<zipName>`，校验 sha256；写 `apply-update.ps1`（UTF-8 BOM），`spawn('powershell.exe', [...], {detached:true, windowsHide:true, stdio:'ignore'})`；返回 `{ok:true,logPath}`。
   - 下载进度通过回调 `onProgress(percent)`。
2. `main.js`：
   - `const { createUpdater } = require('./updater')`；初始化 updater，repo 默认 `zyc6665/lab-server-monitor`，可用 `process.env.SERVERMONITOR_UPDATE_REPO` 覆盖。
   - IPC：`update:check`、`update:install`、`update:get-version`。
   - `update:install` 返回成功后 500ms 调用 `quitApp()`（确保真正退出，不是 hide）。
   - 启动后 `setTimeout(() => updater.check({force:false}).then(send event), 3000)`。
3. `preload.js` 增加 `getAppVersion`、`checkForUpdates`、`downloadAndInstallUpdate`、`onUpdateEvent(cb)`。
4. 测试：fake fetch 200/302/403/无资产，缓存命中不重复请求，安装调用 spawn 参数数组，版本来自 `app.getVersion()`。

Commit: `feat: wire electron auto updater`

## Task 6: 应用与更新设置卡片

Files:
- Modify `servermanage/web/templates/settings.html`
- Add `servermanage/web/static/update-card.js`
- Modify `servermanage/web/static/settings-tabs.js`
- Modify `servermanage/web/static/style.css`
- Add `tests/test_update_ui.py`

Steps:
1. 设置页增加“应用与更新”分区（仅在 `desktop_mode` 显示，使用 `{% if settings.desktop_mode %}`）：
   - 当前版本、最新版本、检查状态、Release 摘要、检查更新按钮、下载并安装按钮、进度条、错误/重试提示。
2. `update-card.js`：
   - `loadUpdateState()` 调 `desktopBridge.getAppVersion()` 和 `onUpdateEvent`；
   - “检查更新” `checkForUpdates()`；
   - “下载并安装”先 `confirm("更新会退出程序并自动重启，是否继续？")`，再 `downloadAndInstallUpdate()`，显示进度；
   - 非 desktop 环境不加载/不显示。
3. `settings-tabs.js` 的 labels 加入 `update`。
4. 测试：模板包含 update card/按钮；JS 有 confirm/desktopBridge 检查；无 CDN。

Commit: `feat: add update card to settings`

## Task 7: 版本工具、动态 zip 名与 GitHub Actions

Files:
- Add `servermonitor-main/servermonitor-main/tools/bump_version.py`
- Modify `servermonitor-main/servermonitor-main/desktop/scripts/build-portable.ps1`
- Modify `servermonitor-main/servermonitor-main/desktop/test/scripts.test.js`
- Add `.github/workflows/release-windows.yml` at repo root
- Modify `README.md`、`使用说明.txt`、version tests
- Add `tests/test_release_workflow.py`

Steps:
1. `tools/bump_version.py <version>`：
   - 校验 semver；
   - 用正则替换 `pyproject.toml` `^version = "..."`（仅 [project] 区）；
   - `desktop/package.json` JSON parse/set `version`；
   - `servermanage/__init__.py` `__version__ = "..."`；
   - 打印 changed files；重复运行幂等。
2. `build-portable.ps1`：读取 `pyproject.toml` 的 `version`（正则），`$version` 用于 zip 名 `服务器轮询监测工具-Windows-x64-v$version.zip`，更新注释；`desktop/test/scripts.test.js` 断言含 `$version` 动态模板且不含 `v1.4.1` 字面量。
3. 工作流 `.github/workflows/release-windows.yml`：
   - `on: push.tags: ['v*']` + `workflow_dispatch.inputs.version required`；
   - `permissions: contents: write`；
   - Node 22 + corepack enable + Python 3.12；
   - `working-directory: servermonitor-main/servermonitor-main`；
   - `pip install -e ".[build]"`；`python tools/bump_version.py <version>`；
   - `powershell -NoProfile -File packaging/build-backend.ps1`；
   - `powershell -NoProfile -File desktop/scripts/build-portable.ps1`；
   - 生成 `release/*.zip.sha256`（PowerShell `Get-FileHash`）；
   - `softprops/action-gh-release@v2` 上传 `release/*.zip` + `release/*.sha256`，`tag_name: v<version>`，`generate_release_notes:true`；不 push tag。
4. `tests/test_release_workflow.py` 断言工作流字段、工作目录、上传资产、tag_name、无 `git push --tags`；断言 bump 后三个版本一致。
5. 把三个版本更新到 1.5.0；README/使用说明加“自动更新/SSH 配置读取”章节。

Commit: `chore: add release automation and bump to 1.5.0`

## Task 8: 公共仓库整理与 v1.5.0 首次发布

Files (repo-level only):
- Add root `.gitignore`
- Add `servermonitor-main/servermonitor-main/release/README.md` (ignored? no, release dir ignored; instead put release notes in docs)
- No code changes.

Steps (controller/ops):
1. 在干净工作树创建 orphan `public-main`；仅 add tracked source/config examples/docs/desktop; exclude data/logs/tmp/superpowers/samples.
2. `git status --short` 确认无 `*.db`/log/含密钥文件；运行 `git grep` secret patterns 和 `run_secret_scanning`（若可用）。
3. `gh repo create zyc6665/lab-server-monitor --public --source=. --remote=origin --push`（若已存在则配置 remote + push）。
4. 本地构建 v1.5.0：`python tools/bump_version.py 1.5.0` → `build-backend.ps1` → `build-portable.ps1`；`verify-package.ps1` 通过；生成 SHA256。
5. `gh release create v1.5.0 release/...zip release/...zip.sha256 --title "v1.5.0" --notes ...` 发布。
6. 验证 `gh release view v1.5.0` 资产 URL 可访问。

## Task 9: 端到端自动更新验收（v1.5.0 → v1.5.1）

Steps:
1. 构建/发布 v1.5.1（仅 bump 版本，代码相同）到 GitHub Release；保留 v1.5.0 包。
2. 解压 v1.5.0 到临时目录，启动 `servermonitor.exe --start-hidden`；确认 `/api/runtime` 返回 1.5.0。
3. 通过设置页“应用与更新”检查到 1.5.1，下载并安装；确认退出、替换、重启后 `/api/runtime` / package version 为 1.5.1。
4. 检查保留：原 `data/servermonitor.db` 主机配置、`config/config.yaml` 自定义内容、`logs/` 不丢。
5. 再次启动检查无更新。
6. 全量 Python/Node 测试；记录发布 URL、SHA256、验证截图/日志。

## Final Verification

- `python -m pytest -q`（0 failed）
- `cd desktop && node --test`（0 failed）
- `packaging/build-backend.ps1` exit 0
- `desktop/scripts/build-portable.ps1` exit 0；`verify-package.ps1` 通过
- `release/服务器轮询监测工具-Windows-x64-v1.5.0.zip` 与 `.sha256` 存在
- GitHub `v1.5.0` release 资产可下载
- v1.5.0 → v1.5.1 自动更新实测通过

## Self-Review Notes

- SSH import flow uses an explicit `allow_missing_credentials` boundary; default import stays strict.
- Actual 16-host config includes 7 hosts without IdentityFile; default key detection avoids rejecting them while still surfacing warnings.
- Update script is transactional: full extraction + verification + backup + retry + restore. It never overwrites `data`, `logs`, or `config/` user files.
- Release repo is cleaned/squashed; no old `.superpowers`/`samples`/DB/log history is published.
