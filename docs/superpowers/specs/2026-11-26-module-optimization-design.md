# 模块化优化设计（v0.3 系列）

- 日期：2026-11-26
- 基线：v0.2.12（单一 Node/TS 栈，NSIS 安装器 + 在线升级）
- 状态：待审核

## 1. 背景与目标

v0.2.12 已完成 Python → Node/TS 的单栈迁移，功能可用，但逐模块审计发现四类问题：

1. **已实现但没接线**（算力规格、我的页数据、报表管理层版开关）。
2. **缺失的运维闭环**（任务中心、操作审计、通知失败重试、报表发送历史）。
3. **体验与一致性**（设置项分散、前端 `app.js` 巨石、加载/空/错状态不统一、托盘图标为空）。
4. **工程化缺口**（无 GUI 自动化 E2E、无覆盖率门槛、无 lint、发布无回滚预案）。

本设计把所有后续优化拆成 4 个阶段、12 个模块的改动清单，**每个模块独立可验收、独立发布一个补丁版本**，全程保持测试绿。

## 2. 非目标

- 不更换技术栈（Electron + Node/TS + Express + better-sqlite3 保持不变）。
- 不重写页面视觉风格；只做一致性、状态与可用性优化。
- 不做多用户/多租户、集群部署、Linux/macOS 发行。
- 不做代码签名证书采购（继续保持无签名发布 + 文档说明）。
- 不引入重型前端框架（React/Vue）；前端拆分保持原生 ES modules。

## 3. 约束

- **测试门禁**：每个模块提交前必须 `pnpm --filter servermonitor-backend typecheck && test` 全绿、`desktop` typecheck + 单测全绿；新增行为必须有回归测试。
- **数据库**：任何新表/新列必须走 `storage/migrate.ts` 的幂等迁移，迁移前自动备份，失败中止启动；旧库可平滑升级。
- **接口兼容**：不删除已有端点/字段；新增字段只增不改；`ENDPOINTS` 注册表同步更新。
- **安全**：新增写操作必须走 CSRF + 认证 + 用户模式门禁；SSRF 检查复用 `assertSafeTarget`；密钥只存 `app_secrets`（DPAPI）。
- **UI 文案**：中文，与现有术语一致（主机/采集/巡检/告警/静默/账号）。
- **发布**：每个阶段结束发一个 minor 补丁（0.3.0、0.3.1…），Release notes 中文。

## 4. 总体路线

| 阶段 | 主题 | 模块 | 产出 |
|---|---|---|---|
| P0 | 快赢清单（1 天） | M11 托盘图标、M1/M5 算力规格、M7 我的页、M5/M8 报表管理层版 | v0.2.13 |
| P1 | 核心监控闭环 | M1 采集可视化与重试、M3 任务中心、M4 告警中心 | v0.3.0 |
| P2 | 功能深度 | M7 账号策略与审计、M6 磁盘多厂商与趋势、M5 报表预览与历史、M8 设置中心、M2 数据治理、M11 崩溃日志与更新渠道 | v0.3.1–v0.3.3 |
| P3 | 工程化 | M10 前端拆分、M9 接口文档/审计/限流、M12 GUI E2E 与质量门禁 | v0.3.4 |

阶段内按上表顺序做；每完成一个模块立即可发布，不等整阶段结束。

---

## 5. P0 快赢清单

### P0-1 托盘与应用图标（M11）

- 现状：`desktop/src/main/main.ts:262` 用 `nativeImage.createEmpty()` 创建托盘，托盘区无可见图标；应用窗口图标也为默认。
- 目标：托盘显示正式图标，点击/双击行为不变；窗口与任务栏显示应用图标。
- 改动：
  - 新增 `desktop/assets/icon.ico`（多尺寸）与 `desktop/assets/tray.png`（16/32px，深浅色各一版可选）。
  - `main.ts` 用 `nativeImage.createFromPath` 加载托盘图标；`BrowserWindow` 设 `icon`。
  - `electron-builder.yml` 的 `nsis`/`win` 增加 `icon` 指向 ico。
  - 单测：断言托盘加载路径存在且非空图（`isEmpty() === false`）。
- 验收：安装版托盘区可见图标；任务栏/窗口图标正确；单测通过。

### P0-2 算力规格接线（M1/M5）

- 现状：`web/routes/pages.ts:274-285` 的 `tflops/pf16/bandwidth_gbs` 恒为 0，notes 里写着「尚未迁移」；但 `collect/compute.ts` 已有 `GPU_SPECS`（15 项）与 `specFor`。
- 目标：算力页按实际 GPU 型号展示 FP16 峰值、显存带宽、按 tier 汇总。
- 改动：
  - `buildComputeSummary` 已产出 models/tier；在 `pages.ts` 的 cards/totals 里用 `specFor(model)` 计算加权 `tflops`、`bandwidth_gbs`、`pf16`（pf16 与 tflops 同源或按规格表字段）。
  - 删除「尚未迁移」note，改为「规格表随版本更新」。
  - 单测：A100 快照 → tflops=312、bandwidth=1935；未知型号 → 0 且标注 unknown。
- 验收：`/api/compute` 与 `/compute` 页显示非零算力，数值与规格表一致。

### P0-3 「我的」页主机数据（M7）

- 现状：`pages.ts:305` `hosts: []`，TODO 未移植 `_build_users_payload`；页面显示空列表。
- 目标：成员模式下展示本人账号在各主机的状态（存在/缺失/异常、家目录与数据目录用量）。
- 改动：
  - 复用 `users.ts` 已有的 `buildUserRows`/`getAllHostUserSnapshots`/`getUserUsageDeltas`，在 `defaultBuildMySummary` 中按 `member_account` 过滤生成 hosts[]。
  - `summary` 计数按实际行计算。
  - 单测：seed 两主机、一存在一缺失 → hosts 长度 2、present/missing 正确。
- 验收：`/my` 页面在有成员账号时显示主机列表与用量。

### P0-4 报表管理层版开关（M5/M8）

- 现状：`report/render.ts` 支持 `executive` 变体，`wiring.ts` 也会双发，但设置 schema 的 `report` 段没有开关，用户无法关闭/开启。
- 目标：设置页可勾选「同时发送管理层版」。
- 改动：
  - `config/schema.ts` report 段新增 `send_executive: boolean`（默认 true，保持现状）；`defaults.ts` 同步。
  - `runtime/wiring.ts` 按该开关决定是否生成/发送 executive 版本。
  - `settings.html` report 面板加复选框；模板沿用现有字段组件。
  - 单测：关闭后 `sendReport` 只调用一次；开启后两次。
- 验收：设置页可切换；日报发送行为随之变化。

---

## 6. P1 核心监控闭环

### P1-1 采集可视化与重试（M1）

- 目标：主机详情能看到「每个采集阶段耗时 + 成败 + 错误摘要」，并可对失败阶段配置重试。
- 改动：
  - `collect/collectors.ts`：`collectHostReport` 记录 `stageTimings: {stage, ms, ok, error?}[]`，结果写入 `HostReport`；失败阶段按 `monitoring.stage_retries`（默认 1）重试一次。
  - `storage/hosts.ts`：快照新增可选 `stage_timings` JSON 列（迁移）。
  - `web/routes/overview.ts`：HostDetail 增加 `stage_timings`；`host.html` 增加「采集耗时」折叠面板。
  - 设置 `monitoring` 段新增 `stage_retries`（0–3，默认 1）。
- 验收：主机详情显示 21 阶段耗时；人为让某阶段失败可见错误与重试次数；测试覆盖。

### P1-2 任务中心（M3）

- 目标：一个页面看清 6 类后台任务的下次执行、上次结果、耗时，并可手动触发。
- 改动：
  - 新增 `GET /api/system/tasks`：返回 `[{name, interval, next_run_at, last_run_at, last_result, last_duration_ms}]`（`task_state` 已存 last_run/last_result，新增 `last_duration_ms` 列）。
  - 新增 `POST /api/system/tasks/{name}/run`（管理员 + CSRF）：立即执行一次，返回 job id；状态轮询复用 `GET /api/system/tasks`。
  - 新增 `/tasks` 页面 + 导航入口（设置页或系统页内）。
  - `runtime/scheduler.ts` 记录耗时；`wiring.ts` 注册任务名常量。
  - 首页/健康接口附带「上次采集时间、延迟」摘要。
- 验收：页面列出 6 个任务；手动触发采集后 30 秒内看到 last_result=ok；失败任务显示 error。

### P1-3 告警中心（M4）

- 目标：告警页支持批量确认、快捷静默、按主机/类别筛选，并展示通知投递结果。
- 改动：
  - `POST /api/alerts/bulk/ack`（ids[]）、`POST /api/alerts/bulk/silence`（scope 参数复用现有静默）。
  - `alerts.html` 增加多选、批量操作条、筛选器（主机/类别/状态）。
  - `alerts/engine.ts` 的 `notified_channels` 在列表接口暴露为 `channels: string[]`。
  - 通知失败重试：`notify_webhook`/`mailer` 失败记录到 `alert_delivery_failures` 表，任务中心提供「重试失败通知」。
- 验收：勾选 3 条告警批量确认成功；静默后新告警不再通知；失败通知可重试。

---

## 7. P2 功能深度

### P2-1 用户账号策略与审计（M7）

- 目标：账号命名规范校验、权限模板（附加组/sudo）、创建时可选过期；操作历史可查详情。
- 改动：
  - `users/admin.ts`：`buildPlan` 增加 `policy`（命名正则、附加组、sudo 选项、过期天数）；模板存 `user_monitoring.account_templates`。
  - 设置页 user_monitoring 段增加模板编辑。
  - 操作记录页：`/api/users/operations` 已有，增加详情抽屉（命令脱敏、耗时、结果）。
- 验收：不符合命名规范时 plan 直接 blocked；按模板创建账号附加组正确；操作历史可展开。

### P2-2 磁盘多厂商与趋势（M6）

- 目标：支持 storcli/perccli/megacli 自动探测；磁盘健康历史趋势图。
- 改动：
  - `disk/collect.ts` 探测顺序 storcli → perccli → megacli；解析器按工具分支（先支持 perccli JSON，megacli 文本次之）。
  - `disk_health_snapshot` 已有历史表，补 `GET /api/disk-health/history?host=&range=`；页面加趋势图（复用 `pages/trend-chart.js`）。
- 验收：无 storcli 但有 perccli 的主机能出磁盘健康；趋势图显示 7/30 天。

### P2-3 报表预览与发送历史（M5）

- 目标：设置页可预览日报/周报、手动立即发送、查看发送历史与失败原因。
- 改动：
  - 新增 `GET /api/reports/preview?variant=`（返回 HTML/文本片段，权限同设置页）。
  - 新增 `report_runs` 表（kind, variant, status, error, sent_at, recipients）；`wiring.ts` 发送后写入。
  - 新增 `GET /api/reports/history`；设置页 report 面板加「预览」「立即发送」「历史」。
- 验收：预览内容与邮件一致；发送成功/失败均有记录；失败可重试。

### P2-4 设置中心改版（M8）

- 目标：设置页可搜索、分组清晰、即时校验、脏状态提示、保存前确认。
- 改动：
  - `settings.html`/`settings.js`：左侧分组导航 + 搜索框；字段级校验提示；未保存离开提醒；保存按钮 sticky。
  - 后端 `PUT /api/settings/{section}` 已返回 errors，前端逐字段展示。
  - 新增「配置变更历史」表 `config_history`（section, changed_by, changed_at, diff 摘要），设置页可查看最近 20 条。
- 验收：搜索「超时」能定位字段；非法端口即时红字；保存成功有 toast；历史可见。

### P2-5 数据治理与备份（M2）

- 目标：保留策略可视化、定时备份、数据体积趋势。
- 改动：
  - `monitoring` 段新增 `retention_days`（指标/告警/磁盘/用户分别）、`backup_schedule`（daily/weekly/off）。
  - `runtime/wiring.ts` 增加 backup 任务，写 `backups/auto-<date>.db`，保留最近 N 份。
  - `/api/system/storage` 增加 `db_size_history`（每日采样，存 `storage_samples` 表）；设置页展示体积趋势。
- 验收：修改保留天数后 prune 按新值执行；备份文件按计划生成；体积曲线可见。

### P2-6 桌面健壮性（M11）

- 目标：崩溃可诊断、更新可回滚、启动自检。
- 改动：
  - 主进程捕获 `uncaughtException`/`render-process-gone`，写 `logs/crash-<ts>.log`；托盘菜单加「打开日志目录」（已有则增强）。
  - 更新页增加「当前版本/最新版本/更新渠道（stable）」与「重试检查」；安装失败回滚：保留上一版本安装包路径，失败时提示手动重装。
  - 启动自检：数据目录可写、端口可用、后端健康检查 3 次失败则弹窗给日志路径。
- 验收：模拟后端崩溃有 crash 日志；更新失败有明确提示与日志入口。

---

## 8. P3 工程化

### P3-1 前端拆分（M10）

- 目标：`app.js` 从 3,460 行拆为「请求层 + 路由 + 页面控制器」，行为不变。
- 改动：
  - 新增 `lib/api.js`（统一 fetch/CSRF/错误 toast）、`lib/state.js`（页面级状态）、`pages/overview.js`、`pages/hosts.js`、`pages/alerts.js` 等控制器。
  - 保留现有 DOM id 与模板，逐页迁移；每迁一页用现有接口冒烟 + 手动 CDP 检查。
  - 引入 `esbuild` 打包静态资源（可选，若影响模板加载则改为原生 module 直出）。
- 验收：全部页面无回归；`app.js` < 400 行；新增静态模块检查测试通过。

### P3-2 接口文档与审计（M9）

- 目标：OpenAPI 文档、管理操作审计、全局限流、慢请求日志。
- 改动：
  - 由 `registry.ts` + 路由注册生成 `docs/openapi.json`（脚本 `scripts/gen-openapi.mjs`）。
  - 新增 `audit_log` 表（actor, action, target, ip, at, result）；在设置保存、主机增删、备份恢复、账号写操作、静默操作处写入；新增 `/api/system/audit` 查询页。
  - `express-rate-limit` 全局（读接口 600/min、写接口 60/min），登录保持 5/60s。
  - 中间件记录 >500ms 的请求到 `logs/slow.log`。
- 验收：OpenAPI 可导入 Apifox/Postman；审计页可按人/动作筛选；压测触发限流返回 429。

### P3-3 质量门禁（M12）

- 目标：GUI 自动化 E2E、覆盖率门槛、lint、性能基准。
- 改动：
  - Playwright 冒烟 5 条：setup→登录、概览渲染、主机列表、设置保存、终端打开。
  - CI 增加 `pnpm lint`（ESLint + Prettier check）与覆盖率阈值（行 ≥70%，关键模块 ≥85%）。
  - 性能基准脚本：采集 5 主机耗时、/api/overview P95、首页首屏；结果写入 `docs/perf-baseline.md`。
- 验收：CI 三道新门禁全绿；性能基准可重复运行。

---

## 9. 模块验收汇总

| 模块 | 阶段 | 关键验收 |
|---|---|---|
| M11 托盘/图标 | P0 | 托盘可见图标；安装版任务栏图标正确 |
| M1/M5 算力 | P0 | A100 tflops=312、bandwidth=1935 |
| M7 我的页 | P0 | 有成员账号时显示主机与用量 |
| M5/M8 报表开关 | P0 | 关闭后只发技术版 |
| M1 采集可视化 | P1 | 21 阶段耗时 + 失败重试可见 |
| M3 任务中心 | P1 | 6 任务状态可见、可手动触发 |
| M4 告警中心 | P1 | 批量确认/静默、通知失败可重试 |
| M7 账号策略 | P2 | 命名不合规 blocked；模板生效 |
| M6 磁盘 | P2 | perccli 可用；趋势图 7/30 天 |
| M5 报表 | P2 | 预览/立即发送/历史 |
| M8 设置中心 | P2 | 搜索、校验、脏状态、变更历史 |
| M2 数据治理 | P2 | 保留策略生效、自动备份、体积趋势 |
| M11 桌面健壮性 | P2 | 崩溃日志、更新失败提示 |
| M10 前端拆分 | P3 | app.js < 400 行、页面零回归 |
| M9 接口/审计 | P3 | OpenAPI、审计页、限流 429 |
| M12 质量 | P3 | E2E 5 条、覆盖率门槛、lint |

## 10. 交付与发布节奏

- P0 完成 → 发 v0.2.13（快赢）
- P1 完成 → 发 v0.3.0（核心监控闭环）
- P2 每 1–2 个模块 → 发 v0.3.1 / v0.3.2 / v0.3.3
- P3 完成 → 发 v0.3.4（工程化）
- 每个版本：CHANGELOG 中文条目 + Release notes + 在线升级验证。

## 11. 风险

1. **迁移风险**：新增列/表需要迁移；用幂等迁移 + 迁移前备份 + 旧库副本测试覆盖。
2. **前端拆分回归**：`app.js` 拆分可能引入模块引用遗漏（已发生过两次）；用静态模块检查 + 逐页 CDP 冒烟兜底。
3. **设置 schema 扩展**：新增字段必须给默认值，否则旧配置读取失败；`DEFAULT_SETTINGS` 深合并兜底。
4. **报表 executive 默认值**：默认保持 true，避免升级后行为突变。
5. **范围蔓延**：每模块只做本设计列出的改动，新增需求另立设计。

## 12. 留给实现者的决定

- 任务中心页面放在「设置 → 系统」内还是独立导航项（默认独立导航「任务」）。
- 磁盘趋势图复用现有 SVG 趋势组件还是新写一个轻量图（默认复用）。
- 前端是否引入 esbuild 打包（默认先不引入，保持原生 ESM，拆分优先）。
- OpenAPI 生成方式（手写 schema vs 从路由注解生成；默认从路由注册表 + 手写补充生成）。