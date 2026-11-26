# 模块化优化设计（v0.3 系列）

- 日期：2026-11-26（修订 1，已并入 builder-check 与产品决策）
- 基线：v0.2.12（单一 Node/TS 栈，NSIS 安装器 + 在线升级）
- 状态：待用户批准

## 1. 背景与目标

v0.2.12 已完成 Python → Node/TS 的单栈迁移，功能可用，但逐模块审计发现四类问题：

1. **已实现但没接线/后备实现过期**（算力后备实现、我的页数据、报表管理层版无入口）。
2. **缺失的运维闭环**（任务中心、操作审计、通知失败可见性、报表发送历史）。
3. **体验与一致性**（设置项分散、前端 `app.js` 巨石、加载/空/错状态不统一、托盘图标为空）。
4. **工程化缺口**（无 GUI 自动化 E2E、无覆盖率门槛、无 lint、发布无回滚预案）。

本设计把所有后续优化拆成 4 个阶段、11 个模块的改动清单（磁盘多厂商本轮不做），**每个模块独立可验收、独立发布一个补丁版本**，全程保持测试绿。

## 2. 非目标

- 不更换技术栈（Electron + Node/TS + Express + better-sqlite3 保持不变）。
- 不重写页面视觉风格；只做一致性、状态与可用性优化。
- 不做多用户/多租户、集群部署、Linux/macOS 发行。
- 不做代码签名证书采购（继续保持无签名发布 + 文档说明）。
- 不引入重型前端框架（React/Vue）；前端拆分保持原生 ES modules。
- **本轮不做 perccli/megacli 等 storcli 之外的阵列工具解析**（无样例与验收环境，见 §11）。

## 3. 约束

- **测试门禁**：每个模块提交前必须 `pnpm --filter servermonitor-backend typecheck && test` 全绿、`desktop` typecheck + 单测全绿；新增行为必须有回归测试。
- **差分 golden 政策**：`test/diff/http/full-read-diff.test.ts` 的 golden 冻结自 Python，不可再生成。新增字段采用 **oracle 子集比较**：比较器只校验 golden 中存在的键（值仍深比较），新增键由各模块自己的契约测试覆盖；已知值差异继续登记在 `read-allowlist.ts`。该规则写入测试 README，禁止各模块私自放宽 allowlist。
- **数据库**：任何新表/新列必须走 `storage/migrate.ts` 的幂等迁移，迁移前自动备份，失败中止启动；旧库可平滑升级。
- **接口兼容**：不删除已有端点/字段；新增字段只增不改；`ENDPOINTS` 注册表同步更新。
- **安全**：新增写操作必须走 CSRF + 认证 + 用户模式门禁；SSRF 检查复用 `assertSafeTarget`；密钥只存 `app_secrets`（DPAPI）；**审计/历史表只记录键名与“是否改动”，绝不记录值或密钥**。
- **UI 文案**：中文，与现有术语一致（主机/采集/巡检/告警/静默/账号）。
- **发布**：每个阶段结束发一个补丁版本（0.2.13、0.3.0…），Release notes 中文。

## 4. 总体路线

| 阶段 | 主题 | 模块 | 产出 |
|---|---|---|---|
| P0 | 快赢清单（1 天） | M11 托盘图标、M1/M5 算力后备、M7 我的页、M5/M8 报表管理层版入口 | v0.2.13 |
| P1 | 核心监控闭环 | M1 采集可视化与重试、M3 任务中心、M4 告警中心 | v0.3.0 |
| P2 | 功能深度 | M7 账号策略与审计、M5 报表预览与历史、M8 设置中心、M2 数据治理、M11 崩溃日志与更新渠道 | v0.3.1–v0.3.3 |
| P3 | 工程化 | M10 前端拆分、M9 接口文档/审计/限流、M12 GUI E2E 与质量门禁 | v0.3.4 |

阶段内按上表顺序做；每完成一个模块即可发布，不等整阶段结束。

---

## 5. P0 快赢清单

### P0-1 托盘与应用图标（M11）

- 现状：`desktop/src/main/main.ts:262` 用 `nativeImage.createEmpty()` 创建托盘，托盘区无可见图标；`desktop/build/icon.ico` 已存在且 `electron-builder.yml` 的 `win.icon` 已配置。
- 改动：
  - `buildTray()` 改用 `nativeImage.createFromPath(path.join(appRoot,'build','icon.ico'))`（开发态回退到仓库路径），加载失败才回退空图并写日志。
  - `BrowserWindow` 增加 `icon`；`electron-builder.yml` 的 `nsis` 增加 `installerIcon`/`uninstallerIcon`。
  - 单测：图标路径可解析且 `isEmpty() === false`（无 Electron 环境时测路径解析函数）。
- 验收：安装版托盘区可见图标；任务栏/窗口图标正确。

### P0-2 算力后备实现对齐（M1/M5）

- 事实修正：`web/composition.ts:463` 已注入真实 `buildComputeSummary`，打包运行走 `createServerApp` 全量组装，`test/web/composition.test.ts:167-179` 已断言 `totals.tflops > 0`。**线上 `/api/compute` 已经是真实数据**；恒 0 的只是 `pages.ts` 里未注入时的后备 `defaultBuildComputeSummary`。
- 目标：消除两套不一致的实现（后备版 `models: string[]`、`idle_hosts: string[]`；真实版 `models` 是带 `cards/tflops/bandwidth_gbs` 的对象数组），删除「尚未迁移」文案。
- 改动：
  - 以真实版形状为唯一契约：`defaultBuildComputeSummary` 在无注入时调用 `collect/compute.ts` 的 `buildComputeSummary`（空主机集合），或直接返回同形状空结构。
  - 删除 `pages.ts:284` 的「尚未迁移」note，改为「规格表随版本更新」。
  - 契约测试：A100 快照 → `tflops=312`、`bandwidth_gbs=1935`；未知型号 → 0 且 `unknown_gpus>0`；`models` 为对象数组。
- 验收：`/compute` 页与 `/api/compute` 形状一致，A100 数值正确。

### P0-3 「我的」页主机数据（M7）

- 现状：`pages.ts:305` `hosts: []`，TODO 未移植 `_build_users_payload`。
- 改动：
  - `defaultBuildMySummary` 复用 `users.ts` 的 `getAllHostUserSnapshots`/`buildUserRows`/`getUserUsageDeltas`，按 `member_account` 过滤生成 `hosts[]`；`summary` 计数按实际行计算。
  - 成员模式无成员账号时保持空数组并给出提示文案。
  - 单测：seed 两主机、一存在一缺失 → `hosts.length===2`，`present/missing` 正确。
- 验收：`/my` 在有成员账号时显示主机列表与用量。

### P0-4 报表管理层版入口（M5/M8）

- 现状：`report/render.ts` 支持 `executive` 变体；`runtime/wiring.ts:805` 已经 `readBoolean(executive,'enabled', false)` —— **当前生产默认不发管理层版**；但 `config/schema.ts:420-441` 的 `report` 段没有 `executive` 子段，设置页无法查看/编辑。
- 决策（用户已确认）：**默认保持关闭**，升级后不改变现有发送行为；设置页提供开关。
- 改动：
  - `config/schema.ts` report 段新增 `executive` 子段：`enabled`(false)、`subject_prefix`('[Server Executive Report]')、`to_addrs`(string[]，空则回退全量收件人)。
  - `config/defaults.ts` 同步；`config/service.ts` 的 publicSettings 透出该子段（只读密码掩码规则不变）。
  - `settings.html` report 面板增加「同时发送管理层版」复选框与收件人输入。
  - `runtime/wiring.ts` 沿用现有 `executive.enabled` 读取，不新增第二套键。
  - 单测：关闭 → `sendReport` 1 次；开启 → 2 次；`to_addrs` 为空时使用全量。
- 验收：默认升级后发送行为不变；手动开启后多一封管理层邮件。

---

## 6. P1 核心监控闭环

### P1-1 采集可视化与重试（M1）

- 目标：主机详情显示「每个采集阶段耗时 + 成败 + 错误摘要」，失败阶段可重试。
- 改动：
  - `collect/collectors.ts`：`collectHostReport` 产出 `stageTimings: {stage, ms, ok, error?}[]`；失败阶段按 `monitoring.stage_retries`（默认 1，范围 0–3）重试一次。
  - `storage/hosts.ts`：快照新增可选 `stage_timings` JSON 列（幂等迁移；差分按 oracle 子集比较）。
  - `web/routes/overview.ts`：HostDetail 增加 `stage_timings`；`host.html` 增加折叠面板「采集耗时」。
  - 设置 `monitoring` 段新增 `stage_retries`。
- 验收：主机详情显示阶段耗时；人为制造失败可见错误与重试次数；测试覆盖。

### P1-2 任务中心（M3）

- 目标：动态列出当前注册的后台任务（采集/磁盘/用户扫描/日报/周报/清理/备份），显示下次执行、上次结果、耗时，并可手动触发。
- 改动：
  - 新增 `task_runs` 表（task, started_at, finished_at, status, error, trigger: schedule|manual）；保留最近 200 条（prune 任务清理）。
  - 新增 `GET /api/system/tasks`：`[{name, schedule, next_run_at, last_run_at, last_result, running}]`（`running` 由进程内单飞表得出）。
  - 新增 `POST /api/system/tasks/{name}/run`（管理员 + CSRF）：**单飞**——同名任务运行中返回 409 `task_running`；手动运行写 `task_runs` 并更新 `last_run_at`（与调度器共用同一把锁）。
  - `/tasks` 页面 + 导航入口；自动刷新 5s。
  - `runtime/scheduler.ts` 记录耗时并写 `task_runs`。
- 验收：页面列出实际注册任务（随设置动态变化）；手动触发后看到 running→ok；运行中再点返回 409。

### P1-3 告警中心（M4）

- 目标：告警页支持多选、批量确认、快捷静默、按主机/类别筛选，并显示通知投递结果与失败可重发。
- 现状事实：引擎已对「active 且 notified_channels 为空」的告警在下一轮**不消耗冷却地重试**；本模块不新建第二套重试循环，只做**可见性 + 手动重发**。
- 改动：
  - `POST /api/alerts/bulk/ack`（ids[]）、`POST /api/alerts/bulk/silence`（复用现有静默 scope）。
  - `alerts.html`：多选列、批量操作条、筛选器（主机/类别/状态）、投递结果列。
  - 新增 `alert_delivery_failures` 表（alert_id, channel, target, error, at）；notifier 聚合处逐通道记录失败。
  - 新增 `GET /api/alerts/delivery-failures` 与 `POST /api/alerts/{id}/resend`（只重发失败通道）。
- 验收：批量确认 3 条成功；静默后新告警不通知；失败通道可见并可重发。

---

## 7. P2 功能深度

### P2-1 用户账号策略（M7）

- 决策（用户已确认推荐默认）：
  - 命名规范：`^[a-z][a-z0-9_-]{2,15}$`（小写字母开头，3–16 位，允许数字/下划线/连字符）。
  - 内置 3 个权限模板：`standard`（默认附加组）、`developer`（附加组 + sudo 白名单命令）、`readonly`（仅家目录）。
  - 过期：可选「有效期天数」，默认不启用（0=永不过期），实现为 `chage -E <date>`。
- 改动：
  - `config/schema.ts` 的 `user_monitoring` 段新增嵌套 `account_policy`（naming_regex, templates[], default_template, expiry_days）；schema 校验扩展支持对象数组（设置页同步渲染）。
  - `users/admin.ts`：`buildPlan` 读取策略，命名不合规直接 `blocked`；模板决定附加组与 sudo 步骤；`expiry_days>0` 追加 `chage` 步骤。
  - 设置页 user_monitoring 面板增加策略编辑（正则只读展示 + 模板列表编辑）。
  - 回归：不合规账号 blocked；developer 模板生成附加组+sudo 步骤；过期 90 天生成 chage 步骤。
- 验收：设置页可编辑模板；创建账号按模板与命名规范执行。

### P2-2 报表预览与发送历史（M5）

- 改动：
  - 新增 `report_runs` 表（kind, variant, status, error, sent_at, recipients）；`wiring.ts` 发送后写入。
  - `GET /api/reports/preview?variant=technical|executive|weekly`（管理员；返回 HTML/文本片段；iframe sandbox 渲染）。
  - `GET /api/reports/history`（最近 50 条）。
  - 设置页 report 面板增加「预览」「立即发送」「发送历史」。
- 验收：预览内容与邮件一致；成功/失败均有记录；失败可手动重发。

### P2-3 设置中心改版（M8）

- 改动：
  - `settings.html`/`settings.js`：左侧分组导航 + 搜索框；字段级校验提示；未保存离开提醒；保存按钮 sticky。
  - 新增 `config_history` 表（section, changed_keys JSON, changed_by, changed_at）；**只记录键名与是否改动，不记录值**；保留 90 天。
  - 设置页底部「最近变更」列表（最多 20 条）。
- 验收：搜索「超时」定位字段；非法端口即时红字；保存成功 toast；变更历史可见且无密钥值。

### P2-4 数据治理与备份（M2）

- 改动：
  - `monitoring` 段新增 `retention` 子段（metrics_days 90 / alerts_days 180 / disk_days 30 / users_days 180），prune 任务按新值执行。
  - 新增 `backup_schedule`（off/daily/weekly）与 `backup_keep`（默认 7）；backup 任务写 `backups/auto-<date>.db` 并按份数清理。
  - `GET /api/system/storage` 增加 `db_size_history`（每日采样，存 `storage_samples` 表，保留 180 天）；设置页展示体积趋势。
  - 磁盘健康趋势：**只做主机级 status 曲线**，窗口取现有保留期（默认 7 天），不足时页面提示「保留期不足」；不做 PD/VD 明细历史表。
- 验收：修改保留天数后 prune 生效；备份文件按计划生成；体积曲线可见。

### P2-5 桌面健壮性（M11）

- 改动：
  - 主进程捕获 `uncaughtException`/`render-process-gone`，写 `logs/crash-<ts>.log`；托盘菜单「打开日志目录」保留并增强为打开最新 crash 文件所在目录。
  - 更新页显示当前/最新版本与更新渠道（stable）；检查失败可重试并给出日志路径。
  - 启动自检：数据目录可写、端口可用、后端健康 3 次失败弹窗并给日志路径。
- 验收：模拟后端崩溃有 crash 日志；更新失败有明确提示与日志入口。

---

## 8. P3 工程化

### P3-1 前端拆分（M10）

- 目标：`app.js` 从 3,460 行拆为「请求层 + 路由 + 页面控制器」，行为不变。
- 改动：
  - `lib/api.js`（统一 fetch/CSRF/错误 toast；已存在同名文件则扩展）、`lib/state.js`、`pages/overview.js`、`pages/hosts.js`、`pages/alerts.js` 等控制器。
  - 保留现有 DOM id 与模板，逐页迁移；每迁一页跑接口冒烟 + CDP 检查。
  - 本轮不引入 esbuild 打包，保持原生 ESM。
- 验收：全部页面无回归；`app.js` < 400 行；静态模块检查测试通过。

### P3-2 接口文档与审计（M9）

- 改动：
  - `scripts/gen-openapi.mjs` 由 `registry.ts` + 路由元数据生成 `docs/openapi.json`。
  - 新增 `audit_log` 表（actor, action, target, ip, at, result）；在设置保存、主机增删、备份恢复、账号写操作、静默操作处写入；**不记录值/密钥**；保留 180 天；新增 `/api/system/audit` 与设置页「操作审计」。
  - `express-rate-limit`：读接口 600/min、写接口 60/min；登录保持 5/60s。
  - 中间件记录 >500ms 请求到 `logs/slow.log`。
- 验收：OpenAPI 可导入 Postman；审计可按人/动作筛选；压测触发 429。

### P3-3 质量门禁（M12）

- 改动（增量式，避免一次性全仓格式化）：
  - ESLint + Prettier：先只对 `backend/src`、`desktop/src`、`backend/assets/web/static/lib|pages` 生效，vendor/历史巨石逐步纳入；CI 先 `--max-warnings 0` 对新文件，存量文件走 ignore。
  - 覆盖率：`@vitest/coverage-v8`，阈值先设「不低于当前基线」（基线由 CI 首次运行记录到 `docs/coverage-baseline.md`），之后每次只许升不许降。
  - Playwright 5 条冒烟：setup→登录、概览渲染、主机列表、设置保存、终端打开；**终端用仓库现有 ssh2 stub 服务**（`backend/test/e2e` 已有桩），不依赖真实 sshd。
  - 性能基准：采集 5 主机耗时、`/api/overview` P95、首屏；结果写 `docs/perf-baseline.md`。
- 验收：CI 三道新门禁全绿；性能基准可重复运行。

---

## 9. 模块验收汇总

| 模块 | 阶段 | 关键验收 |
|---|---|---|
| M11 托盘/图标 | P0 | 托盘可见图标；安装版任务栏图标正确 |
| M1/M5 算力后备 | P0 | `/api/compute` 与 `/compute` 同形状；A100 tflops=312、bandwidth=1935 |
| M7 我的页 | P0 | 有成员账号时显示主机与用量 |
| M5/M8 报表开关 | P0 | 默认关闭、升级行为不变；开启后多发一封 |
| M1 采集可视化 | P1 | 阶段耗时 + 失败重试可见 |
| M3 任务中心 | P1 | 动态任务列表、手动触发、单飞 409 |
| M4 告警中心 | P1 | 批量确认/静默、失败通道可重发 |
| M7 账号策略 | P2 | 命名不合规 blocked；模板与过期生效 |
| M5 报表 | P2 | 预览/立即发送/历史 |
| M8 设置中心 | P2 | 搜索、校验、脏状态、变更历史（无密钥值） |
| M2 数据治理 | P2 | 保留策略生效、自动备份、体积趋势 |
| M11 桌面健壮性 | P2 | 崩溃日志、更新失败提示 |
| M10 前端拆分 | P3 | app.js < 400 行、页面零回归 |
| M9 接口/审计 | P3 | OpenAPI、审计页、限流 429 |
| M12 质量 | P3 | E2E 5 条、覆盖率只升不降、lint |

## 10. 交付与发布节奏

- P0 完成 → v0.2.13
- P1 完成 → v0.3.0
- P2 每 1–2 个模块 → v0.3.1 / v0.3.2 / v0.3.3
- P3 完成 → v0.3.4
- 每个版本：CHANGELOG 中文条目 + Release notes + 在线升级验证。

## 11. 风险与已裁定事项

1. **迁移风险**：新增列/表用幂等迁移 + 迁移前备份 + 旧库副本测试。
2. **差分 golden**：新增字段按 oracle 子集比较（§3），避免门禁腐化。
3. **报表管理层版**：默认关闭，避免升级群发事故（用户已确认）。
4. **磁盘多厂商**：本轮不做（无样例与验收环境）；探测到 perccli/megacli 时仅展示原始输出（可后续补解析）。
5. **账号策略**：命名正则与模板若过严会阻断运维；提供「管理员可改正则」与模板停用开关。
6. **前端拆分**：用静态模块检查 + 逐页 CDP 冒烟兜底（此前已两次因拆分漏引用出问题）。
7. **范围蔓延**：每模块只做本设计列出的改动，新增需求另立设计。

## 12. 已由实现者决定的事项

- 任务中心放独立导航「任务」；手动触发单飞，运行中 409；历史写 `task_runs`。
- 通知重试只做可见性与手动重发，不另建重试队列。
- 磁盘趋势只做主机级 status，窗口依保留期。
- 审计/变更历史只存键名与是否改动，不存值；保留 90–180 天。
- lint/覆盖率采用增量门禁，不一次性全仓格式化。
- 终端 E2E 用仓库现有 ssh2 桩，不依赖真实 sshd。
- OpenAPI 从路由注册表生成，手写补充字段说明。