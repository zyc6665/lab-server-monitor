# P6 Electron 集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** 把已迁移的 Node 后端接入 Electron 桌面壳：utilityProcess 生命周期、单实例、托盘、动态端口、数据目录解析（HKCU 指针、默认非 C 盘）、首启旧数据/旧配置导入、开机自启、`electron-updater` 自动更新、NSIS 安装包；删除旧 custom updater 与 `apply-update.ps1`。

**Architecture:** Electron main（`desktop/src/main/*`，esbuild → `desktop/dist/main.cjs`）只负责窗口/托盘/生命周期/更新；后端仍是 `backend/dist/main.cjs`，由 `utilityProcess.fork` 以 `--port 0 --runtime <dataDir>/runtime.json --data-dir <dataDir>` 启动，main 轮询 runtime.json 握手后加载 `http://127.0.0.1:<port>`。

**Tech Stack:** Electron 45.2.3、electron-builder ^26（NSIS + GitHub publish）、electron-updater、TypeScript、vitest、node:test。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md`（§5.1–5.3、§6.8、§7.6–7.7、§11–13）

## Global Constraints

- 数据兼容：时间戳 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`；JSON UTF-8；布尔 0/1。
- 密钥：DPAPI 当前用户、无 entropy、UI_FORBIDDEN（`win-dpapi`），不得用 safeStorage 读旧 blob。
- 数据目录与安装目录解耦；指针存 `HKCU\Software\ServerMonitor\DataDir`（备选 `{安装目录}\instance.json`）。
- 默认数据目录：第一个非系统固定盘 `<盘>:\ServerMonitorData`；无则 `%LOCALAPPDATA%\ServerMonitor`；网络/可移动盘强警告。
- schema 迁移前必须备份 `backups/pre-migrate-<version>-<ts>.db` + 事务回滚中止启动。
- 旧 `config.yaml`/`.env` 一次性导入 DB，DB 权威（导入后写 marker）。
- 不允许任何 `.bat`/`.ps1` 作为运行入口；无 Python 运行时。
- 迁移期 Python pytest 1892 passed / 1 skipped 必须仍绿；`servermanage/` 零改动。
- 版本线：0.1.239（`__APP_VERSION__` 构建期注入）。

## Review Focus

1. 数据目录指针缺失/损坏/指向不可写盘时，启动是否安全回退并提示，而不是崩溃或静默写 C 盘。
2. 端口握手竞态：后端迟迟不写 runtime.json 或进程提前退出时，main 是否在 ≤30s 内给出明确错误并按 [2000,5000,10000,20000,30000]ms 退避重启。
3. 退出流程：关闭窗口→隐藏到托盘；真正退出（托盘退出/系统关机）是否先优雅关闭后端再强杀，避免 SQLite 半写。
4. 首启导入：旧 `data/servermonitor.db` 探测与复制是否原子、失败可回滚、不覆盖已有新库。
5. 自动更新：electron-updater 是否仅同 major、排除 prerelease、校验 sha512；失败不破坏当前安装。

---

### Task 1: 数据目录解析（HKCU 指针 + 默认非 C 盘）

**Files:**
- Modify: `desktop/src/main/paths.ts`
- Test: `desktop/test-unit/paths.test.ts`

**Interfaces:**
- Produces: `resolveInstallDir(env): string`、`defaultDataDir(env): string`、`resolveDataDir(opts): string`、`readDataDirPointer(): string|null`、`writeDataDirPointer(p): void`、`logsDir(dataDir): string`、`instanceJsonPath(installDir): string`、`isUsableDataDir(p, fsApi): boolean`、`pickDataDir({pointer, installDir, env, fsApi}): {dataDir, source, warning?}`。

- [ ] Step 1: 写失败测试（默认盘选择、指针优先、指针失效回退、无 D 盘回退 LOCALAPPDATA、网络盘告警、instance.json 备选）
- [ ] Step 2: 运行确认失败
- [ ] Step 3: 实现（`existsDrive`/盘符探测注入 fs；HKCU 通过注入的 `registry` 接口，默认用 `child_process` 调 `reg query/add`，测试注入 fake）
- [ ] Step 4: 测试通过
- [ ] Step 5: commit `feat(p6): data directory resolution with HKCU pointer`

### Task 2: 后端 CLI（--data-dir/--config/--import-legacy）+ 首启导入

**Files:**
- Modify: `backend/src/server.ts`、`backend/src/config/paths.ts`
- Create: `backend/src/runtime/first-run.ts`
- Test: `backend/test/runtime/first-run.test.ts`、`backend/test/server-cli.test.ts`

**Interfaces:**
- Produces: `resolveRuntimePaths(argv, env): {dataDir, dbPath, configSeedPath?, runtimePath?}`；`firstRunImport({dataDir, db, legacyDbCandidates, configSeedPath?, env?}): Promise<{imported:boolean, legacyCopied:boolean, configImported:boolean, messages:string[]}>`（原子复制 + marker `app_settings['first_run_imported']`）；`migrateWithBackup(dbPath, db)`（迁移前备份到 `backups/pre-migrate-*`，失败回滚并抛）。
- Consumes: P1 `migrateLegacy`/`backupBeforeMigration`、`initSchema`、settings service。

- [ ] Step 1: 失败测试（无旧库不导入；旧库存在→复制+迁移+marker；config.yaml 导入一次后再导入被忽略；备份失败→中止不迁移）
- [ ] Step 2: 运行确认失败
- [ ] Step 3: 实现 + 接线 `server.ts`（`--data-dir`、`--config`、`--import-legacy`；启动前 firstRunImport + migrateWithBackup）
- [ ] Step 4: 测试通过 + typecheck
- [ ] Step 5: commit `feat(p6): backend data-dir CLI and first-run legacy/config import`

### Task 3: electron-updater 集成

**Files:**
- Create: `desktop/src/main/updater.ts`、`desktop/src/main/update-policy.ts`
- Modify: `desktop/electron/preload.js`（暴露 `desktopBridge.update`）
- Test: `desktop/test-unit/update-policy.test.ts`

**Interfaces:**
- Produces: `isSameMajor(current, candidate): boolean`、`pickUpdateAsset(release): {url, sha512} | null`、`createUpdater({autoUpdater, currentVersion, ipcMain, log}): {check, download, install, dispose}`；IPC 通道 `update:check|download|install`，返回 `{status, version?, error?}`。
- Consumes: `electron-updater`（GitHub provider，NSIS）。

- [ ] Step 1: 失败测试（同 major 过滤、prerelease 排除、资产缺失、错误不抛崩）
- [ ] Step 2: 运行确认失败
- [ ] Step 3: 实现 + preload 暴露
- [ ] Step 4: 测试通过 + typecheck
- [ ] Step 5: commit `feat(p6): electron-updater integration and IPC`

### Task 4: main.ts 装配（托盘/单实例/退避/自启/退出）

**Files:**
- Modify: `desktop/src/main/main.ts`
- Test: `desktop/test-unit/main-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task1 paths、Task2 backend CLI、Task3 updater。
- Produces: main 启动流程使用 `pickDataDir`；`--data-dir` 覆盖；`app.setLoginItemSettings({openAtLogin, args:['--start-hidden']})`；托盘菜单含「开机自启」勾选项；退出前 `backendProc.kill()` 优雅等待 ≤7s 再强杀；`window-all-closed` 重建托盘不退出。

- [ ] Step 1: 失败测试（生命周期纯函数：退避序列、启动参数拼装、退出顺序）
- [ ] Step 2: 运行确认失败
- [ ] Step 3: 实现
- [ ] Step 4: desktop typecheck + vitest + node --test 全绿
- [ ] Step 5: commit `feat(p6): electron main lifecycle, tray and autostart`

### Task 5: NSIS 安装包 + 发布配置（含 latest.yml）

**Files:**
- Modify: `desktop/electron-builder.yml`、`desktop/package.json`、`.github/workflows/release-windows.yml`
- Test: 构建产物检查 + CI YAML 解析

**Interfaces:**
- Produces: electron-builder `publish: {provider: github, owner: zyc6665, repo: lab-server-monitor}`、`nsis: {oneClick:false, allowToChangeInstallationDirectory:true, perMachine:false, deleteAppDataOnUninstall:false}`、`extraResources: backend/dist/main.cjs → backend/main.cjs`；产物含 `latest.yml`。

- [ ] Step 1: 修改配置 + CI（上传 Setup.exe/latest.yml/blockmap）
- [ ] Step 2: 本地构建 `pnpm --filter desktop build` 产出 Setup + latest.yml
- [ ] Step 3: 校验 latest.yml 与 exe/sha512 一致
- [ ] Step 4: commit `chore(p6): NSIS packaging and GitHub publish config`

### Task 6: 删除旧 custom updater / apply-update.ps1，验收

**Files:**
- Delete: `desktop/electron/updater-core.js`、`desktop/electron/updater.js`、`desktop/scripts/apply-update.ps1`（确认无引用）
- Create: `docs/superpowers/plans/p6-acceptance.md`

- [ ] Step 1: `grep -rn "updater-core\|apply-update" desktop/` 确认无引用后删除
- [ ] Step 2: 全量门禁（backend typecheck+vitest、desktop typecheck+vitest+node --test、Python pytest）
- [ ] Step 3: 打包安装/启动/卸载冒烟（自定义非 C 目录）
- [ ] Step 4: 写 p6-acceptance.md
- [ ] Step 5: commit `chore(p6): remove legacy updater scripts and P6 acceptance`
