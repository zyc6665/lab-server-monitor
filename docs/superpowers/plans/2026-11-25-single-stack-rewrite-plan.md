# 单栈桌面化重构 · 实施计划（路线图 + P0 详细任务）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal（本计划）:** 搭起 B1 单栈重构的工程骨架——pnpm 工作区 + Node/TS 后端健康检查 + Electron 主进程用 `utilityProcess` 拉起后端并完成端口握手 + NSIS 安装器可产出——作为后续逐阶段迁移的地基。

**Architecture:** Electron 主进程（TS）通过 `utilityProcess` 启动一个 Node/TS 后端（Express，监听 `127.0.0.1` 动态端口，写 `runtime.json`）；主进程轮询握手后让 `BrowserWindow` 加载 `http://127.0.0.1:<port>`。数据目录与安装目录解耦，用 HKCU 指针保存；打包用 electron-builder NSIS。

**Tech Stack:** Node.js 22 · Electron 45.2.3 · TypeScript · Express · better-sqlite3 · ssh2 · Nunjucks · vitest · esbuild · electron-builder(NSIS) · electron-updater。

**Spec:** `docs/superpowers/specs/2026-11-25-single-stack-desktop-rewrite-design.md`

## Global Constraints

- 仅 Windows x64；Node.js 22；Electron 45.2.3；TypeScript。
- 复用同一 SQLite（默认 `data/servermonitor.db`，由 `storage.db_path` 决定），不重建表结构。
- 时间戳必须 ISO-8601 UTC 文本 `YYYY-MM-DDTHH:MM:SS.ffffff+00:00`（依赖字典序比较）；JSON 列 UTF-8；布尔 `0/1`。
- `app_secrets` 用 DPAPI（当前用户、无 entropy）加密，必须用 `win-dpapi` 读取既有密文，禁止 `safeStorage` 直读旧 blob。
- 保留 `/api/*` 契约与 15 个 HTML 模板 + `static/` 原样（Nunjucks 兼容层）。
- per-user NSIS 安装器；默认安装 `D:\Tools\ServerMonitor`（无 D 盘回退 `%LOCALAPPDATA%\Programs\ServerMonitor`）；默认数据 `D:\ServerMonitorData`（无 D 盘回退 `%LOCALAPPDATA%\ServerMonitor`）；均可自定义；不强制写 C 盘。
- 无 `.bat`/`.ps1` 发行物、无 Python 运行时（迁移期 Python 仅作测试 oracle，末阶段移除）。
- 自动更新用 `electron-updater`（GitHub 公开仓库，CI 产出 `latest.yml`，仅同 major、排除 prerelease）。
- 首启自动探测旧 `data/servermonitor.db` 复制导入；`config.yaml`/`.env` 一次性导入 DB。
- 任何 schema 迁移前自动备份 + 事务回滚；只前进、不降级。

## Review Focus

1. **旧库/legacy DB 打开**（`journal_mode=delete`、缺列）→ 应自动迁移、不丢数据；测试在 P1 计划的任务里（迁移前备份 + 缺列 ADD）。
2. **时间戳微秒格式** 不一致 → 范围查询/排序错乱；测试在 P1（`nowIsoUtc()` 输出严格 `...+00:00` 6 位微秒）。
3. **DPAPI 旧密文解密** → 用真实 blob fixture 断言 `win-dpapi` 能解出明文（P1）。
4. **后端崩溃 / 端口未就绪** → 主进程必须退避重启并给出可见错误，不能白屏；测试在 **Task 4**。
5. **安装到自定义非 C 目录 + 卸载保留数据** → 不写 C、卸载不删数据；验收在 **Task 8**。

---

## 1. 分阶段路线图（P0–P8）

> 每个阶段都是一个**可独立验证**的交付；按 writing-plans 的做法，**每个阶段单独写详细任务计划**（本文件先给 P0 的任务级细节，其余阶段在执行到之前再展开各自计划）。

| 阶段 | 交付 | 关键验收门禁 | 预计任务数 |
|---|---|---|---|
| **P0 工程骨架** | pnpm 工作区、Node/TS 后端 + 健康检查、Electron 主进程 + utilityProcess 握手、NSIS 安装器骨架、CI | 安装器可装到自定义目录并启动显示健康页；CI 绿 | ~8（本文已细化） |
| **P1 存储层** | better-sqlite3 复刻 21 表 / 迁移 / 仓库 API / 备份；`nowIsoUtc`；DPAPI | 打开真实旧库 + legacy fixture 通过；与 Python 同输入同输出 | ~14 |
| **P2 Web/认证/设置** | Express 路由 1:1、Nunjucks 渲染全部页面、登录/CSRF/限流/SSRF、设置契约 | 页面 200、登录流、设置读写、页面 golden | ~16 |
| **P3 采集/SSH/解析** | ssh2 采集 22 阶段、解析器、TOFU/strict、sudo via stdin | fixture 对照；真实主机/mock 冒烟 | ~12 |
| **P4 调度/告警/通知** | scheduler catch-up、AlertEngine、nodemailer/webhook/Notification | 时序对照 + 告警状态机用例对照 | ~14 |
| **P5 报表/磁盘/用户/容量/诊断** | 报表模板、storcli 解析、用户扫描/计划、容量 ETA、诊断 | 报表 HTML 对照、storcli fixture、用户计划 | ~14 |
| **P6 Electron 集成** | utilityProcess 全生命周期、托盘、单实例、数据目录选择器、首启导入 | 打包前后端联动、崩溃恢复、托盘行为、首启导入 | ~10 |
| **P7 差分验证** | 同 DB 副本回放 `/api/*` 与定时任务，逐字段 diff（§9.1 归一化） | 差异清零；Node 测试全绿 | ~6 |
| **P8 收尾发布** | NSIS 安装/卸载/自启/electron-updater；移除 Python/packaging/ps1/sidecar；文档 | 装到自定义非 C 目录→运行→升级→卸载保留数据；CI release 绿 | ~8 |

**每阶段通用门禁**：新增 Node 测试通过 + 关键路径差分通过 + 迁移期 Python 基线（1892 passed / 1 skipped）仍绿 + 分支内一次提交。

---

## 2. P0 详细任务（工程骨架）

> 约定：本阶段所有 Node 侧文件放 `backend/`（后端）与 `desktop/`（Electron）；测试用 vitest（`backend`）与 `node --test`（`desktop`，沿用现有桌面测试风格）。

### Task 1: pnpm 工作区 + backend 骨架 + 健康检查

**Files:**
- Create: `pnpm-workspace.yaml`、`package.json`（根，私人包、脚本聚合）、`backend/package.json`、`backend/tsconfig.json`、`backend/vitest.config.ts`
- Create: `backend/src/server.ts`、`backend/src/version.ts`、`backend/test/health.test.ts`

**Interfaces:**
- Produces: `startServer(opts?: { port?: number }): Promise<{ url: string; port: number; close: () => Promise<void> }>`
- Produces: `createApp(): import('express').Express`（P0 仅挂 `/api/system/health`）

- [ ] **Step 1: 写失败测试** `backend/test/health.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { startServer } from '../src/server';

describe('health', () => {
  it('GET /api/system/health -> 200 {status:ok}', async () => {
    const s = await startServer({ port: 0 });
    try {
      const r = await fetch(s.url + '/api/system/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ status: 'ok' });
    } finally { await s.close(); }
  });
});
```
- [ ] **Step 2: 运行确认失败** — `cd backend && pnpm vitest run test/health.test.ts`，预期 FAIL（无 `src/server`）。
- [ ] **Step 3: 实现** `backend/src/server.ts`（Express，`GET /api/system/health` 返回 `{status:'ok', version: APP_VERSION}`；`port??0` 由 `server.listen` 分配，`close()` 关闭监听）；`backend/src/version.ts` 导出 `APP_VERSION`（读 `backend/package.json` 的 `version`，P0 固定 `0.1.239`）。
- [ ] **Step 4: 运行确认通过** — `pnpm vitest run test/health.test.ts`，预期 PASS。
- [ ] **Step 5: 提交** — `git add pnpm-workspace.yaml package.json backend && git commit -m "feat(p0): backend skeleton + health endpoint"`。

### Task 2: esbuild 打包后端为单文件 CJS + 冒烟

**Files:**
- Create: `backend/build.mjs`；Modify: `backend/package.json`（`scripts.build = "node build.mjs"`）
- Create: `backend/test/bundle.smoke.test.ts`

**Interfaces:**
- Produces: `backend/dist/main.cjs`（单文件 CJS；`external: ['better-sqlite3']`，因原生模块不打包）；`node dist/main.cjs --port 0` 打印 `SERVER_URL=...`。

- [ ] **Step 1: 写失败冒烟测试**：build 后 `spawn('node',['dist/main.cjs','--port','0'])`，解析 stdout 中 `SERVER_URL=`，`fetch(url+'/api/system/health')` 断言 200，然后 kill。
- [ ] **Step 2: 运行确认失败**（尚无 `dist/main.cjs`）。
- [ ] **Step 3: 实现** `backend/build.mjs`（esbuild `platform:'node'`,`format:'cjs'`,`bundle:true`,`external:['better-sqlite3']`,`outfile:'dist/main.cjs'`）；`server.ts` 增加 `if (require.main===module){ const p=Number(argv('--port')??0); startServer({port:p}).then(s=>console.log('SERVER_URL='+s.url)); }`。
- [ ] **Step 4: 运行确认通过** — `pnpm build && pnpm vitest run test/bundle.smoke.test.ts`。
- [ ] **Step 5: 提交**。

### Task 3: 主进程 paths 解析（可单测，注入 fs/registry）

**Files:**
- Create: `desktop/src/main/paths.ts`、`desktop/test/paths.test.ts`

**Interfaces:**
- Produces: `resolveInstallDir(opts: { existsDrive: (d: string) => boolean; localAppData: string }): string`
- Produces: `resolveDataDir(opts: { installDir: string; existsDrive: (d: string) => boolean; localAppData: string; readDataDirPointer: () => string | null }): string`
- Produces: `logsDir(dataDir: string): string`

- [ ] **Step 1: 写失败测试**（用注入桩覆盖两条分支）：
```ts
import { resolveInstallDir, resolveDataDir, logsDir } from '../src/main/paths';
it('install defaults to D:\\Tools\\ServerMonitor when D exists', () => {
  expect(resolveInstallDir({ existsDrive: d=>d==='D:', localAppData:'C:/Users/u/AppData/Local' }))
    .toBe('D:\\Tools\\ServerMonitor');
});
it('install falls back to LOCALAPPDATA when no D', () => {
  expect(resolveInstallDir({ existsDrive: ()=>false, localAppData:'C:/Users/u/AppData/Local' }))
    .toBe('C:\\Users\\u\\AppData\\Local\\Programs\\ServerMonitor');
});
it('data honors HKCU pointer', () => {
  expect(resolveDataDir({ installDir:'D:\\Tools\\ServerMonitor', existsDrive:()=>true, localAppData:'x', readDataDirPointer:()=> 'E:\\MyData' })).toBe('E:\\MyData');
});
it('data defaults to D:\\ServerMonitorData', () => {
  expect(resolveDataDir({ installDir:'D:\\Tools\\ServerMonitor', existsDrive:d=>d==='D:', localAppData:'x', readDataDirPointer:()=>null })).toBe('D:\\ServerMonitorData');
});
it('logs under data dir', () => { expect(logsDir('D:\\ServerMonitorData')).toBe('D:\\ServerMonitorData\\logs'); });
```
- [ ] **Step 2: 运行确认失败** — `cd desktop && node --test test/paths.test.ts`（或经 tsx 转译）。
- [ ] **Step 3: 实现** `desktop/src/main/paths.ts`（纯函数，全部依赖注入，禁止直接读注册表/fs；真实调用方在 Task 4 注入真实实现）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**。

### Task 4: utilityProcess 生命周期纯逻辑（握手/退避/停止）

**Files:**
- Create: `desktop/src/main/backend-process.ts`、`desktop/test/backend-process.test.ts`

**Interfaces:**
- Produces: `waitForRuntime(readRuntime: () => RuntimeInfo | null, opts?: { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms:number)=>Promise<void> }): Promise<RuntimeInfo>`；`RuntimeInfo = { url: string; port: number; pid: number }`。
- Produces: `RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000]`；`nextRetryDelay(attempt: number): number`（超出数组固定 30000）。

- [ ] **Step 1: 写失败测试**：① `waitForRuntime` 在 `readRuntime` 恒为 `null` 时 `timeoutMs=50` 抛 `BackendStartupTimeout`；② 在第二次返回有效值时 resolve；③ `nextRetryDelay(0)=2000 … nextRetryDelay(9)=30000`。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现**（注入 `now`/`sleep` 使测试无需真实等待）。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: 提交**。

### Task 5: Electron 主程序装配（窗口 + 单实例 + 托盘）

**Files:**
- Create/Modify: `desktop/src/main/main.ts`（应用入口：单实例锁、组装 `paths`+`backend-process`、启动 utilityProcess、加载 URL、托盘菜单、最小化/关窗隐藏）
- Modify: `desktop/package.json`（`main` 指向构建产物 `dist/main.js`；新增 `scripts.build:main` 用 esbuild/tsc）

**Interfaces:**
- Consumes: Task 3 `resolveDataDir/resolveInstallDir/logsDir`；Task 4 `waitForRuntime/nextRetryDelay`。
- Produces: 可运行应用——启动后窗口显示 `{status:'ok'}`；托盘存在；关窗隐藏、双击恢复。

- [ ] **Step 1: 实现装配**（单实例锁 `app.requestSingleInstanceLock`；`utilityProcess.fork(backendEntry, ['--port','0'], {env})`；轮询 `runtime.json`；`BrowserWindow.loadURL(url)`；`Tray` 菜单：显示主窗口/复制看板地址/打开日志目录/退出）。
- [ ] **Step 2: 冒烟验证** — `pnpm --filter desktop start`：窗口出现、显示健康 JSON 页面、托盘图标存在、点关闭窗口不退出、双击恢复。
- [ ] **Step 3: 提交**。

### Task 6: electron-builder NSIS 安装器骨架 + fuses

**Files:**
- Modify: `desktop/electron-builder.yml`（`win.target: nsis`；`nsis.oneClick:false`、`nsis.allowToChangeInstallationDirectory:true`、`nsis.perMachine:false`；`artifactName`；`publish.provider: github`；保留 `afterPack: scripts/after-pack.js`）
- Modify: `desktop/package.json`（`scripts.build: "electron-builder --win"`）

**Interfaces:**
- Produces: `desktop/release-electron/服务器轮询监测工具-Setup-<ver>.exe`（NSIS 安装器）；`win-unpacked/` 内无 `resources/backend` 的 Python sidecar。

- [ ] **Step 1: 改配置**（如上；`extraResources` 改为后端 bundle `dist/main.cjs`）。
- [ ] **Step 2: 构建并断言** — `pnpm --filter desktop build`；断言 `release-electron` 存在 `*.exe`（Setup）；`win-unpacked` 内无 `*.exe` 名为 `servermonitor-backend`。
- [ ] **Step 3: 提交**。

### Task 7: CI 增加 Node 构建/测试 job（保留 Python 门禁）

**Files:**
- Modify: `.github/workflows/ci.yml`（新增 `node` job：`pnpm install --frozen-lockfile` → `backend` typecheck+vitest+build → `desktop` test → `pnpm --filter desktop build`（windows-latest））

- [ ] **Step 1: 改 YAML**（保留现有 pytest job 不动；新 job 用 `windows-latest`，`pnpm/action-setup`）。
- [ ] **Step 2: 本地校验 YAML** — `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('ok')"` 预期 `ok`。
- [ ] **Step 3: 提交**（推分支后由 CI 实跑；本地无法跑 GitHub Actions）。

### Task 8: P0 验收（安装 → 启动 → 卸载）

**Files:** Create: `docs/superpowers/plans/p0-acceptance.md`（人工验收清单）

- [ ] **Step 1: 构建安装器**（Task 6 产物）。
- [ ] **Step 2: 自定义目录安装** — 安装到 `D:\Tools\ServerMonitor`（非 C）；确认开始菜单项、卸载项存在。
- [ ] **Step 3: 启动验证** — 运行后窗口显示健康页；托盘可显示/隐藏。
- [ ] **Step 4: 卸载验证** — 卸载后程序目录移除；若已创建数据目录则**保留**（P0 数据目录为空，仅验证卸载不删数据目录逻辑）。
- [ ] **Step 5: 勾选清单并提交** `docs/superpowers/plans/p0-acceptance.md`。

---

## 3. P0 完成定义（DoD）

- 安装器可装到自定义非 C 目录、可卸载、开始菜单项存在。
- 启动后 `BrowserWindow` 显示 `/api/system/health` 的健康 JSON；托盘可用；关窗隐藏/双击恢复。
- 无 `servermonitor-backend` sidecar、无 `.bat`/`.ps1`、无 Python 进程参与运行。
- `backend` vitest 绿；`desktop` node --test 绿；CI 的 Node job 绿且 Python job 仍绿。

---

## 4. 后续阶段入口（P1 及以后，各自单独出计划）

- **P1 计划必须包含**：`openDatabase(path)` / `initSchema(db)` / `runMigrations(db)` / 各仓库模块（metrics/hosts/alerts/settings/disk/users/runtime）签名、`nowIsoUtc()`、`win-dpapi` 封装、legacy fixture 兼容测试、备份 + 事务回滚测试、以及与 Python `storage/*` 的对照测试。
- **P2 计划必须包含**：路由表（method+path+auth）、中间件链、`url_for`/CSRF/`asset_url` 兼容层、页面 golden。
- **P3–P8**：见设计文档 §6 对应小节；差分判据统一按设计文档 §9.1。
