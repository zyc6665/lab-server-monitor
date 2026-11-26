# P0 模块优化验收（v0.2.13）

日期：2026-11-26
设计：`docs/superpowers/specs/2026-11-26-module-optimization-design.md`
计划：`docs/superpowers/plans/2026-11-26-p0-module-optimization-plan.md`
基线：v0.2.12（HEAD 30b505b）

## 交付项

| 任务 | 改动 | 验收 |
| --- | --- | --- |
| T1 托盘/窗口图标 | `desktop/src/main/icon.ts`（`resolveIconPath`/`loadAppIcon`，惰性 require electron）；`main.ts` 托盘与窗口使用 `loadAppIcon()`；`electron-builder.yml` extraResources `build/icon.ico`，nsis `installerIcon`/`uninstallerIcon` | `desktop/test-unit/icon.test.ts` 3 例；打包产物 `resources/icon.ico` 存在；托盘不再为空图标 |
| T2 算力后备委托真实构建器 | `backend/src/web/routes/pages.ts` 的 `defaultBuildComputeSummary` 删除自带聚合，改为 `buildComputeSummary(getAllHostSnapshots(db), {servers: config.servers.map(...)})` | `test/web/pages-compute.test.ts`：A100 → `totals.tflops=312`、`hosts[0].tflops=312`、`models[0].tier='training'`、notes 不含“尚未迁移”；`test/web/pages.test.ts` 期望更新为真实数值 |
| T3 `/my` 成员数据 | `backend/src/web/routes/users.ts` 新增 `buildMyAccountsPayload({db,config})`；`pages.ts` 的 `defaultBuildMySummary` 委托之 | `test/web/pages-my.test.ts` 3 例：成员账号主机 1 台、管理员空成员 0 台、页面渲染 |
| T4 report.executive 设置入口 | `config/schema.ts` report 增 `executive{enabled(strictBool), subject_prefix, to_addrs}`；`settings.html` 3 个控件；`config/service.ts` `publicSettings` 投影 + `saveSection` report 分支合并已存配置（部分保存不清空兄弟键） | `test/config/report-executive.test.ts` 7 例；`/settings` 渲染断言；`defaults.test.ts` 默认值；`/api/settings` 差分标注 known difference |
| T5 验收与发版 | 本文件；CHANGELOG v0.2.13；版本号 0.2.13 | 后端 109 文件 / 1982 passed / 1 skipped；桌面 132 passed；安装包冒烟 |

## 门禁证据

- `pnpm --filter servermonitor-backend typecheck` → exit 0
- `pnpm --filter servermonitor-backend test` → **109 files / 1982 passed / 1 skipped**
- `cd desktop && pnpm exec tsc --noEmit` → exit 0
- `cd desktop && pnpm run test:unit` → **132 passed**
- 差分：`/api/settings` 由 exact 调整为 known difference（Node 新增 `report.executive` 字段），矩阵 12 exact / 3 known；golden 未改动。

## 已知差异 / 说明

- `report.executive` 为 Node 侧新增字段，Python 冻结 golden 无对应键；按 oracle 子集政策不做 exact 比较。
- 管理层摘要版日报生产默认仍为关闭（`runtime/wiring.ts` `readBoolean(executive,'enabled', false)`），设置页仅提供开关。
- 托盘图标依赖 `nativeImage.createFromPath`；开发态路径回退到仓库 `build/icon.ico`，打包态读取 `resources/icon.ico`。