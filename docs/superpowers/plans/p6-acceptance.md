# P6 Electron 集成 — 验收报告

日期：2026-11-26 ｜ 分支：refactor/single-stack-b1 ｜ 基线版本 0.1.239

## 范围

P6 把单栈后端接入 Electron 桌面壳，并改为 NSIS 安装器分发：

- T1 数据目录解析（HKCU 指针 + 默认非 C 盘）
- T2 后端 CLI（`--data-dir` / `--import-legacy`）与首启旧库/旧配置导入、迁移前备份
- T3 electron-updater 集成（IPC + 纯策略 + preload 桥）
- T4 main.ts 生命周期（单实例、托盘、开机自启、`--start-hidden`、优雅退出、10s 自动检查更新）
- T5 NSIS 打包 + GitHub publish 配置
- T6 验收（本文件）

## 门禁（全绿）

| 检查 | 结果 |
| --- | --- |
| backend `tsc --noEmit` | exit 0 |
| backend `vitest` | 93 files / 1863 passed / 1 skipped |
| desktop `tsc --noEmit` | exit 0 |
| desktop `vitest`（test-unit） | 5 files / 116 passed |
| desktop `node --test`（test/） | 94 pass / 0 fail |
| Python `pytest -q` | 1892 passed / 1 skipped |
| `servermanage/` 改动 | 0（`git diff main..HEAD -- servermanage/` 为空） |

## 打包与安装验收

- `pnpm --filter servermonitor-backend build` → `backend/dist/main.cjs`（~1.9 MB）+ `backend/dist/vendor/`（运行时外部依赖，见下）。
- `cd desktop && pnpm build:main && pnpm exec electron-builder --win --publish never`
  → `desktop/release-electron/ServerMonitor-0.1.239-Setup.exe`（~123.9 MB）+ `latest.yml` + `.blockmap`。
- 静默安装到自定义目录（`D:\Tools\ServerMonitor_p6test`，`powershell Start-Process -Wait` + `/S /D=...`）：exit 0，生成主程序、`resources/backend/main.cjs`、`resources/backend/node_modules/`（8.9 MB）、卸载器。
- 安装产物后端冒烟：`node resources/backend/main.cjs --data-dir D:\SMDataP6 --port 0 --runtime ...` → 生成 `D:\SMDataP6\servermonitor.db`，`/api/system/health` 返回 `{"error":"setup_required"}`（DB + 组合根已加载，等待 /setup）。
- 静默卸载：exit 0，`HKCU` 卸载项移除。
- GUI、托盘、开机自启、真机自动更新为人工待验项（需桌面会话）。

## 关键修复（验收中发现的打包缺依赖）

首次打包安装后启动后端即崩溃：`Cannot find module '@primno/dpapi'`。根因：`backend/build.mjs` 将原生/重量级依赖设为 esbuild external（`better-sqlite3`、`@primno/dpapi`、`ssh2`、`nodemailer`），但 `electron-builder` 只携带了 `main.cjs`，未带这些运行时依赖。

修复：
- 新增 `backend/scripts/stage-vendor.mjs`：按 `package.json` 依赖闭包把外部包 dereference 复制到 `backend/dist/vendor/node_modules`（并裁剪 better-sqlite3 到 `win32-x64.node` prebuild），再镜像到 `desktop/.vendor-stage/pkgs`。
- `backend/package.json`：`build` 改为 `node build.mjs && node scripts/stage-vendor.mjs`。
- `desktop/electron-builder.yml`：`extraResources` 增 `.vendor-stage/pkgs → backend/node_modules`。
- 注意：`electron-builder` 默认忽略名为 `node_modules` 的目录，故暂存目录改名为 `pkgs`；暂存目录用点前缀（`.vendor-stage`）以免 `node --test` 递归扫到第三方测试。

## 遗留（P8 处理）

- 旧 portable 线（`desktop/electron/updater*.js`、`desktop/scripts/apply-update.ps1`、`build-portable.ps1`、`packaging/`）暂保留，其 Node 静态测试仍绿；P8 统一删除时同步调整相关测试。
- `tests/test_v15_update_assets.py` 已按新版发布流水线更新：断言 `ServerMonitor-*-Setup.exe` / `latest.yml` / `*.blockmap`（替代旧的 `release/*.zip` 与 `.sha256`）。
- SSRF/SMTP 等真实外部调用未在打包产物联调（需真实环境）。
- 若卸载时文件被占用，NSIS 可能残留空目录；P8 收尾统一清理策略。
