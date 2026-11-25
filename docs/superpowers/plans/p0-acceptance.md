# P0 验收：安装 → 启动 → 卸载（半自动 + 人工清单）

- 日期：2026-11-25
- 分支：`refactor/single-stack-b1`
- 安装器：`desktop/release-electron/ServerMonitor-0.1.239-Setup.exe`（121,486,088 bytes，构建于 2026-11-25 18:51，NSIS 3.04，per-user，allowToChangeInstallationDirectory）
- 环境：Windows x64 · Node.js v22.14.0 · scratch 安装目录 `D:\Tools\ServerMonitor_p0test`（D 盘、非 C）

## 总体结论

| 验证项 | 结果 |
| --- | --- |
| 静默安装到自定义非 C 目录 | ✅ 通过（exit 0） |
| 装出文件（主 exe / `resources/backend/main.cjs` / `resources/app.asar`） | ✅ 均存在 |
| 安装后后端 `/api/system/health` | ❌ **未通过（as-shipped）**：缺 `resources/package.json` 导致后端启动即崩溃（详见下文，根因已定位） |
| 静默卸载 | ✅ 通过（exit 0，程序目录被移除，HKCU 卸载项被移除） |
| GUI 启动（窗口健康页 + 托盘） | ⏳ 人工待验（1 项） |

> 结论：安装/卸载链路自动化通过；**打包后端在「原样安装产物」下无法启动**（打包漏带 `resources/package.json`），属 P0 阻断问题。后端运行本身正常（补上该文件后 health 返回 200）。

## 步骤与实测结果

- [x] **1. 安全前置**：确认 `D:\Tools\ServerMonitor_p0test` 不存在（未覆盖任何非空目录）；安装目标在 D 盘、非 C 盘。
- [x] **2. 静默安装**：`/S /D=D:\Tools\ServerMonitor_p0test`（`/D=` 为最后一个参数、不加引号）。退出码 0，约 9.5s 完成。
  - ⚠️ 环境注记：**直接以仓库中文路径运行该 Setup.exe 时，进程退出码为 0 但未产生任何文件（静默 no-op，重复 3 次，含 ASCII 工作目录对照）**；将安装器复制到 ASCII 路径 `D:\Tools\ServerMonitor-Setup.exe` 后再执行同一 `/S /D=` 命令即正常安装。疑似安装器自身 exe 路径含非 ASCII 字符导致（本机复现）。验收采用「复制到 ASCII 路径后运行」的方式完成。
- [x] **3. 启动验证（后端层）**：见「后端 health」一节的失败结论与根因。
- [ ] **4. GUI 启动（人工待验）**：双击 `<installDir>\服务器轮询监测工具.exe`，期望出现窗口显示健康页 + 系统托盘。本环境无法起图形界面自动断言，列为人工待验。
- [x] **5. 卸载**：运行 `<installDir>\Uninstall 服务器轮询监测工具.exe /S`，退出码 0；程序目录被完整移除（卸载前 75 个文件 → 目录消失），HKCU `…\Uninstall\54e6ceab-…` 卸载项被移除。
- [x] **6. 数据保留**：本步骤只把独立后端跑到临时 runtime，**未走 app 主程序 dataDir 逻辑，故 `D:\ServerMonitorData` 全程未被创建**。数据保留（`deleteAppDataOnUninstall:false`）留待 P6 集成阶段验证。
- [x] **7. 清理 scratch**：`D:\Tools\ServerMonitor_p0test` 与临时 `D:\Tools` 均已清理，无残留。

## 装出文件清单（`D:\Tools\ServerMonitor_p0test`）

主程序目录共 75 个文件，关键项：

| 文件 | 大小 (bytes) |
| --- | --- |
| `服务器轮询监测工具.exe`（主程序，非 Uninstall） | 249,831,936 |
| `Uninstall 服务器轮询监测工具.exe` | 182,129 |
| `resources\backend\main.cjs` | 1,199,006 |
| `resources\app.asar` | 7,539 |
| `resources\elevate.exe` | 107,520 |

三项必需断言（主 exe、`resources/backend/main.cjs`、`resources/app.asar`）全部满足。

## 后端 health（关键失败项）

**as-shipped 结果：❌ FAIL**。执行

```
node "<installDir>/resources/backend/main.cjs" --port 0 --runtime <tmp>
```

后端启动即崩溃，原始错误：

```
Error: ENOENT: no such file or directory, open 'D:\Tools\ServerMonitor_p0test\resources\package.json'
    at readFileSync (node:fs:442:10)
    at Object.<anonymous> (D:\Tools\ServerMonitor_p0test\resources\backend\main.cjs:24612:35)
  code: 'ENOENT', path: 'D:\Tools\ServerMonitor_p0test\resources\package.json'
```

**根因**：`backend/src/version.ts` 在模块顶层读取 `join(__dirname, '..', 'package.json')`。打包后该文件位于 `resources\backend\main.cjs`，`..` 解析为 `resources\`，即需要 `resources\package.json`；但 `desktop/electron-builder.yml` 的 `extraResources` 仅复制 `backend/dist/main.cjs → backend/main.cjs`，**并未携带 `backend/package.json`**，故安装产物缺该文件，后端在 `createApp()` 之前即抛错（主进程 `main.ts` 会按退避重试重启，表现为后端永远起不来）。

**对照验证（证明运行层正常，仅打包缺文件）**：临时把 `backend/package.json`（version `0.1.239`）复制为 `<installDir>\resources\package.json` 后重跑：

```
runtime={"url":"http://127.0.0.1:51586","port":51586,"pid":60956}
GET /api/system/health -> 200 body={"status":"ok","version":"0.1.239"}
```

即：补上 `resources/package.json` 后 health 断言通过；验证后已删除该诊断用文件，保持「原样安装产物」再执行卸载。

## 卸载结果

- 命令：`"<installDir>\Uninstall 服务器轮询监测工具.exe" /S`
- 退出码：0
- 卸载后：`D:\Tools\ServerMonitor_p0test` 目录不再存在（主 exe、`resources/` 均一并移除），HKCU 卸载注册项已删除。
- `D:\ServerMonitorData`：不存在（未被创建/未被误删）。

## 人工待验项（1 项）

1. **GUI 启动**：双击安装目录 `服务器轮询监测工具.exe`，确认：窗口出现并显示健康页、右下角出现系统托盘图标、托盘菜单（显示主窗口 / 复制看板地址 / 打开日志目录 / 退出）可用。本环境无图形界面会话，无法自动断言，须在真实桌面环境人工确认（在修复下述打包缺陷后进行）。

## 已知问题 / 后续

1. **（P0 阻断）打包漏带 `resources/package.json`**：导致安装后后端无法启动。建议在 `desktop/electron-builder.yml` 的 `extraResources` 增加 `backend/package.json → package.json`，或构建期通过 esbuild `define` 注入版本号，避免运行时读文件。本任务不改源码。
2. 安装器在**自身路径含非 ASCII 字符时静默安装无效**（退出码 0 但无任何写入）：验收需先将 Setup.exe 复制到 ASCII 路径运行；若这是产品分发场景会遇到的路径，需另行评估。
3. 数据目录保留逻辑（`deleteAppDataOnUninstall:false`）留待 P6 集成验证。
