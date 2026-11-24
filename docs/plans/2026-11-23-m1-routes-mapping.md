# M1 只读盘点：`routes.py` → Blueprint 拆分映射表

> 作者：DS（后端）　日期：2026-11-23　状态：供架构（GLM5.4）与前端（kimi）对齐
> 依据：`servermanage/web/routes.py`（实测约 79 个路由 + 1 个 `before_request`）

## 1. 闭包共享状态与拆分去向

`register_routes()`（L2496）内的嵌套 helper 必须提为模块级函数并显式传 `app`；真正的可变状态已在 `app.extensions` 或模块级，拆包不改变语义。

| helper（行号） | 引用点 | 状态实际存放 | 去向 |
| --- | --- | --- | --- |
| `_login_failures` / `_too_many_failures` / `_record_failure`（2502/2505/2514） | `login_submit` 2802/2827/2832 | `app.extensions["login_failures"]`（2503） | `auth.py`；常量 `_LOGIN_FAILURE_*` 保持模块级 |
| `_require_login`（2521，`@app.before_request`） | 全局 | — | 仅在 `routes/__init__.py` 注册一次 |
| `_terminal_denied`（2604） | 2617/2656/2673/2703/2715 | 无 | `ssh_terminal.py` |
| `_find_host`（2609） | 2622 | 无 | `ssh_terminal.py` |
| `_terminal_session_or_none`（2648） | 2660/2677/2709/2720 | 委托模块级 `get_ssh_terminal_manager(app)`，会话在 `app.extensions["ssh_terminal"]`（230） | `ssh_terminal.py` |
| `_finish_ssh_audit`（2691） | 2705/2745 | `app.extensions["ssh_audit"]`（2645/2692） | `ssh_terminal.py` |
| `_user_write_host`（3043） | 3099/3153 | 无 | `users.py` |

模块级已有可变状态（拆包保持模块级即可）：`_plan_cache`（105）、`_EXECUTE_JOBS_LOCK`（171）、`_CAPACITY_CACHE` + 锁（1198-1200）。

## 2. Storage 外部引用点（M4 门面清单）

`storage.py` 无 class，约 100 个模块级函数（公开约 65 个）。兼容层用 `storage/__init__.py` 重导出 + 显式 `__all__`，不做 Repo 类化。

- 直接 import：`app.py` 18 个（含私有 `_extract_disk_used_percent`）、`weekly.py` 3 个、`main.py` 1 个
- `storage.X` 调用：`web/routes.py` 约 45 个函数；`scheduler.py`（`get_task_state`, `set_task_state`）；`alerts.py`（`list_silences`, `update_alert`, `list_alerts`, `find_latest_alert`, `insert_alert`）；`user_collection.py`（7 个）；`capacity.py`（`fetch_host_history`）
- 无调用：`report.py` / `host_import.py` / `host_probe.py` / `disk_health.py`（仅注释提及）

## 3. 路由间互相调用

无路由直调另一路由；跨页跳转统一 `url_for`（8 处）。路由调用的是模块级 `_build_*` 数据构造函数，可暂留共享 helper。

## 4. 路由模块分组（定稿 10 个）

`auth` / `overview` / `hosts` / `users` / `alerts` / `disk_health` / `settings_api` / `system` / `ssh_terminal` / `pages`。
- `routes/settings.py` 改名 `settings_api.py`，避开与 `servermanage/settings.py` 同名
- 包内一律绝对导入
- `_require_login` 只在 `routes/__init__.py` 注册一次
- `_state.py` 只放 helper 函数，不新建状态容器

**注册方式（架构拍板，替代原生 Blueprint）**：各模块用模块级视图函数，注册时以
`app.add_url_rule(rule, endpoint="<原函数名>", view_func=...)` 显式保留裸 endpoint，
不使用 Flask `Blueprint` 类。这样模板与 `routes.py` 内共 37 处 `url_for` 零改动，
`register_routes()` 签名不变，不触碰 kimi 的 M2 边界。

**归属原则（架构拍板）**：按**领域**归模块，**不按 URL 前缀切**。
`/api/settings/hosts/*` 归 `hosts`、`/api/settings/silences` 归 `alerts`，
其余 `/api/settings/*` 归 `settings_api`；**URL 路径全部保持原样**（兼容 Electron 与旧接口）。

## 5. 实施顺序

1. `routes/__init__.py` + `_state.py` 骨架
2. `ssh_terminal.py`（helper 最多，先验证拆法）
3. 其余路由模块按表逐个拆
4. 每拆一个跑 `pytest tests/test_*_api.py`

**第一个 PR 必须加 `test_route_endpoints`**：断言锁住当前 79 个裸 endpoint 名，
防止后续误改导致 `url_for` 构建失败。
