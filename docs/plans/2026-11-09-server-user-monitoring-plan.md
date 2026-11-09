# 服务器用户只读监控实施计划

Spec: `docs/plans/2026-11-09-server-user-monitoring-design.md`
版本: 0.3.0
技术栈: Python 3.11+, SQLite, paramiko, Flask, Jinja, 原生 JS, Electron, pytest

## 全局约束

- 只读：不执行任何用户/组/目录修改命令；`POST /api/users/*` 只改本地数据库或触发采集。
- 只读本机 `/etc/passwd`、`/etc/group`；不使用 `getent`/`id` 判定账号范围；不读 `/etc/shadow`。
- 所有远端命令使用固定模板 + `shlex.quote`；用户名必须匹配 `^[A-Za-z0-9._-]{1,64}$`。
- 纯用户采集超时使用 `user_monitoring.command_timeout`（默认 120s），不得复用 20s 指标超时。
- 不新增第三方依赖。
- 全部新增文本使用 `textContent`，不拼接 HTML。
- 版本最终同步到 `pyproject.toml`、`desktop/package.json`、`servermanage/__init__.py`。
- 全量 `python -m pytest -q` 与 `node --test desktop/test/*.test.js` 必须通过。

## Review Focus

1. 命令注入（用户名、home 路径、`/data` 路径）。
2. 删除账号是否会被误判为恢复；离线主机是否误恢复。
3. 事务替换是否原子；失败是否保留旧快照。
4. 是否有任何写操作触及目标服务器。
5. CSRF 与刷新互斥。

## Task 1：模型与配置

**文件**：`servermanage/models.py`、`servermanage/config.py`、`tests/test_user_models.py`

1. 新增：

```python
@dataclass
class UserMonitoringConfig:
    enabled: bool = True
    scan_interval_seconds: int = 3600
    usage_interval_seconds: int = 21600
    command_timeout: int = 120

@dataclass
class HostUserAccount:
    host_name: str
    username: str
    uid: int
    gid: int
    primary_group: str | None = None
    gecos: str = ""
    home: str = ""
    shell: str = ""
    groups: list[str] = field(default_factory=list)
    in_docker: bool = False
    in_sudo: bool = False
    home_exists: bool = False
    home_owner: str | None = None
    home_group: str | None = None
    home_mode: str | None = None
    home_size_bytes: int | None = None
    data_exists: bool = False
    data_owner: str | None = None
    data_group: str | None = None
    data_mode: str | None = None
    data_size_bytes: int | None = None
    data_supported: bool = True
    usage_readable: bool = True
    usage_stale: bool = False
    usage_collected_at: datetime | None = None
    collected_at: datetime = field(default_factory=...)
    state: str = "present"
```

2. `HostConfig.user_monitoring: bool | None = None`；`HostReport.users: list[HostUserAccount] = field(default_factory=list)`；`AppConfig.user_monitoring: UserMonitoringConfig = field(default_factory=UserMonitoringConfig)`。
3. `config.py`：解析全局 `user_monitoring:`（enabled/scan_interval_seconds/usage_interval_seconds/command_timeout），范围校验：enabled bool；scan 300..86400；usage 3600..604800；timeout 10..600；非法配置抛 `ConfigError`。`_load_host` 解析 `user_monitoring: true|false`。
4. 测试：默认值、YAML 覆盖、非法值、`HostConfig` 默认继承（None）。

## Task 2：存储

**文件**：`servermanage/storage.py`、`tests/test_user_storage.py`

1. 建三张表（见设计 §5），`init_storage` 幂等执行；`host_user_baseline` 含旧属性列。
2. 函数：

```python
save_host_user_snapshot(host_name, accounts, db_path) -> None   # BEGIN IMMEDIATE, DELETE + INSERT
get_host_user_snapshot(host_name, db_path) -> list[dict]
get_all_host_user_snapshots(db_path) -> dict[str, list[dict]]
upsert_user_baseline(host_name, account, db_path, *, now=None) -> bool  # 新插入返回 True
get_user_baseline(host_name, db_path) -> list[dict]
delete_user_baseline(host_name, username, db_path) -> bool
get_user_scan_state(host_name, db_path) -> dict | None
save_user_scan_state(host_name, *, last_scan_at=None, last_usage_at=None, last_error=None, db_path) -> None
delete_host_user_data(host_name, db_path) -> None
```

3. `delete_host`（settings.py）调用 `delete_host_user_data`。
4. 测试：替换原子性（插入失败回滚）、缺失账号仍保留基线、删除主机级联、`last_usage_at` 读写。

## Task 3：远端采集与解析

**文件**：`servermanage/user_scan.py`、`tests/test_user_scan.py`

1. `parse_passwd(text) -> list[dict]`：只保留 UID>=1000 且 shell 不以 `/nologin`、`/false` 结尾；记录 name/uid/gid/home/shell/gecos。
2. `parse_group(text) -> dict[str, list[str]]`：组名 → 成员列表；`primary_group_for(gid)`。
3. `build_scan_command() -> str`：固定脚本，输出 `U\t...` 与 `G\t...`（组）与 `D\t<name>\t<owner>\t<group>\t<mode>\t<exists>`；不含任何用户输入。
4. `validate_username(name) -> bool`：`^[A-Za-z0-9._-]{1,64}$`。
5. `build_usage_command(paths: list[str]) -> str`：`du -sx --block-size=1 -- ` + 每个 `shlex.quote(path)`；只接受以 `/home/` 或 `/data/` 开头的路径。
6. `parse_usage(text) -> dict[str, int]`。
7. `collect_host_users(host, runner, *, now, warning_thresholds...) -> tuple[list[HostUserAccount], bool]`：执行扫描命令 → 解析 → 组装账号对象（groups/in_docker/in_sudo/目录元数据/data_supported）→ 需要时执行 `du`。
8. `du` 使用 `runner.run_sudo(cmd, timeout)`（有 sudo 密码）或 `runner.run("sudo -n ...")`；`SudoAuthError`/`SudoUnavailable` → `usage_readable=False`，不抛错。
9. 测试：passwd/group 解析边界、nologin 排除、UID 999/1000、注入用户名、含空格路径 quote、du 部分失败、无 sudo 权限。

## Task 4：采集任务与告警

**文件**：`servermanage/app.py`、`servermanage/alerts.py`、`tests/test_user_collection.py`

1. `alerts.py`：新增

```python
def evaluate_user_alerts(account, *, in_baseline: bool, missing: bool, data_supported: bool) -> list[AlertEvent]
```

生成 `user-added`（转移类）、`user-present`、`user-docker`、`user-home`、`user-data`、`user-config`（状态类），severity 全部 `warning`，category `"user"`。
2. `resolve_missing()` 增加 `skip_prefixes: Sequence[str] = ()`，跳过匹配前缀的行（不 resolve、不产生恢复）。
3. `MonitorService` 新增：
   - `_user_scan_lock`、`_user_scan_state`（running/started_at/finished_at/error/hosts_done/hosts_total）
   - `_run_user_scan(force_usage: bool)`：串行遍历启用主机；`collect_host_users`；首次扫描只写基线；之后 `upsert_user_baseline` 返回 True 时发 `user-added`；每轮生成状态类事件；离线/失败跳过；成功后事务替换快照 + 更新 scan_state。
   - `refresh_users()`：非阻塞启动 daemon thread，返回 started/already_running。
   - 调度：`Scheduler` 注册 `user_scan`，间隔 `user_monitoring.scan_interval_seconds`，回调直接 `refresh_users()`（不阻塞调度线程）。
4. 测试：首次只建基线不告警；新增账号告警一次；删除账号告警持续两轮；账号回归后恢复；主机离线不产生事件、不 resolve；`user-added` 不被下一轮 resolve；usage 失败只标记 stale。

## Task 5：API

**文件**：`servermanage/web/routes.py`、`tests/test_user_api.py`

1. `GET /users`：渲染 `users.html`，传 `app_version`、`active_page="users"`。
2. `GET /api/users`：合并快照 + 基线缺失行；返回

```json
{"hosts": [...], "accounts": [...], "summary": {"total", "present", "missing", "docker_issues", "directory_issues", "home_bytes", "data_bytes"}, "host_status": {...}}
```

3. `POST /api/users/refresh`（CSRF）：调用 `service.refresh_users()`。
4. `GET /api/users/refresh-status`。
5. `POST /api/users/baseline/remove`（CSRF）：删除基线 + 将该账号 active 的 `user-present` 标记 resolved（不发恢复通知）。
6. `_build_host_detail` 增加 `"users"`（含 missing 行）。
7. 测试：合并行、筛选、401/403/CSRF、404、删除基线仅改本地库。

## Task 6：页面

**文件**：`servermanage/web/templates/users.html`、`static/users.js`、`static/style.css`、`base.html`（导航）、`host.html`、`static/host-detail.js`、`tests/test_user_pages.py`

1. `/users`：统计卡（账号总数/在线/缺失/docker 异常/目录异常/占用）、筛选（主机、关键字、状态）、表格、手动刷新（轮询 refresh-status）、缺失行高亮 + “从基线移除”按钮。
2. `host.html` 新增 `data-host-tab="users"` 与 `#host-users` 面板，列同 `/users` 但限定主机。
3. `base.html` 侧栏新增“服务器用户”入口。
4. 测试：页面元素、JS 函数名、无 `innerHTML`、CSS 类存在。

## Task 7：版本、文档、发布

1. `tools/bump_version.py 0.3.0`。
2. README 顶部新增 v0.3.0 三条说明；`使用说明.txt` 标题与版本更新（保留 BOM）。
3. 版本断言更新（`test_config_example.py`、`test_launchers.py`、`test_v14_desktop_pages.py`、`test_v17_insights.py`）。
4. 全量测试 → 构建 backend + portable（带 npmmirror 变量）→ verify → subtree publish → `gh release create v0.3.0` → 等 Actions 重建 → 本机 apply-update → 冒烟 `/login`、`?v=0.3.0`、`/users`、`/api/users` → 自动更新检测 → 交付说明。
