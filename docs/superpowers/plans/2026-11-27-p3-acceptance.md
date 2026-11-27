# P3 工程化验收（v0.3.3）

范围：模块化优化第三阶段（工程化）。对应设计 `docs/superpowers/specs/2026-11-26-module-optimization-design.md`
的 P3 段，计划 `docs/superpowers/plans/2026-11-26-p2-module-optimization-plan.md`。

## 已完成

### P3-2 可运维性

| 能力 | 实现 | 入口 |
| --- | --- | --- |
| 请求审计 | `backend/src/storage/audit.ts`（`audit_log` 表，保留 180 天，只记 actor/action/target/ip/result，**不记值**） | `GET /api/system/audit?actor=&action=&limit=`；中间件自动写入 POST/PUT/PATCH/DELETE |
| 粗粒度限流 | `backend/src/web/ops-middleware.ts`（读 600/分钟、写 60/分钟/IP，超出 429；`SERVERMONITOR_DISABLE_RATELIMIT=1` 可关） | 全局中间件 |
| 慢请求日志 | 同一中间件，>500ms 追加 `<logDir>/slow.log` | 文件 |
| 接口文档 | `backend/scripts/gen-api-doc.mjs` 从注册表生成 `docs/API.md`（73 API + 17 页面） | `GET /api/system/endpoints` 提供运行时 JSON；`pnpm --filter servermonitor-backend run api:doc` |

- 迁移：`audit_log(id, actor, action, target, ip, at, result)` + `idx_audit_log_at` / `idx_audit_log_action`；
  `schema.ts` 现 26 表 / 24 索引。
- 测试：`backend/test/web/ops-middleware.test.ts`（6：审计写入/错误结果/限流 429/慢日志/筛选/缺表不抛）、
  `backend/test/web/endpoints.test.ts`（注册表列举）。

### P3-3 质量门禁（增量）

| 能力 | 实现 | 命令 |
| --- | --- | --- |
| Lint | `backend/scripts/lint.mjs`：禁止 `as any` / `@ts-ignore` / `@ts-expect-error`；禁止 `console.log`（`src/server.ts` CLI 输出除外） | `pnpm --filter servermonitor-backend run lint` |
| 性能基准 | `backend/scripts/bench.mjs`：对 6 个核心端点测 p50/p95，p95 > 300ms 失败 | `pnpm --filter servermonitor-backend run bench --base http://127.0.0.1:PORT` |

## 门禁结果

- backend：**126 test files / 2112 passed / 1 skipped**；`tsc --noEmit` 通过；`lint: clean`。
- desktop：**173 passed**；`tsc --noEmit` 通过。
- 版本：0.3.3（`bump-version.mjs --check` 一致）。

## 明确延后（含理由与后续计划）

1. **P3-1 前端 `app.js` 继续拆分**（v0.3.4 已完成第一批：`alert-utils.js` / `view-utils.js` / `alert-table-prefs.js`，`app.js` 由 3460 行降至 3270 行；后续批次继续）：`app.js` 已抽出 `lib/{api,format,ui,debounce}.js`、`pages/{host-views,trend-chart,overview-trends}.js` 等模块，
   剩余约 3.4k 行是单个 IIFE 的页面装配逻辑。继续拆分需要同步迁移事件绑定与状态，回归面大；
   本轮以静态模块守卫测试（`test/web/static-modules.test.ts`、`static-host-views.test.ts`）锁定现有边界，拆分作为独立变更推进。
2. **覆盖率阈值门禁**（v0.3.11 已完成）：引入 `@vitest/coverage-v8`，阈值 语句 84% / 分支 72% / 函数 90% / 行 85%，CI 执行 `test:coverage`。
3. **Playwright GUI E2E**：当前 E2E 以 `backend/test/e2e`（ssh2 桩）+ CDP 脚本覆盖；独立 Playwright 套件待 CI 具备 Electron 图形环境后再接入。

以上三项均记录在案，不阻塞本次发布。
