# P3 验收报告 — 采集层迁移 + 依赖注入（Python → Node/TypeScript）

分支：`refactor/single-stack-b1`　·　Python oracle：`servermanage/collect/*`、`servermanage/host_probe.py`、`servermanage/compute.py`、`servermanage/capacity.py`（均未改动）　·　Node 实现：`backend/src/collect/*` + `backend/src/web/composition.ts`

## 门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| Node 类型检查 | `pnpm --filter servermonitor-backend typecheck` | ✅ 0 errors |
| Node 全量单测 | `pnpm --filter servermonitor-backend test` | ✅ **61 files / 1033 passed, 1 skipped**（1034 总计；任务书基线 59/1019/1，本任务新增 `composition.test.ts` 8 用例，其余差额来自同期已合并的 P3 collect 测试） |
| Python 回归 | `python -m pytest -q` | ✅ **1892 passed, 1 skipped**；`servermanage/**` 零改动 |
| 打包冒烟 | `backend/test/bundle.smoke.test.ts`（内含 `node build.mjs` + 裸 `resources/backend/main.cjs` 启动） | ✅ 2 passed |

> 1 个 skip 仍为 `backend/test/dpapi.test.ts` 的“DPAPI 不可用”防御性分支。
> Python 退出时 `pytest` 的 `cleanup_dead_symlinks` atexit 警告（`WinError 5`）为 Windows 临时目录清理噪声，退出码 0，不影响结果。

## P3 交付清单 — 10 个 collect 模块

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `backend/src/collect/commands.ts` | 60 | 采集命令常量（`docker stats`、系统信息等 shell 命令模板） |
| `backend/src/collect/types.ts` | 374 | 采集层公共类型（`CommandResult`、`HostSnapshot`、解析结果等） |
| `backend/src/collect/parsers-text.ts` | 501 | 文本解析原语（key/value、表格、单位换算等） |
| `backend/src/collect/parsers.ts` | 503 | 各命令输出解析器（CPU/内存/磁盘/GPU/docker 等），对齐 Python oracle |
| `backend/src/collect/ssh-client.ts` | 606 | `SshClient`（connect/run/runSudo/openShell/close），惰性连接，host key policy |
| `backend/src/collect/collectors.ts` | 397 | `hostToSshConnectConfig` 映射、`collectAllHosts` 汇总采集编排 |
| `backend/src/collect/host-probe.ts` | 514 | `probeHost(candidate)`：OS/内核/CPU/内存/挂载/storcli/sudo 能力探测，`defaultRunnerFactory` |
| `backend/src/collect/container-stats.ts` | 165 | `collectContainerStats`：单机 `docker stats` 解析为 `ContainerStatRow[]` |
| `backend/src/collect/compute.ts` | 481 | `buildComputeSummary`：算力聚合（含 GPU_SPECS 真实 tflops/带宽表） |
| `backend/src/collect/capacity.ts` | 420 | `buildCapacityForecasts`：7/30/90 天容量预测 |

合计约 4021 行，均有对应单测（`backend/test/collect/*.test.ts`）。

## 本任务注入的依赖（`buildDefaultDeps(db, config)`）

全部实现为**闭包/惰性**：构造 `SshClient` 不会建连，只有首次 `run`/`runSudo` 才打开连接，且每次调用后 `finally` 关闭。

| 模块键 | 签名 | 实现要点 |
| --- | --- | --- |
| `hosts.probeHost` | `(target: unknown) => Promise<ProbeResult>` | `string` → `buildServers(db,{baseServers})` 按 name/host 解析（含真实密钥），未命中则按字面主机探测；`HostConfig` 形状 → `hostToSshConnectConfig` 建 runner；松散表单对象 → `candidateFromPayload`（snake_case→camelCase）；超时取 `loadEffectiveSettings(db).ssh.connect_timeout`（默认 10s）。`sshFactory` 在 `probeHost` 的 try 内延迟求值，密钥缺失返回 `{ok:false}` 而非抛错。 |
| `hosts.collectContainerStats` | `(host: HostConfig) => Promise<unknown[]>` | 每次调用新建 `SshClient`，`collectContainerStats(host, client, commandTimeoutMs)`，`finally close()`。 |
| `hosts.runner` | `HostRunner = (server: HostConfig) => Promise<HostRunnerResult>` | 建连执行 `echo ok`（对齐 Python `api_test_hosts_batch`），返回 `{exitStatus,stdout,stderr}`，`finally close()`。供 `/api/settings/hosts/test-batch` 使用。 |
| `pages.buildComputeSummary` | `(db, config) => unknown` | `buildComputeSummary(getAllHostSnapshots(db), {servers: config.servers.map(...)})`，替换原占位 `defaultBuildComputeSummary`。 |
| `hosts.buildOverview` / `buildHostDetail` / `buildHostReport` | 见 `createOverviewBuilders` | P2 已注入的真实 overview builders（保持不变）。 |

配套改动：`createServerApp` 原本只把 `defaults.hosts` 合并进 hosts 路由，`pages` 仅传 `overrides.pages`，导致注入的 `buildComputeSummary` 被丢弃；现改为 `{ ...defaults.pages, ...overrides.pages, db, config, appVersion }`。

## 端点能力现状

| 能力 | 端点 | 现状 |
| --- | --- | --- |
| 主机探测（表单） | `POST /api/settings/hosts/probe` | ✅ 真实（`host-probe.ts`） |
| 主机探测（已保存主机） | `POST /api/settings/hosts/{name}/probe` | ✅ 真实，密钥缺失降级为 `{ok:false}` 不抛错 |
| 连接测试批处理 | `POST /api/settings/hosts/test-batch` | ✅ 真实（`runner` 执行 `echo ok`） |
| 容器 stats | `GET /api/host/{name}/containers/stats` | ✅ 真实（`container-stats.ts`） |
| 算力汇总 | `GET /api/compute` | ✅ 真实（`compute.ts`，GPU 规格表） |
| 容量预测 | `GET /api/overview/capacity` | ✅ 真实——`capacity.ts` 已由 `overview.ts` 内部 `buildCapacityForecasts(db, config.servers)` 直接调用，`OverviewRouteDeps` 无 capacity 字段，无需注入 |
| 主机巡检执行 | `POST /api/host/{name}/checks/run` | ⛔ 占位（`runHostChecks` 未注入，P4） |
| 手动采集 / 采集状态 | `POST /api/settings/hosts/{name}/collect`、`POST /api/settings/hosts/collect`、`GET /api/settings/hosts/collection-status` | ⛔ 占位（`collectHosts` / `collectionStatus` 未注入，P4） |
| 用户扫描 / 刷新 | users 模块 refresh/scan | ⛔ 占位（`monitorService` 未注入，P4/P5） |
| SSH 终端会话 | `/api/ssh/sessions*` | ⛔ 占位（`SshSessionManager` 未注入，P5；POST 仍返回 502 `ssh_failed`） |

## 新增测试：`backend/test/web/composition.test.ts`（8 用例）

不触碰真实网络：SSH 相关仅断言“存在且未建连”，并注入 fake `probeHost` 验证装配覆盖。

`describe buildDefaultDeps — P3 collection wiring`
1. `probeHost` / `collectContainerStats` / `runner` / `buildComputeSummary` 均为函数（另有 overview builders）。
2. `runHostChecks` / `collectHosts` / `collectionStatus` / `users.monitorService` 仍为 `undefined`（P4/P5 边界锁定）。
3. key 认证但无密钥材料的已保存主机：`probeHost(host)` 解析为 `{ok:false}`，不发起连接。
4. `runner` / `collectContainerStats` 在密钥缺失时以 `/SSH key is not configured/` 拒绝（在建连前抛出）。
5. `buildComputeSummary` 基于真实快照（Tesla T4）产出 `totals.tflops > 0`。

`describe createServerApp — P3 assembly`
6. `GET /api/system/health` → 200（admin 已 seed，绕过 setup 门禁）。
7. `GET /api/compute` → 200 且 `totals.tflops > 0`（验证 `defaults.pages` 已合并，走真实 compute）。
8. `deps.hosts.probeHost` 覆盖生效：`POST /api/settings/hosts/probe` 返回 fake 结果且仅调用一次（含 Cookie + `X-CSRF-Token`）。

## 本任务改动文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `backend/src/web/composition.ts` | 改 | 新增 P3 采集层 import 与 5 个构造函数（`candidateFromPayload`、`createProbeRunner`、`createProbeHost`、`createCollectContainerStats`、`createHostRunner`、`createComputeSummaryBuilder`）；`buildDefaultDeps` 注入 hosts/pages 真实依赖；`createServerApp` 为 pages 合并 `defaults.pages`。 |
| `backend/build.mjs` | 改 | `external` 增加 `ssh2`（采集层引入；ssh2 惰性 `require` 可选原生 `cpu-features`，打包必须 external，否则 esbuild 无法解析 `cpufeatures.node`）。 |
| `backend/test/web/composition.test.ts` | 新增 | 见上，8 用例。 |
| `docs/superpowers/plans/p3-acceptance.md` | 新增 | 本文件。 |

## 残余差异 / 后续阶段

1. `runHostChecks`、`prepareHostCheck`：主机巡检执行仍占位，P4 注入采集执行服务后接真。
2. `collectHosts`、`collectionStatus`、`requestUserRefresh`：手动采集/状态/刷新仍占位，P4。
3. users 的 `monitorService`（refresh / plan / execute / scan）：P4/P5。
4. SSH 终端 `SshSessionManager`：P5 真实 PTY 会话。
5. 采集结果落库（snapshot 写入）与调度/定时任务不在本任务范围，路由层通过 deps 边界保持解耦。
6. `probeHost` 采用 `hostKeyPolicy` 取自有效设置（默认 `tofu`）；`host-probe.ts::buildConnectConfig` 内部固定 `insecure`，与 oracle 探测一致性一致——如需强校验在后续阶段统一。

## 复现命令

```bash
pnpm --filter servermonitor-backend typecheck
pnpm --filter servermonitor-backend test
cd backend && npx vitest run test/web/composition.test.ts
python -m pytest -q
```
