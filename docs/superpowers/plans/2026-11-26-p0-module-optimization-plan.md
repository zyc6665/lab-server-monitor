# P0 模块优化（快赢）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉四个影响日常使用的快赢缺口（托盘无图标、算力 tflops 恒 0、`/my` 无数据、报表管理层版无设置入口），发布 v0.2.13。

**Architecture:** 全部为既有模块内的定点补齐，不新增子系统：桌面端新增纯函数 `icon.ts` 并由 `main.ts` 使用；后端把 `pages.ts` 里"未迁移"的后备实现换成真实构建器（委托 `collect/compute.ts`）或新增 `users.ts` 的成员视图构建器；报表 `executive` 配置补进 schema 与设置页模板。

**Tech Stack:** TypeScript、Express、better-sqlite3、Nunjucks、Electron、vitest（后端 + 桌面单测）。

**Spec:** `docs/superpowers/specs/2026-11-26-module-optimization-design.md`

## Global Constraints

- 仅 TypeScript/Node，不引入 Python、不新增运行时依赖。
- 中文文案与既有风格一致；错误信息沿用现有中文措辞。
- 源文件保持 LF 行尾（仓库为 LF）。
- 门禁命令：后端 `pnpm --filter servermonitor-backend typecheck` 与 `pnpm --filter servermonitor-backend test`；桌面 `cd desktop && pnpm run typecheck && pnpm run test:unit`。
- 版本三处（root/backend/desktop `package.json`）用 `node scripts/bump-version.mjs <ver>` 同步。
- 既有 API 契约只增字段、不改已有字段名与语义。

## Review Focus

1. `/my`：`monitoring.member_account` 为空时返回 `hosts: []`，页面显示空态，不抛错、不泄漏其他账号。
2. 算力：未知 GPU 型号的主机 `tflops` 记 0、`tier` 为 `unknown`，`totals` 不得出现 `NaN` 或负值。
3. 报表：只提交 `report.executive.enabled` 时，已保存的 `subject_prefix`/`to_addrs` 不得被清空。
4. 图标：开发态读 `desktop/build/icon.ico`、打包态读 `resources/icon.ico`；文件缺失时退回空图标且不崩溃。
5. 设置页：`executive.to_addrs` 以逗号/分号字符串提交后，DB 中应存为字符串数组。

---

### Task 1: 托盘与窗口应用图标

**Files:**
- Create: `desktop/src/main/icon.ts`
- Modify: `desktop/src/main/main.ts`（`createWindow` 的 BrowserWindow 选项、`createTray`/`ensureTray` 的 `new Tray(...)`）
- Modify: `desktop/electron-builder.yml`（`extraResources` 增加 `build/icon.ico` → `icon.ico`）
- Test: `desktop/test-unit/icon.test.ts`

**Interfaces:**
- Consumes: 无（纯新增）。
- Produces:
  - `resolveIconPath(opts: { packaged: boolean; dirname: string; resourcesPath: string; exists?: (path: string) => boolean }): string | null`
  - `loadAppIcon(opts?: { packaged?: boolean; dirname?: string; resourcesPath?: string }): Electron.NativeImage | null`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { resolveIconPath } from '../src/main/icon';

const exists = (paths: string[]) => (p: string) => paths.includes(p);

describe('resolveIconPath', () => {
  it('uses resourcesPath/icon.ico when packaged', () => {
    const p = resolveIconPath({
      packaged: true,
      dirname: 'C:/app/dist',
      resourcesPath: 'C:/app/resources',
      exists: exists(['C:/app/resources/icon.ico']),
    });
    expect(p).toBe('C:/app/resources/icon.ico');
  });

  it('uses build/icon.ico in development', () => {
    const p = resolveIconPath({
      packaged: false,
      dirname: 'D:/repo/desktop/dist',
      resourcesPath: 'D:/repo/desktop/node_modules/electron/dist/resources',
      exists: exists(['D:/repo/desktop/build/icon.ico']),
    });
    expect(p).toBe('D:/repo/desktop/build/icon.ico');
  });

  it('returns null when the icon is missing', () => {
    expect(
      resolveIconPath({ packaged: true, dirname: '/a', resourcesPath: '/a/r', exists: () => false }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd desktop && pnpm exec vitest run test-unit/icon.test.ts`
Expected: FAIL — `Cannot find module '../src/main/icon'`

- [ ] **Step 3: 实现 `desktop/src/main/icon.ts`**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { nativeImage, type NativeImage } from 'electron';

export function resolveIconPath(opts: {
  packaged: boolean;
  dirname: string;
  resourcesPath: string;
  exists?: (path: string) => boolean;
}): string | null {
  const exists = opts.exists ?? existsSync;
  const candidate = opts.packaged
    ? join(opts.resourcesPath, 'icon.ico')
    : join(opts.dirname, '..', '..', 'build', 'icon.ico');
  return exists(candidate) ? candidate : null;
}

export function loadAppIcon(opts?: {
  packaged?: boolean;
  dirname?: string;
  resourcesPath?: string;
}): NativeImage | null {
  const resolved = resolveIconPath({
    packaged: opts?.packaged ?? false,
    dirname: opts?.dirname ?? __dirname,
    resourcesPath: opts?.resourcesPath ?? process.resourcesPath,
  });
  if (!resolved) return null;
  const image = nativeImage.createFromPath(resolved);
  return image.isEmpty() ? null : image;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd desktop && pnpm exec vitest run test-unit/icon.test.ts`
Expected: PASS（3 例）

- [ ] **Step 5: 在 `main.ts` 使用图标**

`createWindow` 的 `new BrowserWindow({...})` 增加：`icon: loadAppIcon() ?? undefined`。
`createTray`/`ensureTray` 中把 `new Tray(nativeImage.createEmpty())` 改为：

```ts
const appIcon = loadAppIcon();
const tray = new Tray(appIcon ?? nativeImage.createEmpty());
```

（`nativeImage` 若因此不再被引用，删除对应 import。）

- [ ] **Step 6: 打包配置带上图标**

`desktop/electron-builder.yml` 的 `extraResources:` 列表增加一项：

```yaml
  - from: build/icon.ico
    to: icon.ico
```

- [ ] **Step 7: 验证并提交**

Run: `cd desktop && pnpm run typecheck && pnpm run test:unit && pnpm run build:main`
Expected: typecheck 0；全部单测通过；`dist/main.cjs` 生成。

```bash
git add desktop/src/main/icon.ts desktop/src/main/main.ts desktop/electron-builder.yml desktop/test-unit/icon.test.ts
git commit -m "feat(desktop): use the packaged app icon for tray and window"
```

---

### Task 2: 算力后备构建器与真实构建器统一

**Files:**
- Modify: `backend/src/web/routes/pages.ts`（`defaultBuildComputeSummary`，并删除其内部重复聚合代码）
- Test: `backend/test/web/pages-compute.test.ts`

**Interfaces:**
- Consumes: `buildComputeSummary(snapshots, { servers })`（`backend/src/collect/compute.ts`）、`getAllHostSnapshots(db)`、`specFor`（间接）。
- Produces: `defaultBuildComputeSummary(db: SqliteDatabase, config: AppConfig): unknown` —— 返回结构与 `buildComputeSummary` 完全一致。

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/web/pages-compute.test.ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { saveHostSnapshot } from '../../src/storage/hosts';
import { defaultBuildComputeSummary } from '../../src/web/routes/pages';
import { loadConfig } from '../../src/config/config';

it('fallback compute summary reports real tflops for known GPUs', () => {
  const db = openDatabase(':memory:');
  initSchema(db);
  saveHostSnapshot(db, {
    host_name: 'gpu-01',
    collected_at: '2026-11-26T00:00:00.000000+00:00',
    metrics: {
      gpu_summary: [
        { name: 'NVIDIA A100-SXM4-80GB', memory_total_mb: 81920, memory_used_mb: 4096, utilization_percent: 10 },
      ],
      gpu_processes: [],
    },
  });
  const config = loadConfig({}, { servers: [{ name: 'gpu-01', host: '10.0.0.1' }] });
  const summary = defaultBuildComputeSummary(db, config) as any;
  expect(summary.totals.tflops).toBeCloseTo(312, 5);
  expect(summary.hosts[0].tflops).toBeCloseTo(312, 5);
  expect(summary.models[0].tier).toBe('training');
  expect(JSON.stringify(summary.notes)).not.toContain('尚未迁移');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter servermonitor-backend exec vitest run test/web/pages-compute.test.ts`
Expected: FAIL — `expected 0 to be close to 312`

- [ ] **Step 3: 改为委托真实构建器**

`pages.ts` 顶部增加 import：

```ts
import { buildComputeSummary } from '../../collect/compute';
```

`defaultBuildComputeSummary` 整个函数体替换为：

```ts
export function defaultBuildComputeSummary(
  db: SqliteDatabase,
  config: AppConfig,
): unknown {
  return buildComputeSummary(getAllHostSnapshots(db).map((row) => row), {
    servers: config.servers,
  });
}
```

删除该函数里原先的 `GB`/`roundTo`/`slug`/bucket 聚合等仅它使用的辅助（若 `GB` 仍被 my/其他函数使用则保留）。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter servermonitor-backend exec vitest run test/web/pages-compute.test.ts test/web/composition.test.ts`
Expected: PASS（含既有 `totals.tflops > 0` 契约）

- [ ] **Step 5: 提交**

```bash
git add backend/src/web/routes/pages.ts backend/test/web/pages-compute.test.ts
git commit -m "fix(pages): build the compute fallback with the real GPU spec table"
```

---

### Task 3: 「我的账号」页返回成员主机数据

**Files:**
- Modify: `backend/src/web/routes/users.ts`（导出 `buildMyAccountsPayload`）
- Modify: `backend/src/web/routes/pages.ts`（`defaultBuildMySummary` 调用它）
- Test: `backend/test/web/pages-my.test.ts`

**Interfaces:**
- Consumes: `buildUsersPayload`（同文件私有）、`readUserSettings`、`buildUserRows`、`getAllHostSnapshots`。
- Produces: `buildMyAccountsPayload(args: { db: SqliteDatabase; config: AppConfig }): Obj`，返回 `{ mode, member, hosts: [{ name, address, status, last_scan_at, last_error, account }], summary: { hosts, present, missing, issues, host_errors, home_bytes, data_bytes } }`。

- [ ] **Step 1: 写失败测试**

```ts
// backend/test/web/pages-my.test.ts
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/storage/db';
import { initSchema } from '../../src/storage/schema';
import { saveAppSettings } from '../../src/storage/settings';
import { saveHostUserSnapshot } from '../../src/storage/users';
import { createServerApp } from '../../src/web/composition';
import { loadConfig } from '../../src/config/config';

it('returns only the member account, grouped by host', async () => {
  const db = openDatabase(':memory:');
  initSchema(db);
  saveAppSettings(db, [
    { section: 'monitoring', data: { mode: 'user', member_account: 'zhangsan', timezone: 'Asia/Shanghai' } },
  ]);
  saveHostUserSnapshot(db, 'host-a', [
    { username: 'zhangsan', state: 'present', home_size_bytes: 100, data_size_bytes: 200, issues: [] } as any,
    { username: 'lisi', state: 'present', home_size_bytes: 9, data_size_bytes: 9, issues: [] } as any,
  ]);
  const config = loadConfig({}, { servers: [{ name: 'host-a', host: '10.0.0.5' }] });
  const { app } = createServerApp({ db, config });
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/my/summary`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.member).toBe('zhangsan');
  expect(body.hosts).toHaveLength(1);
  expect(body.hosts[0].account.username).toBe('zhangsan');
  expect(body.summary.present).toBe(1);
  expect(body.summary.home_bytes).toBe(100);
  server.close();
});
```

（若该测试文件需要登录，仿照 `backend/test/web/hosts-from-db.test.ts` 的 setup/login + CSRF 辅助；`/api/my/summary` 在 user 模式下需已登录。）

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter servermonitor-backend exec vitest run test/web/pages-my.test.ts`
Expected: FAIL — `hosts` 为 `[]`（length 0）

- [ ] **Step 3: 实现 `buildMyAccountsPayload` 并接线**

在 `users.ts` 中新增导出（放在 `buildUsersPayload` 之后）：

```ts
export function buildMyAccountsPayload(args: { db: SqliteDatabase; config: AppConfig }): Obj {
  const settings = readUserSettings(args.db);
  const payload = buildUsersPayload({
    servers: args.config.servers,
    db: args.db,
    settings,
    tz: settings.timezone,
  });
  const member = readMemberAccount(args.db);
  const mine = new Map<string, Obj>();
  for (const row of asArray(payload.accounts)) {
    const account = asObj(row);
    if (member && String(account.username ?? '') === member) {
      mine.set(String(account.host_name ?? ''), account);
    }
  }
  const hosts: Obj[] = [];
  for (const block of asArray(payload.hosts)) {
    const host = asObj(block);
    const account = mine.get(String(host.name ?? ''));
    if (!account) continue;
    hosts.push({
      name: host.name,
      address: host.address,
      status: host.status,
      last_scan_at: host.last_scan_at,
      last_error: host.last_error,
      account,
    });
  }
  const present = hosts.filter((h) => asObj(h.account).state === 'present').length;
  const missing = hosts.filter((h) => asObj(h.account).state === 'missing').length;
  return {
    mode: readViewModeFromDb(args.db),
    member,
    hosts,
    summary: {
      hosts: hosts.length,
      present,
      missing,
      issues: hosts.filter((h) => asArray(asObj(h.account).issues).length > 0).length,
      host_errors: hosts.filter((h) => h.status === 'error').length,
      home_bytes: hosts.reduce((n, h) => n + (Number(asObj(h.account).home_size_bytes) || 0), 0),
      data_bytes: hosts.reduce((n, h) => n + (Number(asObj(h.account).data_size_bytes) || 0), 0),
    },
  };
}
```

`readMemberAccount` 若在 `users.ts` 无同名函数，用 `loadEffectiveSettings(db).monitoring.member_account`；`readViewModeFromDb` 同理用 `monitoring.mode`（默认 `admin`）。

`pages.ts` 的 `defaultBuildMySummary` 改为：

```ts
export function defaultBuildMySummary(db: SqliteDatabase, config: AppConfig): Obj {
  return buildMyAccountsPayload({ db, config });
}
```

（从 `users.ts` import 该函数；删除 `pages.ts` 中已无用的 `readMemberAccount` 调用。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter servermonitor-backend exec vitest run test/web/pages-my.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/web/routes/users.ts backend/src/web/routes/pages.ts backend/test/web/pages-my.test.ts
git commit -m "feat(my): return the member account rows grouped by host"
```

---

### Task 4: 报表管理层版（executive）设置入口

**Files:**
- Modify: `backend/src/config/schema.ts`（`report.fields` 增加 `executive`）
- Modify: `backend/assets/web/templates/settings.html`（报告卡片增加 3 个字段）
- Test: `backend/test/config/report-executive.test.ts`

**Interfaces:**
- Consumes: `validateSection`、`publicSettings`、`saveSection`（既有）。
- Produces: settings 负载新增 `report.executive = { enabled: boolean (默认 false), subject_prefix: string (默认 '[Leader Summary]'), to_addrs: string[] (默认 []) }`；`runtime/wiring.ts:805` 现有读取逻辑不变即可生效。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { validateSection } from '../../src/config/schema';

it('accepts the executive sub-section and coerces to_addrs', () => {
  const result = validateSection('report', {
    executive: { enabled: true, subject_prefix: '[Lead]', to_addrs: 'a@x.com; b@x.com' },
  });
  expect(result.errors).toEqual([]);
  expect((result.value.executive as any).enabled).toBe(true);
  expect((result.value.executive as any).to_addrs).toEqual(['a@x.com', 'b@x.com']);
});

it('defaults executive to disabled', () => {
  const result = validateSection('report', {});
  expect((result.value.executive as any).enabled).toBe(false);
  expect((result.value.executive as any).subject_prefix).toBe('[Leader Summary]');
  expect((result.value.executive as any).to_addrs).toEqual([]);
});

it('rejects a non-boolean executive.enabled', () => {
  const result = validateSection('report', { executive: { enabled: 'yes' } });
  expect(result.errors.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter servermonitor-backend exec vitest run test/config/report-executive.test.ts`
Expected: FAIL — `value.executive` 为 `undefined`

- [ ] **Step 3: 补 schema 与模板**

`schema.ts` 的 `report.fields` 里追加：

```ts
      executive: monField('object', null, {
        fields: {
          enabled: monField('boolean', false),
          subject_prefix: monField('string', '[Leader Summary]'),
          to_addrs: monField('string_list', []),
        },
      }),
```

`settings.html` 的报告卡片 `.settings-grid` 内追加：

```html
      <label class="check-row span-2"><input type="checkbox" data-field="executive.enabled" {% if settings.report.executive.enabled %}checked{% endif %}> 额外发送「管理层摘要版」日报</label>
      <label class="field"><span>管理层版主题前缀</span><input data-field="executive.subject_prefix" value="{{ settings.report.executive.subject_prefix }}"></label>
      <label class="field span-2"><span>管理层版收件人（逗号或分号分隔，留空沿用 SMTP 收件人）</span><input data-field="executive.to_addrs" value="{{ settings.report.executive.to_addrs|join(', ') }}"></label>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter servermonitor-backend exec vitest run test/config/report-executive.test.ts test/web/settings.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add backend/src/config/schema.ts backend/assets/web/templates/settings.html backend/test/config/report-executive.test.ts
git commit -m "feat(report): expose the executive daily report in settings"
```

---

### Task 5: P0 验收与 v0.2.13 发布

**Files:**
- Modify: `CHANGELOG.md`（新增 v0.2.13 段）
- Create: `docs/superpowers/plans/p0-module-optimization-acceptance.md`
- Modify: 三处 `package.json`（`node scripts/bump-version.mjs 0.2.13`）

- [ ] **Step 1: 全量门禁**

Run:
```bash
pnpm --filter servermonitor-backend typecheck && pnpm --filter servermonitor-backend test
cd desktop && pnpm run typecheck && pnpm run test:unit && pnpm run build:main
```
Expected: typecheck 0；后端与桌面单测全绿。

- [ ] **Step 2: 打包并冒烟**

Run: `cd desktop && ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ pnpm run build`
Expected: 产出 `desktop/release-electron/ServerMonitor-0.2.12-Setup.exe`（版本号此时尚未 bump，属正常）。

以打包产物 `win-unpacked` 启动隔离实例（`--remote-debugging-port`、`--user-data-dir`、`--no-sandbox`，`APPDATA` 指向临时目录），CDP 验证：
- `/compute` 页面「总卡数/总算力」非 0；
- 用户模式登录后 `/my` 显示成员账号行（若测试库无成员账号则显示空态）；
- 托盘图标非空（截图/日志确认 `Tray` 使用 icon.ico）。

- [ ] **Step 3: 写验收文档**

`docs/superpowers/plans/p0-module-optimization-acceptance.md` 记录：四项改动的证据（测试名、截图路径、CDP 输出摘要）、未覆盖项（GUI 托盘图标人工确认）。

- [ ] **Step 4: 版本与 CHANGELOG**

Run: `node scripts/bump-version.mjs 0.2.13`
CHANGELOG 顶部加：

```markdown
## v0.2.13 模块优化 P0（快赢）

- 托盘与窗口使用应用图标（此前托盘为空白图标）。
- 算力概览在未注入构建器时也按 GPU 规格表计算 tflops/带宽，未知型号记 0。
- 「我的账号」页按成员账号返回各主机账号、占用与问题数。
- 设置 → 报告新增「管理层摘要版」日报开关、主题前缀与独立收件人（默认关闭）。
```

- [ ] **Step 5: 提交并发布**

```bash
git add -A
git commit -m "feat(p0): tray icon, compute parity, my-account data, executive report settings; bump 0.2.13"
git push
gh workflow run release-windows.yml --ref main -f version=0.2.13
```

Expected: workflow success；`gh release view v0.2.13 --json assets` 含 `ServerMonitor-0.2.13-Setup.exe`、`latest.yml`、`.blockmap`；补写 Release notes。