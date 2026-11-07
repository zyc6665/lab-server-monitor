# Server Monitor Desktop Shell Implementation Plan

> **For the implementer:** implement task-by-task, test-first. Every task ends with its own commit. Do not skip the failing-test step.

**Goal:** Ship a Windows x64 portable desktop application for the existing server polling monitor. Electron owns the window, tray and lifecycle; the existing Python service runs as a PyInstaller `--headless` sidecar. The browser dashboard and LAN access remain unchanged.

**Architecture:** `servermonitor.exe` (Electron main process) → `BrowserWindow` loading `http://127.0.0.1:<port>` → `servermonitor-backend.exe` (Python/waitress/scheduler/SQLite) as a child process with piped stdio. Closing the window hides it; the tray restores it; tray exit gracefully stops the backend (stdin EOF, then `taskkill` fallback).

**Tech Stack:** Electron 45.2.3, electron-builder 26.18.0, CommonJS main process, Node built-in `node:test`, Python 3.11+/PyInstaller 6.x, existing Flask/waitress/Jinja2 stack.

**Spec:** `servermonitor-main/servermonitor-main/docs/plans/2026-11-07-desktop-shell-design.md` (approved 2026-11-07).

## Global Constraints

- Windows x64 only for this delivery. No installer; output is a zip of a portable directory.
- Reuse the existing web UI and all `/api/*`, `/setup`, `/login` routes unchanged.
- Electron must use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`; no remote pages; `will-navigate` blocked; `setWindowOpenHandler` denies.
- The Python backend must never start pystray or open a browser when `--headless` / `SERVERMONITOR_DESKTOP=1`.
- The desktop window may bind/access only `127.0.0.1`; `dashboard.host` must be one of `0.0.0.0`, `::`, `127.0.0.1`, or empty. A specific non-loopback address is a startup error.
- All existing tests (520+) must continue to pass. Add new tests for every new Python/Electron behavior.
- No data migration: keep existing `config/`, `data/`, `logs/` on upgrade. Never ship `data/servermonitor.db` to another person.
- `PYTHONIOENCODING=utf-8` must be set for the sidecar.
- Never log secrets or full webhook URLs.

## Review Focus

1. **Orphan prevention** — every exit path must terminate the backend (stdin EOF → graceful wait → taskkill fallback); no `servermonitor-backend.exe` left running, no port held.
2. **Single-instance scope** — `app.setPath('userData', <appDir>/data/electron)` must happen before `requestSingleInstanceLock`; two extracted copies in different folders must be independent.
3. **Correct URL/port** — window must load the actual port from `data/runtime.json`, never a stale configured port; runtime.json is written before the window loads.
4. **No duplicate UI ownership** — in desktop mode the backend must not create a tray or open a browser; settings page hides those two toggles.
5. **Upgrade safety** — packaging/assembly must preserve existing `config/`, `data/`, `logs/`; `.env` remains optional.
6. **Security** — narrow preload only (no Node APIs), all navigation/window-open blocked, backend only on loopback/local configured interface.

---

### Task 1: Python headless mode, parent-stdin lifecycle, logging safety

**Files:**
- Modify `servermanage/app.py`
- Test `tests/test_app_cli.py`

**Step 1 — Write failing tests**
1. `test_build_parser_accepts_headless_and_parent_stdin` — parse `["--headless","--parent-stdin"]`, assert `args.headless is True`, `args.parent_stdin is True`, `args.config is None`.
2. `test_default_config_path_uses_repo_config_in_dev` — normal (non-frozen) call resolves `servermonitor-main/servermonitor-main/config/config.yaml` (may not exist; assert path suffix).
3. `test_default_config_path_uses_executable_tree_when_frozen` — monkeypatch `sys.frozen=True`, `sys.executable` to `<tmp>/resources/backend/servermonitor-backend.exe`, assert candidate list prefers `<tmp>/config/config.yaml` when it exists.
4. `test_watch_parent_stdin_calls_on_eof` — `watch_parent_stdin(on_eof, stream=io.BytesIO(b""))` calls callback exactly once and returns.
5. `test_configure_logging_tolerates_missing_stderr` — monkeypatch `sys.stderr=None`, call with tmp log dir; no exception, log file created.
6. `test_headless_skips_browser_and_tray` — call main with injected fakes or monkeypatch `open_browser`, `start_tray`; assert neither called and `server.run` is reached.

Run `python -m pytest tests/test_app_cli.py -q`; confirm all fail.

**Step 2 — Implement**
- `build_parser()`: `--config` default `None`; add `--headless`, `--parent-stdin`, `--start-hidden` (accepted, ignored by Python).
- Add `default_config_path() -> Path`: if frozen, candidates `[Path(sys.executable).parent/"config/config.yaml", parents[2]/"config/config.yaml", Path.cwd()/"config/config.yaml"]`, first existing else first; non-frozen: `Path(__file__).resolve().parents[1]/"config/config.yaml"`.
- Add `watch_parent_stdin(on_eof, stream=None)`: read one byte at a time; on EOF log and call `on_eof()` once; daemon thread-friendly.
- `main()`: resolve config via `args.config or default_config_path()`; `headless = args.headless or os.environ.get("SERVERMONITOR_DESKTOP") == "1"`; when headless, validate `config.dashboard.host in {"", "0.0.0.0", "::", "::0", "127.0.0.1"}` else log error and return 2; skip `open_browser_on_start` and `start_tray`; after `server` is built start `threading.Thread(target=watch_parent_stdin, args=(server.close,), daemon=True)` if `args.parent_stdin`.
- `configure_logging()`: only add `StreamHandler` if `sys.stderr is not None`.

**Step 3 — Verify**
`python -m pytest tests/test_app_cli.py tests/test_app_service.py -q`; then full `python -m pytest -q`.

**Step 4 — Commit**
`feat: add headless desktop lifecycle options to service entrypoint`

---

### Task 2: Electron project skeleton and path resolution

**Files:**
- Create `desktop/package.json`
- Create `desktop/electron/paths.js`
- Create `desktop/electron-builder.yml`
- Create `desktop/build/icon.ico` (64×64+ ICO; may generate with Pillow)
- Test `desktop/test/paths.test.js`

**Step 1 — Write failing tests**
- `resolveAppDir({isPackaged:false, appRoot})` returns `appRoot`.
- `resolveAppDir({isPackaged:true, execPath:"C:/app/servermonitor.exe"})` returns `C:/app`.
- `backendPath` packaged → `<appDir>/resources/backend/servermonitor-backend.exe`; dev → `<repo>/dist/backend/servermonitor-backend/servermonitor-backend.exe`.
- `configPath` → `<appDir>/config/config.yaml`; `dotenvPath` → `<appDir>/config/.env`; `dataDir` → `<appDir>/data`; `logsDir` → `<appDir>/logs`; `electronUserData` → `<appDir>/data/electron`.
Run `cd desktop && node --test test/paths.test.js`; fail.

**Step 2 — Implement**
- `package.json`: `"name":"server-monitor-desktop"`, `"version":"1.3.0"`, `"main":"electron/main.js"`, `"private":true`, scripts `start`, `build`, `test` (`node --test test/`), devDependencies `"electron":"45.2.3"`, `"electron-builder":"^26.18.0"`, packageManager pnpm.
- `paths.js` exports the five pure functions above; use `path`.
- `electron-builder.yml`: `appId: com.lab.servermonitor`, `productName: 服务器轮询监测工具`, `directories.output: release-electron`, `files: ["electron/**", "build/icon.ico", "package.json"]`, `extraResources: [{from:"../dist/backend/servermonitor-backend", to:"backend"}]`, `win: {target: dir, icon: build/icon.ico}`.
- Create an `.ico` file (48/64/128 px).

**Step 3 — Verify** `cd desktop && node --test test/paths.test.js`; pass.

**Step 4 — Commit** `feat: scaffold electron desktop project`

---

### Task 3: Backend process controller

**Files:**
- Create `desktop/electron/backend.js`
- Test `desktop/test/backend.test.js`

**Step 1 — Write failing tests**
- Spawn args include `--headless --parent-stdin --config <appDir>/config/config.yaml`; `--dotenv` only when file exists; `cwd=appDir`; env has `PYTHONIOENCODING=utf-8` and `SERVERMONITOR_DESKTOP=1`.
- stdout/stderr chunks are appended to `<logs>/desktop.log` with timestamp/prefix.
- `waitForRuntime()` polls `data/runtime.json` and resolves `{url,port}`; times out after configured milliseconds and rejects with a clear error.
- `stop()` closes stdin; if child exits within timeout, resolves; otherwise calls `taskkill /pid <pid> /t /f`.
- Unexpected exit invokes `onUnexpectedExit(code/signal)` once.
Use fake `spawn`/`fs`/clock injection; no real process in tests.

**Step 2 — Implement**
- `createBackendController({appDir, spawnImpl=child_process.spawn, fsImpl=fs, logger, startupTimeoutMs=30000, pollIntervalMs=250, stopTimeoutMs=3000})` with `start()`, `waitForRuntime()`, `stop()`, `restart()`, `isRunning()`.
- On spawn error reject; on exit set state and notify callback.
- Never leave listeners duplicated on restart.

**Step 3 — Verify** `cd desktop && node --test test/backend.test.js`.

**Step 4 — Commit** `feat: add electron backend process controller`

---

### Task 4: Electron main window, tray, single-instance, preload bridge

**Files:**
- Create `desktop/electron/main.js`
- Create `desktop/electron/preload.js`
- Test `desktop/test/main-helpers.test.js`

**Step 1 — Write failing tests**
- `trayMenuTemplate` has 显示主窗口 / 复制看板地址 / 打开日志目录 / 退出 in order.
- `shouldHideOnClose({trayAvailable:true})` → true; false → false.
- `validateDashboardHost("0.0.0.0")`, `""`, `"127.0.0.1"`, `"::"` pass; `"10.0.0.5"` throws a Chinese error.
- `preload` source contains only `contextBridge.exposeInMainWorld` with `restartBackend`, `copyDashboardUrl`, `isDesktop`; no `require("child_process")`/`fs`/`ipcRenderer.send` broad exposure.

**Step 2 — Implement**
- Before `app.whenReady`: compute appDir via paths; `app.setPath('userData', electronUserData)`. Then `requestSingleInstanceLock()`; if not acquired, quit; on `second-instance`, show/focus existing window.
- Create BrowserWindow 1280×800, min 1024×700, title 服务器轮询监测工具, `webPreferences: {preload, contextIsolation:true, nodeIntegration:false, sandbox:true}`.
- Set `win.on('close')`: if tray available and not `quitting`, `preventDefault(); win.hide()`; else quit.
- Tray with icon: 显示主窗口 / 复制看板地址 (`clipboard.writeText`) / 打开日志目录 (`shell.openPath`) / 退出.
- `will-navigate` prevent non-backend URL; `setWindowOpenHandler` deny.
- Start backend, wait runtime, loadURL; on failure `dialog.showErrorBox` + append log + quit. `--start-hidden` keeps window hidden.
- `before-quit` cleanup once: set `quitting=true`, `await backend.stop()`.
- preload: `contextBridge.exposeInMainWorld("desktopBridge", {isDesktop:true, restartBackend:()=>ipcRenderer.invoke("desktop:restart-backend"), copyDashboardUrl:()=>ipcRenderer.invoke("desktop:copy-url")})`.
- IPC handler restart: stop backend, start again, wait runtime, `win.loadURL(newUrl)`, return `{ok:true,url}`.

**Step 3 — Verify** `cd desktop && node --test test/main-helpers.test.js`.

**Step 4 — Commit** `feat: add electron window tray and lifecycle`

---

### Task 5: Desktop-mode settings API and restart UX

**Files:**
- Modify `servermanage/settings.py`
- Modify `servermanage/web/templates/settings.html`
- Modify `servermanage/web/static/settings.js`
- Test `tests/test_settings_service.py`, `tests/test_settings_page.py`

**Step 1 — Write failing tests**
- `public_settings()["desktop_mode"] is True` when `SERVERMONITOR_DESKTOP=1`, false otherwise.
- Served `settings.html` does not contain `data-field="tray_enabled"` or `data-field="open_browser_on_start"` when desktop_mode true.
- Served `settings.js` contains `desktopBridge` and calls `restartBackend` when `result.restart_required`.

**Step 2 — Implement**
- `SettingsService.public_settings()` add top-level `"desktop_mode": os.environ.get("SERVERMONITOR_DESKTOP") == "1"`.
- settings.html wrap the two `<label class="check-row">` in `{% if not settings.desktop_mode %}`.
- `saveSection`: if `result.restart_required` and `window.desktopBridge`, status "正在重启后台…", call `await window.desktopBridge.restartBackend()`; then show "已重启" or error. Do not call in browser mode.

**Step 3 — Verify** targeted tests + full pytest.

**Step 4 — Commit** `feat: hide desktop-owned toggles and restart backend from settings`

---

### Task 6: PyInstaller backend build

**Files:**
- Create `packaging/backend.spec`
- Create `packaging/build-backend.ps1`
- Modify `packaging/build.ps1` (optional helper)
- Test `tests/test_backend_spec.py`

**Step 1 — Write failing tests**
- spec file contains `name='servermonitor-backend'`, `console=False`, `servermanage/__main__.py`, `datas` includes `servermanage/templates`, `servermanage/web/templates`, `servermanage/web/static`, hiddenimports `servermanage.settings`, `servermanage.security`, `servermanage.disk_capacity`.
- build script references `pyinstaller` on `packaging/backend.spec`.

**Step 2 — Implement**
- backend.spec: Analysis entry `servermanage/__main__.py`, pathex repo root, datas collect template/static directories, hiddenimports waitress/jinja2.ext/servermanage.settings/security/disk_capacity/winotify, excludes heavy unused libs, `console=False`, `COLLECT` onedir name `servermonitor-backend`.
- `build-backend.ps1`: `python -m PyInstaller --noconfirm --clean packaging/backend.spec`; assert `dist/backend/servermonitor-backend/servermonitor-backend.exe` exists.

**Step 3 — Verify** `python -m pytest tests/test_backend_spec.py -q`; run `powershell -File packaging/build-backend.ps1`; `dist/backend/servermonitor-backend/servermonitor-backend.exe --help` exits 0.

**Step 4 — Commit** `build: package python backend as headless sidecar`

---

### Task 7: Desktop build and portable assembly scripts

**Files:**
- Create `desktop/scripts/build-portable.ps1`
- Create `desktop/scripts/verify-package.ps1`
- Test `desktop/test/scripts.test.js` (static assertions)

**Step 1 — Write failing tests**
- `build-portable.ps1` contains `pnpm install`, `pnpm run build`, checks backend exe, copies `release-electron/win-unpacked` to staging, copies `resources/backend`, `config/config.yaml.example`, creates `data`, `logs`, copies launchers/README, compresses to `release/服务器轮询监测工具-Windows-x64-v1.3.zip`.
- It must not delete existing `config/`, `data/`, `logs/` when staging an upgrade (assert copy-over behavior / explicit guard).

**Step 2 — Implement**
- Use `$ErrorActionPreference='Stop'`, resolve repo root by walking up from script.
- Build backend first if missing; fail with clear message if backend exe missing after build.
- Stage under `desktop/build/portable/servermonitor/` (clean only staging, never source config/data).
- Copy `config/config.yaml.example` as `config/config.yaml` only if no existing config; preserve existing.
- Compress with `Compress-Archive` UTF-8; verify zip entry `servermonitor/servermonitor.exe`.

**Step 3 — Verify** `cd desktop && node --test test/scripts.test.js`; run `powershell -File scripts/build-portable.ps1` (can be done after Task 6 build).

**Step 4 — Commit** `build: assemble portable desktop release`

---

### Task 8: Launchers, autostart, firewall helper, docs, version 1.3.0

**Files:**
- Modify `启动.bat`, `停止.bat`, `注册开机自启.ps1`, `使用说明.txt`, `README.md`
- Create `允许局域网访问.ps1`
- Modify `pyproject.toml` (version 1.3.0)
- Test `tests/test_launchers.py` / `desktop/test/scripts.test.js`

**Step 1 — Write failing tests**
- `启动.bat` starts `servermonitor.exe` without `--start-hidden`.
- `注册开机自启.ps1` action executes `servermonitor.exe` with argument `--start-hidden` (not `启动.bat`).
- `停止.bat` kills both `servermonitor.exe` and `servermonitor-backend.exe`.
- `允许局域网访问.ps1` creates a rule named `服务器轮询监测工具` for `resources/backend/servermonitor-backend.exe`.
- `pyproject.toml` version `1.3.0`.

**Step 2 — Implement** as above; docs explain first-run `/setup`, tray behavior, LAN firewall step, upgrade preserving config/data/logs.

**Step 3 — Verify** targeted tests + full pytest.

**Step 4 — Commit** `docs: add desktop launchers firewall helper and 1.3.0 metadata`

---

### Task 9: End-to-end desktop smoke, full regression, release verification

**Files:**
- Create/modify `tests/test_desktop_integration.py`
- Create/modify `desktop/test/integration.test.js`
- Final artifact `release/服务器轮询监测工具-Windows-x64-v1.3.zip`

**Step 1 — Write failing tests**
- Python: `default_config_path` + headless main startup with temp app tree and patched waitress/subprocess yields `/setup` 200 and `/api/overview` 428/200 contract.
- Python: parent-stdin EOF triggers server close within test timeout.
- Node: backend controller starts a fake child, runtime file appears, stop sends stdin close; if fake child ignores close, taskkill invoked.
- Static: zip contains `servermonitor/servermonitor.exe`, `servermonitor/resources/backend/servermonitor-backend.exe`, `config/config.yaml`, `启动.bat`.

**Step 2 — Implement integration fixes** only if failures reveal real gaps; do not write production code before the failing test.

**Step 3 — Run full verification**
- `cd servermonitor-main/servermonitor-main && python -m pytest -q` → 0 failures (520+ tests).
- `cd desktop && node --test test/` → all pass.
- `powershell -File packaging/build-backend.ps1` → backend exe built.
- `powershell -File desktop/scripts/build-portable.ps1` → zip built.
- Smoke: run `servermonitor.exe` from staged folder, verify `/setup` page, set admin password, login, `/api/overview` returns 4 hosts; close window → tray icon remains; tray show; tray exit → verify `servermonitor-backend.exe` gone via `tasklist`.
- Wait for one status cycle and confirm `/api/host/<name>` disk `status=ok` for all four hosts (requires sudoers already configured).

**Step 4 — Commit** `test: verify desktop packaging end to end` and tag/report final artifact path.

---

## Self-Review

- **Coverage:** §3.1 items 1–9 map to Task 1 (CLI/logging/port validation), Task 3 (backend lifecycle), Task 4 (single instance/tray/window), Task 5 (desktop_mode/restart), Task 7 (portable/userData/assembly), Task 8 (autostart/firewall/upgrade/version).
- **Interfaces:** `--headless`, `--parent-stdin`, `--config` optional, `SERVERMONITOR_DESKTOP=1`, `desktop_mode` key, `desktopBridge.restartBackend`, `servermonitor-backend.exe`, `resources/backend/`.
- **Risk hot spots:** stdin EOF on Windows console=False (verified by builder-check), taskkill fallback, runtime.json before window load, preserving existing config/data on upgrade.
- **Non-goals:** no installer, no auto-update, no Windows service, no multi-window, no Electron frontend framework.

## Execution

Subagent-driven: task briefs per task, fresh implementer, task reviewer, fix loops. Final whole-branch review and real package verification before delivery.
