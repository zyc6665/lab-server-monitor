# Capacity Forecast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为服务器轮询监测工具增加 30 天容量趋势预测卡片和飞书机器人通知，发布 v0.2.1。

**Architecture:** Python 纯函数 `servermanage/capacity.py` 读取每日汇总，用最小二乘线性回归估算内存/磁盘/GPU 显存达到告警阈值的剩余天数；Flask 路由把结果加入 `_build_overview` payload；前端在概览页渲染卡片。飞书支持扩展现有 `notify_webhook.py` 的 payload 分支和设置页类型下拉。

**Tech Stack:** Python 3.11+/SQLite/Flask/Jinja/原生 JS/pytest/Node test。

**Spec:** `docs/plans/2026-11-09-capacity-forecast-design.md`

## Global Constraints

- 版本同步 `pyproject.toml`、`desktop/package.json`、`servermanage/__init__.py` 到 `0.2.1`。
- 不新增第三方依赖。
- 容量预测仅覆盖 `memory`、`disk`、`gpu_memory`；不做自动操作，不改变告警触发逻辑。
- 最少 5 个有效日值；7/30/90 天窗口；默认 30 天。
- 前端只用 DOM `textContent`，禁止 `innerHTML`/`insertAdjacentHTML`/`outerHTML`。
- 飞书 Webhook URL 只从密钥存储读取，不进入日志/API 响应。
- 旧配置、旧数据库、已有 Webhook 类型保持兼容。
- 全量 Python/Node 测试通过。

## Review Focus

- 趋势数据点不足 5 个时不能伪造预测，必须显示 `insufficient_data`。
- 当前值已经超过阈值时必须 `critical`，不能因斜率为负而显示稳定。
- 每日汇总存在空值时必须以日期索引拟合，不能把缺失日当成连续样本。
- 飞书返回 HTTP 200 但 JSON 错误码非 0 时必须判失败。
- 新增卡片必须保留窄屏布局，且不能把 Webhook URL 或密码写进日志。

---

### Task 1: 容量预测核心算法

**Files:**
- Create: `servermanage/capacity.py`
- Test: `tests/test_capacity.py`

**Interfaces:**
- Produces:
  - `linear_slope(points: list[tuple[float, float]]) -> float | None`
  - `forecast_series(series: list[dict[str, object]], key: str, *, threshold: float, min_points: int = 5, horizon_days: int = 30) -> dict[str, object]`
  - `build_capacity_forecasts(db_path: Path, servers: Sequence[HostConfig], *, tz: tzinfo = timezone.utc, now: datetime | None = None, thresholds: AlertThresholds | None = None, days: int = 30) -> list[dict[str, object]]`
- Consumes: `storage.fetch_host_history`, `models.HostConfig`, `models.AlertThresholds`.

- [ ] **Step 1: Write the failing tests**

`tests/test_capacity.py` 覆盖：上升趋势（10 天 50→80，阈值 90，状态 critical）、平稳（50 一直不变，stable）、下降（80→60，stable）、不足 5 点（insufficient_data）、当前>=阈值（critical）、空值日期索引（缺失日不改变斜率）。

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q tests/test_capacity.py`
Expected: FAIL with `ModuleNotFoundError: No module named 'servermanage.capacity'`

- [ ] **Step 3: Implement `servermanage/capacity.py`**

`linear_slope` 用最小二乘；`forecast_series` 用 `t` 的日期差作为 x、非空值为 y；`build_capacity_forecasts` 遍历主机和 `memory/disk/gpu_memory`，按主机 `alert_rules` 覆盖全局阈值，返回 `hosts` 列表。

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest -q tests/test_capacity.py`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add servermanage/capacity.py tests/test_capacity.py
git commit -m "feat: add capacity forecast calculations (v0.2.1)"
```

---

### Task 2: 概览 API 集成

**Files:**
- Modify: `servermanage/web/routes.py`
- Test: `tests/test_capacity.py` 或 `tests/test_web_api.py`

**Interfaces:**
- Consumes: `capacity.build_capacity_forecasts(...)`。
- Produces: `GET /api/overview/capacity?days=30` 返回 `{"days": 30, "thresholds": {...}, "hosts": [...]}`；`_build_overview` 返回新增 `capacity` 字段。

- [ ] **Step 1: Write the failing API test**

在 `tests/test_web_api.py` 增加 `test_overview_capacity_endpoint`：初始化存储并插入 10 天 `host_daily_summary`（`disk_pct_sum` 从 500 到 800、sample_count=10），登录后 GET `/api/overview/capacity?days=30`，断言 200、`days==30`、`hosts[0]["metrics"]` 含 `disk` 且 `status in {"warning","critical"}`；GET `?days=99` 返回 400。

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q tests/test_web_api.py::test_overview_capacity_endpoint`
Expected: FAIL 404/405 or missing module.

- [ ] **Step 3: Implement route**

在 `routes.py` import `from servermanage import capacity`；新增 `api_overview_capacity()`，`days` 只允许 7/30/90，非法 400；`_build_overview` 增加 `"capacity": capacity.build_capacity_forecasts(...)`。

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest -q tests/test_web_api.py::test_overview_capacity_endpoint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add servermanage/web/routes.py tests/test_web_api.py
git commit -m "feat: expose capacity forecast API (v0.2.1)"
```

---

### Task 3: 概览容量预测卡片

**Files:**
- Modify: `servermanage/web/templates/overview.html`
- Modify: `servermanage/web/static/app.js`
- Modify: `servermanage/web/static/style.css`
- Test: `tests/test_desktop_pages.py`

**Interfaces:**
- Consumes: `/api/overview` payload `capacity` 列表。
- Produces: `#capacity-forecast` 卡片、`#capacity-list`、`#capacity-summary`，JS `renderCapacityForecast(items)`，在 `refreshOverview()` 中调用。

- [ ] **Step 1: Write failing page/JS tests**

在 `tests/test_desktop_pages.py` 增加断言：`/` 含 `id="capacity-forecast"`、`id="capacity-list"`；`app.js` 含 `function renderCapacityForecast`、`capacity-summary`、`days_to_threshold`；CSS 含 `.capacity-row`、`.capacity-risk-critical`、`.capacity-risk-warning`；`innerHTML` 不出现。

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q tests/test_desktop_pages.py -k capacity`
Expected: FAIL.

- [ ] **Step 3: Implement template/JS/CSS**

模板在 `#resource-rank` 后加入卡片；JS 扁平化 `items[].metrics`，只保留 critical/warning，按天数升序取前 5，无风险显示空状态；行内用 `document.createElement` 和 `textContent`；CSS 增加卡片及风险色，≤760px 隐藏增长列。

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest -q tests/test_desktop_pages.py -k capacity`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add servermanage/web/templates/overview.html servermanage/web/static/app.js servermanage/web/static/style.css tests/test_desktop_pages.py
git commit -m "feat: add capacity forecast card (v0.2.1)"
```

---

### Task 4: 飞书 Webhook

**Files:**
- Modify: `servermanage/notify_webhook.py`
- Modify: `servermanage/web/templates/settings.html`
- Test: `tests/test_notify_webhook.py`

**Interfaces:**
- Produces: `build_webhook_payload("feishu", event)` -> `{"msg_type":"text","content":{"text":...}}`；`settings.html` 类型下拉增加 `value="feishu"`。

- [ ] **Step 1: Write failing tests**

在 `tests/test_notify_webhook.py` 增加飞书 payload 结构断言；增加 fake response body `{"code": 19001}` 返回 False、`{"code": 0}` 返回 True 的测试；`settings.html` 断言含 `value="feishu"`。

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest -q tests/test_notify_webhook.py -k feishu`
Expected: FAIL.

- [ ] **Step 3: Implement**

`_TEXT_KINDS` 保持企业微信/钉钉；新增 `if normalized == "feishu"` 分支；`send_webhook` 读取 response body（有 `read` 时）并解析 JSON，检查 `code`、`errcode`、`StatusCode` 任一非 0 则 False；设置页增加“飞书”选项。

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest -q tests/test_notify_webhook.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add servermanage/notify_webhook.py servermanage/web/templates/settings.html tests/test_notify_webhook.py
git commit -m "feat: add Feishu webhook support (v0.2.1)"
```

---

### Task 5: 版本、文档、测试与发布

**Files:**
- Modify: `pyproject.toml`, `desktop/package.json`, `servermanage/__init__.py`
- Modify: `README.md`, `使用说明.txt`
- Test: all existing tests

- [ ] **Step 1: Bump version to 0.2.1**

Run: `python tools/bump_version.py 0.2.1`
Update version assertions in `tests/test_config_example.py`, `tests/test_launchers.py`, `tests/test_v14_desktop_pages.py`, `tests/test_v17_insights.py`.

- [ ] **Step 2: Document**

README 顶部增加 v0.2.1 说明；使用说明标题改为 v0.2.1，保留 UTF-8 BOM。

- [ ] **Step 3: Run full tests**

Run: `python -m pytest -q`
Expected: all pass.
Run: `node --test desktop/test/*.test.js`
Expected: all pass.

- [ ] **Step 4: Build and release**

Run backend build and portable build with the two npmmirror env vars; verify package; subtree split/push; `gh release create v0.2.1`; wait for Actions rebuild; compare digest; upgrade local install; smoke `/login`, `?v=0.2.1`, capacity card; check update 0.2.0→0.2.1.

- [ ] **Step 5: Commit release**

```bash
git add pyproject.toml desktop/package.json servermanage/__init__.py README.md 使用说明.txt tests
git commit -m "release: bump version to 0.2.1"
```
