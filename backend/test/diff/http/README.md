# Cross-stack HTTP golden diff (P5 Task12)

> **P8 冻结说明（2026-11-26）**：Python 实现已移除。本目录及其它 cross-stack
> diff 测试中的 Python oracle 输出已在提交 `1ca108c` 上冻结为 `golden/` 下的入库快照
> （`read.json` + `read-fixture.db` + `read-servers.json`、`full-read.json`、`write-flow.json`），
> 测试改为 Node 输出对照 golden（重放时用 fake timers 把时钟钉在冻结时刻）。
> 这些文件**不可再生成**；下文描述的 `*.py` 脚本已删除，仅作历史说明。


Verifies that the Node/Express composition root (`createServerApp`) and the
Python Flask application (`servermanage.web.create_app`) answer the same HTTP
requests identically when fed the **same SQLite data**.

Run it:

```bash
pnpm --filter servermonitor-backend test diff/http
```

Requires Node, Python 3.9+ and a platform where DPAPI is available (Windows) —
the suite auto-skips on hosts where the Python oracle cannot read/write DPAPI.

## Files

| File | Role |
| --- | --- |
| `build_fixture.py` | Pure-Python (`servermanage.storage`) generator for a deterministic `fixture.db` + `config.yaml` + `servers.json`. Timestamps are fixed offsets from "now" so the 24h/7d/30d windows stay populated while both stacks read the exact same rows. |
| `dump_python.py` | Drives the Flask app via `test_client` through a JSON request plan and prints `{status, content_type, json, text, set_cookie}` per request (one `@@HTTP_DIFF_RESULT@@` line, pure-ASCII so Windows code pages can't mangle UTF-8). |
| `http-diff.test.ts` | Generates the fixture, copies it once per stack (each writes its own DPAPI admin secret), runs both stacks over the shared matrix, normalises and asserts `diff == []`. |

## Fixture

`build_fixture.py` builds (via the production storage API):

* 2 hosts (`host-a` with full metrics, `host-b` probing failing) with key auth.
* `host_metrics_history`: 10 samples for `host-a` at fixed hourly offsets
  (`1,2,6,12,20,48,120,240,480,960` h) → populates 24h / 7d / 30d windows.
* `host_daily_summary`: derived from the same samples.
* `host_latest_snapshot`: fresh success for `host-a`, failure for `host-b`.
* `host_check_snapshot` + check results for `host-a`.
* 4 alerts across `active / acknowledged / resolved`.
* `task_state` rows (`poll`, `disk`).
* `host_user_snapshot` (2 accounts on `host-a`) + `host_user_scan_state`.
* `app_settings` overrides for `monitoring / alerts / user_monitoring / disk_health`.

Secrets (`SECRET_ADMIN`, `SECRET_SESSION`) are **not** written by the fixture;
each stack creates its own on its own copy, so the diff never depends on
cross-implementation ciphertext interop.

## Endpoint matrix (15 endpoints)

| Endpoint | Auth | Result |
| --- | --- | --- |
| `GET /api/overview` | anon | exact (401) |
| `GET /login` | anon | exact (200, html) |
| `GET /api/settings` | anon | exact (401) |
| `POST /login` | anon | exact (302 + session cookie present) |
| `GET /api/overview` | in | exact |
| `GET /api/overview/capacity?days=30` | in | exact |
| `GET /api/overview/history?range=24h` | in | exact |
| `GET /api/settings` | in | exact |
| `GET /api/alerts` | in | exact |
| `GET /api/users` | in | known difference (see below) |
| `GET /api/system/health` | in | exact (runtime/tasks/diagnostics masked) |
| `GET /api/system/storage` | in | exact (usage bytes masked) |
| `GET /api/host/host-a` | in | known difference (see below) |
| `GET /api/host/host-a/history?range=24h` | in | exact |
| `GET /disk-health` | in | exact (200, html; body not compared — different template engines) |

Result: **13 exact matches, 2 documented known differences.**

## Normalisation rules

1. **Timestamps** → absolute UTC instants (µs) by the harness `normalizeValue`
   (so `Z` / `+00:00` / `+08:00` renderings of the same moment compare equal).
2. **Floats** → `toFixed(6)` (relative error well below 1e-6).
3. **Objects** → compared as sorted key sets (`applyMask` + `normalizeValue`).
4. **Arrays** → order-sensitive; storage queries carry deterministic `ORDER BY`.
5. **Volatile fields masked** (per endpoint) with `<masked>`:
   server "now" (`generated_at`, `collected_at`, `created_at`, `ack_at`,
   `last_run_at`, …), the runtime/process fingerprint (`runtime`, `tasks`,
   `diagnostics`, `pid`, `port`), storage byte counts (`usage`, `db_path`), and
   `key_path` (Python's `pathlib` renders Windows backslashes; Node keeps the
   configured forward-slash string).
6. **Set-Cookie**: only its *presence* is compared (login only); the signed
   value differs by design (different session secrets).

## Known differences (documented, not failures)

* **`GET /api/users`** — the Node payload names the per-host sudo flag `sudo_ok`
  while Flask uses a differently-named flag field, and Node adds a live
  `usage_scan` progress object that the Flask payload does not carry. Both are
  intentional Node-side enrichments of the same underlying data.
* **`GET /api/host/<name>`** — Node returns the reduced summary payload
  (`name/host/collected_at/success/group/owner/location/tags/metrics/errors/disk/alerts/checks`);
  Flask returns the full page-context detail, additionally carrying
  `alert_days / check_history / collection_uptime / diagnostics /
  diagnostics_summary / network / uptime_strip / users`, which the Node page
  composes separately.
