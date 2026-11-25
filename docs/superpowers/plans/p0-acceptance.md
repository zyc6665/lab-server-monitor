# P0 验收：安装 → 启动 → 卸载（半自动 + 人工清单）

- 日期：2026-11-25
- 分支：`refactor/single-stack-b1`
- 安装器：`desktop/release-electron/ServerMonitor-0.1.239-Setup.exe`（121,485,955 bytes，构建于 2026-11-25 19:30，NSIS，per-user，`allowToChangeInstallationDirectory: true`，无代码签名证书 → 跳过签名）
- 环境：Windows x64 · Node.js v22.14.0 · scratch 安装目录 `D:\Tools\ServerMonitor_p0test`（D 盘、非 C）

## 总体结论（修复打包缺陷后）

| 验证项 | 结果 |
| --- | --- |
| 静默安装到自定义非 C 目录 | ✅ 通过（exit 0，装到 `D:\Tools\ServerMonitor_p0test`） |
| 装出文件（主 exe / `resources/backend/main.cjs` / `resources/app.asar` / 卸载器） | ✅ 均存在 |
| 安装后后端 `/api/system/health` | ✅ 通过：`200 {"status":"ok","version":"0.1.239"}` |
| 静默卸载 | ✅ 通过（exit 0，程序目录移除，HKCU 卸载项移除） |
| GUI 启动（窗口健康页 + 托盘） | ⏳ 人工待验（1 项） |

> 结论：安装 / 启动（后端层）/ 卸载全链路自动化通过。此前「打包后端缺 `resources/package.json` 启动即崩溃」的 P0 阻断问题已修复（改构建期注入版本号，见下），并重打安装器复验通过。

## 步骤与实测结果

- [x] **1. 安全前置**：确认 `D:\Tools\ServerMonitor_p0test` 不存在（未覆盖任何非空目录）；安装在 D 盘、非 C。
- [x] **2. 静默安装**：通过 PowerShell `Start-Process -Wait -ArgumentList '/S','/D=D:\Tools\ServerMonitor_p0test'` 执行，退出码 0，约 9.5s。装出主程序目录（约 75 个文件）。
  - 环境注记：在本 MSYS shell 中**直接执行该 Setup.exe 会立即返回 0 但不落盘**（进程被分离/参数被 shell 改写）；改用 `powershell Start-Process -Wait` 且安装器位于 ASCII 路径（`%TEMP%\smsetup.exe`）后正常安装。此为验收脚本环境问题，非产品缺陷。
- [x] **3. 启动验证（后端层）**：`node "<installDir>/resources/backend/main.cjs" --port 0 --runtime <tmp>` 启动成功，`GET /api/system/health` → `200 {"status":"ok","version":"0.1.239"}`。
- [ ] **4. GUI 启动（人工待验）**：双击 `<installDir>\服务器轮询监测工具.exe`，期望出现窗口（健康页）+ 系统托盘（菜单：显示主窗口 / 复制看板地址 / 打开日志目录 / 退出）。本环境无图形会话，无法自动断言，须在真实桌面人工确认。
- [x] **5. 卸载**：`"<installDir>\Uninstall 服务器轮询监测工具.exe" /currentuser /S`（即注册表 `QuietUninstallString`），退出码 0；程序目录被完整移除；HKCU `…\Uninstall\…` 卸载项被删除。
- [x] **6. 数据保留**：本步骤只把独立后端跑到临时 runtime，未走 app 主程序 dataDir 逻辑，故 `D:\ServerMonitorData` 全程未创建。`deleteAppDataOnUninstall:false` 的数据保留行为留待 P6 集成验证。
- [x] **7. 清理 scratch**：`D:\Tools\ServerMonitor_p0test` 与临时 `D:\Tools` 均已清理，无残留。

## 装出文件清单（`D:\Tools\ServerMonitor_p0test`）

| 文件 | 大小 (bytes) |
| --- | --- |
| `服务器轮询监测工具.exe`（主程序） | 249,831,936 |
| `Uninstall 服务器轮询监测工具.exe` | 182,129 |
| `resources\backend\main.cjs` | 1,198,797 |
| `resources\app.asar` | 7,609 |

注册表（HKCU，per-user）验证：
- `DisplayName = 服务器轮询监测工具 0.1.239`
- `UninstallString = "<installDir>\Uninstall 服务器轮询监测工具.exe" /currentuser`
- `QuietUninstallString = "<installDir>\Uninstall 服务器轮询监测工具.exe" /currentuser /S`
- 卸载后该键被移除。

## 已修复的 P0 阻断：打包后端读 `package.json` 崩溃

**原问题**：`backend/src/version.ts` 在模块顶层 `readFileSync(join(__dirname, '..', 'package.json'))`；打包后文件位于 `resources\backend\main.cjs`，`..` 指向 `resources\`，而 `extraResources` 只复制了 `backend/dist/main.cjs`，不含 `package.json`，后端在 `createApp()` 前即抛 `ENOENT ...resources\package.json` 崩溃（原错误见 dist/main.cjs:24612）。

**修复方案（构建期注入，而非补带 package.json）**：commit `f3750fe`
- `backend/build.mjs`：构建时读取 `backend/package.json` 的 version，esbuild `define: { __APP_VERSION__: JSON.stringify(version) }`，把版本号作为字面量打进 `dist/main.cjs`。
- `backend/src/version.ts`：`export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : readPackageVersion();` —— 打包产物命中注入字面量、**运行期完全不读磁盘**；vitest/ts-node 下未定义则回退读 `backend/package.json`（开发/测试不受影响）。
- 回归测试 `backend/test/bundle.smoke.test.ts` 新增 "packaged layout (no package.json on disk)"：把 `dist/main.cjs` 复制到 `resources/backend/`（其上层无 package.json）后启动，断言 health 200 且 `version` 等于 `backend/package.json` 的 version。`grep '"package.json"' dist/main.cjs` 现为 0 命中。

**复验**：新安装器（19:30 构建）装出的 `resources/backend/main.cjs` 在「原样安装产物」下直接启动 → health 200 / version 0.1.239，无需任何手工补文件。

## 人工待验项（1 项）

1. **GUI 启动**：双击安装目录 `服务器轮询监测工具.exe`，确认窗口（健康页）与系统托盘出现、托盘菜单可用。需真实桌面会话人工确认。

## 已知问题 / 后续

1. `desktop/package.json` 缺 `description` / `author` 字段（electron-builder 仅告警，不影响产出）；建议后续补上以规范元数据与发布信息。
2. 数据目录保留逻辑（`deleteAppDataOnUninstall:false`）与首次启动 dataDir/旧库迁移，留待 P6 集成阶段验证。
3. 安装器无代码签名证书（按 §11 决策，发布为未签名 + 文档说明 SmartScreen）。
