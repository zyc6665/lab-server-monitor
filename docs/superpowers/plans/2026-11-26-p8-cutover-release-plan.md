# P8 收尾发布（去 Python 切割 + 单栈安装版交付）· 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 Python 实现与绿色便携发行线，仓库只剩 Electron + Node/TS 单一技术栈；CI 只跑 Node 门禁；release 产出 NSIS `Setup.exe` + `latest.yml` + `.blockmap` 并发布 GitHub Release；安装器收尾；文档改为安装版。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md` §5.3 / §6.8 / §13；路线图 `2026-11-25-single-stack-rewrite-plan.md` P8 行；遗留项 `p6-acceptance.md`「遗留（P8 处理）」、`p7-acceptance.md`。

**分支:** `refactor/single-stack-b1`。每个 Task 一次 commit；Task 0 不 commit。

## Global Constraints

- 删除前必须先「冻结」：任何依赖 Python 的 Node 测试先改为对照入库 golden，确认绿后再删 Python。
- **运行时资源先搬家再删**：`backend/src` 在运行时读取 `servermanage/web/templates`（15）、`servermanage/web/static`（32）、`servermanage/templates`（报表模板）——直接删 `servermanage/` 会让产品白屏（见现状证据）。
- 不删除任何用户业务数据（`data/`、`backup_20261123/`、`release/`）除非用户确认；这些目录本就被 `.gitignore` 忽略、未入库。
- 迁移期 Python 基线（1892 passed / 1 skipped）在 Task 2 冻结之后不再作为门禁。

## 现状证据（2026-11-26 采集）

- `git ls-files | grep -iE '\.py$|\.bat$|\.ps1$' | wc -l` = **342**；非 `servermanage/`、`tests/` 的条目：
  - `backend/test/diff/http/{build_fixture,dump_python,write_flow_python}.py`、`backend/test/diff/parsers/run_parsers_oracle.py`、`backend/test/diff/run_python_oracle.py`、`backend/test/diff/scheduler-alerts/run_schedule_oracle.py`、`backend/test/diff/seed/build_seed.py`
  - `backend/test/disk/{run_disk_parse_oracle,run_disk_report_oracle,run_evaluate_oracle}.py`、`backend/test/report/{run_report_context_oracle,run_report_render_oracle}.py`
  - `desktop/scripts/{apply-update,build-portable,verify-package}.ps1`、`packaging/{build-backend,build}.ps1`、`packaging/verify-bundle.py`、`tools/bump_version.py`
  - 根目录 `启动.bat`、`停止.bat`、`注册开机自启.ps1`、`使用说明.txt`（均已入库）
- 调用 Python 的 Node 测试（`grep -lE 'spawnSync\(|execFileSync\(|spawn\(' backend/test | xargs grep -lE 'python|PYTHON|\.py'`）：
  `backend/test/users/scan.test.ts`、`backend/test/report/{context,render}.test.ts`、`backend/test/disk/{evaluate,parse,report}.test.ts`、`backend/test/diff/harness.ts`、`backend/test/diff/scheduler-alerts/scheduler-alerts-diff.test.ts`、`backend/test/diff/parsers/parsers-diff.test.ts`、`backend/test/diff/http/{full-read-diff,http-diff,write-flow-diff}.test.ts`、`backend/test/collect/commands.test.ts`；另 `backend/test/diff/seed/seed.test.ts`（依赖 `build_seed.py` 产物）。
- 运行时依赖 `servermanage/` 资源：`backend/src/web/app.ts:85`（static）、`backend/src/web/templating.ts:42`（templates）、`backend/src/report/render.ts:300-307`（报表模板）。其余 `servermanage` 命中均为注释（`users/scan.ts`、`report/model.ts` 等）。
- 旧 portable 线：`desktop/electron/{main,main-helpers,backend,maintenance,paths,preload,updater,updater-core}.js` + 测试 `desktop/test/*.test.js`；现行入口为 `desktop/src/main/main.ts`（`desktop/scripts/build-main.mjs:17`），`desktop/src` 未 require `../electron`。
- CI：`ci.yml` 有 `backend`（Python pytest/pip-audit/ruff/bump_version）、`backend-node`、`desktop` 三 job；`release-windows.yml` 的 `test` 与 `build-and-release` 仍 setup-python、跑 pytest 与 `tools/bump_version.py`。
- `desktop/electron-builder.yml` 已是 NSIS（`oneClick:false`、`perMachine:false`、`allowToChangeInstallationDirectory:true`、`deleteAppDataOnUninstall:false`、`artifactName: ServerMonitor-${version}-Setup.${ext}`、publish github `zyc6665/lab-server-monitor`）；无 `nsis.include`，`extraResources` 未含模板/static。
- `.gitignore` 已忽略 `data/*`、`backup_*/`、`release/`、`logs/`；`config/` 仅入库 `config.yaml.example`、`.env.example`。

---

## Task 0: 基线快照（不改代码，不 commit）

- [ ] Step 1: `pnpm --filter servermonitor-backend typecheck && pnpm --filter servermonitor-backend test`，记录 passed/skipped（`PYTHON` 可用，oracle 用例跑通）。
- [ ] Step 2: `cd desktop && pnpm test && pnpm typecheck && pnpm test:unit`，记录数字。
- [ ] Step 3: `python -m pytest -q`，确认 1892 passed / 1 skipped（最后一次）。
- [ ] Step 4: 确认 oracle 用例未被 skip；若有 skip 先修环境，否则冻结 golden 会缺项。

**门禁:** 三组全绿；数字写入 Task 9 草稿。

## Task 1: 差分/oracle 测试去 Python 化（冻结 golden）

**Files:**
- Create: `backend/test/golden/freeze-python-oracles.mjs`（一次性，跑完删除）
- Create（入库 JSON 快照）：
  - `backend/test/diff/http/golden/{read,full-read,write-flow}.json`（`dump_python.py`、`write_flow_python.py`、`build_fixture.py`）
  - `backend/test/diff/seed/golden/seed.sqlite` + `seed.sha256`（`build_seed.py` 产物）
  - `backend/test/diff/parsers/golden/*.json`（`run_parsers_oracle.py` × 3 fixtures）
  - `backend/test/diff/scheduler-alerts/golden/schedule.json`（`run_schedule_oracle.py`）
  - `backend/test/diff/golden/python-oracle.json`（`run_python_oracle.py`，`harness.ts` 用）
  - `backend/test/disk/golden/{parse,report,evaluate}.json`、`backend/test/report/golden/{context,render}.json`
  - `backend/test/users/golden/scan.json`、`backend/test/collect/golden/commands.json`
- Modify: 上述 13 个 TS 测试 + `backend/test/diff/{harness,fixture}.ts`、`backend/test/diff/seed/seed.test.ts`：去掉 `spawnSync/execFileSync(python…)`、`PYTHONPATH`、`findPython()`、`it.skip` 回退；改为读 golden `toEqual`（§9.1 归一化）。
- Modify: `backend/test/diff/http/README.md`（golden 来源 commit、不可再生成）
- Delete: 全部 `backend/test/**/*.py`（12 个）与 `__pycache__/`

- [ ] Step 1: 冻结脚本按清单调用各 oracle（同测试入参与 env：`PYTHONIOENCODING=utf-8`、`PYTHONWARNINGS=ignore`），排序键输出 `JSON.stringify(v,null,2)+'\n'`，附 `_source`/`_commit` 元信息。
- [ ] Step 2: 跑两次冻结脚本，`git diff --exit-code` 证明确定性。
- [ ] Step 3: 改测试为对照 golden；临时故意改坏一个 Node 实现字段，确认对应测试变红后恢复。
- [ ] Step 4: 删除 `.py` 与冻结脚本；`grep -rnE "python|PYTHON|\.py['\"]|spawnSync\(|execFileSync\(" backend/test --include=*.ts` 只剩字符串样本（如 `'python train.py'`）。
- [ ] Step 5: PATH 去掉 python 后 `pnpm --filter servermonitor-backend test`：passed ≥ Task 0、skipped 不增加。

**门禁:** 无 Python 环境 backend 全绿、0 新增 skip。
**Commit:** `test(p8): freeze python oracles into golden fixtures and drop python from node tests`

## Task 2: 运行时资源迁出 `servermanage/`

**Files:**
- Move（`git mv`）：`servermanage/web/templates/**` → `backend/assets/web/templates/**`；`servermanage/web/static/**` → `backend/assets/web/static/**`；`servermanage/templates/**` → `backend/assets/report-templates/**`
- Modify: `backend/src/web/app.ts:85`、`backend/src/web/templating.ts:42`、`backend/src/report/render.ts:300-307`（默认根改 `backend/assets/...`；打包后 `process.resourcesPath/backend/assets/...`）
- Modify: `desktop/electron-builder.yml`（`extraResources` 增 `from: ../backend/assets, to: backend/assets`）；核对 `backend/build.mjs` 产物相对路径
- Modify: 引用旧路径的测试（`grep -rn 'servermanage/web\|servermanage/templates' backend/test`）

- [ ] Step 1: 失败测试 `backend/test/assets.test.ts`：默认 templates/static/report 根存在且不含 `servermanage`。
- [ ] Step 2: `git mv` + 改常量。
- [ ] Step 3: backend test/build；`pnpm --filter desktop build` 后 `win-unpacked/resources/backend/assets` 存在；启动后 `/login` 200、CSS 200、生成一份报表。

**门禁:** backend 全绿；打包产物页面可渲染。
**Commit:** `refactor(p8): move templates/static/report assets into backend/assets`

## Task 3: 删除 Python 实现与旧打包

**Files（Delete）:** `servermanage/`、`tests/`、`pyproject.toml`、`packaging/`（`build.ps1`、`build-backend.ps1`、`verify-bundle.py`、`*.spec`）；`tools/bump_version.py` 留到 Task 5 与 Node 替代同 commit 删除。

- [ ] Step 1: 删除前证据（须为空或仅注释）：
  - `grep -rnE 'servermanage' backend/src backend/build.mjs desktop/src desktop/scripts desktop/electron-builder.yml | grep -vE '^\S+:[0-9]+:\s*(//|/?\*)'`
  - `grep -rnE 'pyproject|packaging/|verify-bundle' .github backend desktop package.json --exclude-dir=node_modules`
  - `grep -rnE 'tests/' .github package.json backend/package.json desktop/package.json`
- [ ] Step 2: `git rm -r servermanage tests pyproject.toml packaging`。
- [ ] Step 3: `.gitignore` 删 Python 段（`__pycache__/`、`*.py[cod]`、`.pytest_cache/`、`.coverage*`、`htmlcov/`、`*.egg-info/`、`.venv/` 等）。

**门禁:** backend typecheck+test+build 绿；desktop build 绿。
**Commit:** `chore(p8)!: remove python implementation, tests and pyinstaller packaging`

## Task 4: 删除旧 portable 线与根目录脚本

**Files:**
- Delete: `desktop/electron/`（8 个 JS）——前提 Step 1 证据为空；`preload` 若需复用先移植到 `desktop/src/preload/`。
- Delete: `desktop/scripts/{apply-update,build-portable,verify-package}.ps1`
- 测试：`desktop/test/scripts.test.js`（ps1 静态契约）删除；`desktop/test/{updater,updater-core}.test.js` 删除；`desktop/test/{backend,integration,paths,crash-guard,main-helpers,main-window,maintenance,recovery}.test.js` 逐个判定——只测 `../electron/*` 的删除，行为若需保留确认 `desktop/test-unit/*` 已覆盖否则迁移为 vitest。
- Delete 根目录：`启动.bat`、`停止.bat`、`注册开机自启.ps1`
- Modify: `.gitignore` 删 `desktop/build/portable/`、`.tmp-upd/`

- [ ] Step 1: 证据：`grep -rnE "electron/|\.\./electron|apply-update|build-portable|verify-package|updater-core" desktop/src desktop/scripts/*.mjs desktop/scripts/*.js desktop/package.json desktop/electron-builder.yml .github` 为空（`build-main.mjs:3` 注释除外）；`grep -rnE '启动\.bat|停止\.bat|注册开机自启' --exclude-dir=node_modules .` 仅命中文档。
- [ ] Step 2: `grep -n require desktop/test/*.js` 列 require 目标，按上表处置并写入 commit 描述。
- [ ] Step 3: 若 `desktop/test` 清空，`desktop/package.json` 的 `test` 脚本改指剩余测试或移除，CI 同步。
- [ ] Step 4: desktop `pnpm test && pnpm typecheck && pnpm test:unit && pnpm build:main`。

**门禁:** desktop 全绿；用例数下降仅来自逐项列明的旧线测试。
**Commit:** `chore(p8)!: remove portable updater, ps1 scripts and root launchers`

## Task 5: CI 单栈化

**Files:** `.github/workflows/ci.yml`、`.github/workflows/release-windows.yml`；Create `scripts/bump-version.mjs` + 测试；Delete `tools/bump_version.py`（`tools/` 空则删）

- [ ] Step 1: TDD `bump-version.mjs`：`--check` 不一致退出 1；`<ver>` 写入根/backend/desktop `package.json` 与 `backend/src/version.ts`。
- [ ] Step 2: `ci.yml` 删除 Python `backend` job；保留 `backend-node`、`desktop`；加 `node scripts/bump-version.mjs --check`。
- [ ] Step 3: `release-windows.yml`：移除全部 setup-python/pytest/`bump_version.py`；`test` job 跑 Node 门禁；`build-and-release` 用 Node 版本脚本；保持 `electron-builder --win --publish never`；Verify 断言 `ServerMonitor-*-Setup.exe`、`latest.yml`、`*.exe.blockmap` 存在且 `latest.yml` 的 `sha512` 与 exe 一致；上传三件到 GitHub Release（非 prerelease tag → `prerelease:false`）。
- [ ] Step 4: `actionlint` 校验；`grep -nE 'python|pytest|pip|\.py' .github/workflows/*.yml` 为空。
- [ ] Step 5: 推分支后 `workflow_dispatch` 以 `0.1.240-rc.1`（prerelease）验证。

**门禁:** CI 绿；release dry-run 三件齐且哈希一致。
**Commit:** `ci(p8): node-only gates; release publishes NSIS setup + latest.yml + blockmap`

## Task 6: 安装器收尾

**Files:** Create `desktop/build/installer.nsh`；Modify `desktop/electron-builder.yml`（`nsis.include`）、`desktop/src/main/main.ts`；测试 `desktop/test-unit/*.test.ts`

- [ ] Step 1: `customUnInstall`：读 HKCU 数据目录指针；`MessageBox MB_YESNO|MB_DEFBUTTON2` 询问是否删除数据目录（默认否）；`/S` 一律保留；选是才 `RMDir /r`；删除 HKCU 指针与自启项。
- [ ] Step 2: 残留空目录：末尾对 `$INSTDIR` 及子目录非递归 `RMDir`；卸载前检测进程运行并提示先退出托盘。
- [ ] Step 3: 开机自启 `app.setLoginItemSettings({openAtLogin,args:['--start-hidden']})`，设置页/托盘开关；`--start-hidden` 不弹窗；单测注入 `app`。
- [ ] Step 4: 单托盘：第二实例只 focus；多次 `window-all-closed` 后 Tray 构造计数 = 1（单测）。
- [ ] Step 5: 默认安装目录 `D:\Tools\ServerMonitor`（无 D 回退 `%LOCALAPPDATA%\Programs\ServerMonitor`），向导可改。

**门禁:** desktop 全绿；手工卸载三分支（否/是/`/S`）符合预期，`$INSTDIR` 无残留。
**Commit:** `feat(p8): nsis uninstall data prompt, empty-dir cleanup, login item and single tray`

## Task 7: 文档单栈化

**Files:** `README.md`、`使用说明.txt`（见 Q5）、`CHANGELOG.md`、`config/*.example`（见 Q4）

- [ ] Step 1: README：下载 Setup.exe → 选安装/数据目录 → 首启 `/setup` → 自动更新 → 卸载（数据默认保留）；存量绿色包用户首启自动导入旧 `data/servermonitor.db`（§7.7）；开发命令 `pnpm install`/`pnpm test`/`pnpm --filter desktop build`；删除全部 `.bat`/`.ps1`/Python/PyInstaller 段落。
- [ ] Step 2: CHANGELOG 新条目：破坏性变更（移除 Python、绿色 zip、`.bat`/`.ps1`、自研 updater）、NSIS + electron-updater、Node 门禁数字。
- [ ] Step 3: `grep -rnE 'python|pytest|\.bat|\.ps1|绿色|portable|PyInstaller' README.md 使用说明.txt` 仅剩迁移说明。

**Commit:** `docs(p8): single-stack installer README, usage and changelog`

## Task 8: 打包 + 安装/升级/卸载实机验收

- [ ] Step 1: `pnpm --filter desktop build` → Setup.exe、`latest.yml`、blockmap。
- [ ] Step 2: 交互安装到 `E:\Apps\ServerMonitor`、数据 `E:\SMData`；快捷方式、登录页、单托盘；静默 `Setup.exe /S /D=E:\Apps\SM2` 成功。
- [ ] Step 3: 首启导入旧 `servermonitor.db` 副本 → 主机/历史/密钥可用。
- [ ] Step 4: 升级 vN → vN+1（安装器覆盖 + electron-updater 从 rc Release）→ 数据设置保留。
- [ ] Step 5: 自启：注销重登，托盘出现、无窗口。
- [ ] Step 6: 卸载：否→数据保留、`$INSTDIR` 无残留；是→数据删除；`Uninstall.exe /S`→保留。

## Task 9: P8 验收文档

**Files:** Create `docs/superpowers/plans/p8-acceptance.md`

- [ ] Step 1: backend/desktop 门禁数字（对比 Task 0）+ 无 Python PATH 证据。
- [ ] Step 2: Task 8 每步结果。
- [ ] Step 3: `git ls-files | grep -iE '\.py$|\.bat$|\.ps1$'` 输出为空；`git ls-files | grep -iE 'servermanage/|^tests/|pyproject|packaging/'` 为空。
- [ ] Step 4: CI 链接（ci 绿、release 三件）。
- [ ] Step 5: 路线图 P8 行标记完成。

**Commit:** `docs(p8): acceptance record`

---

## 执行顺序

Task 0 → 1（冻结）→ 2（资源迁移）→ 3 → 4 → 5 → 6 → 7 → 8 → 9。Task 1 必须在任何 Python 文件/模板移动之前完成（oracle 需 Python 渲染模板）。

## 风险

1. 模板/静态资源随 `servermanage/` 被删 → 白屏。缓解：Task 2 + 打包冒烟。
2. golden 冻结不完整（oracle 被 skip）→ 失去对照。缓解：Task 0 Step 4、Task 1 Step 3/5。
3. 非确定输出导致 golden 抖动 → 两次冻结 diff + §9.1 归一化。
4. `desktop/electron/preload.js` 可能被间接复用 → Task 4 Step 1 证据为前提。
5. NSIS 自定义脚本静默卸载/进程占用 → Task 8 实机覆盖。
6. 先删 `bump_version.py` 会断 release → Task 5 同 commit 替换。
7. 存量绿色 zip 用户无法经旧 updater 升级到 NSIS → 文档说明需手动下载一次 Setup.exe。

## 待用户确认

- **Q1 `backup_20261123/`**：含 `data__servermanage.db`、`data__servermonitor.db`、`runtime-db-20261123`、`old-archive-data`、`config__config.yaml` —— 是业务数据/配置快照，未入库（`.gitignore: backup_*/`）。建议 P8 不删，由用户决定。
- **Q2 `data/`**（`servermonitor.db`、`servermanage.db`、`runtime.json`，未入库）：建议保留，作 Task 8 首启导入测试源。
- **Q3 `release/`**（v0.1.238 绿色 zip + sha256，未入库）：确认后本地删除，不影响 git。
- **Q4 `config/`**（入库 `config.yaml.example`、`.env.example`）：首启导入仍需示例则保留，否则删除。
- **Q5 `使用说明.txt`**：改写保留还是并入 README 后删除？
- **Q6 `logs/`、`tools/`**：`tools/` 空则删；`logs/` 未入库本地清理。
- **Q7 版本号**：`0.1.240` 还是 `0.2.0`（electron-updater 同 major 策略在 0.x 下的含义需确认）。
- **Q8** 是否给旧绿色包推送一个引导下载 Setup.exe 的「最后一版」？默认不做。
