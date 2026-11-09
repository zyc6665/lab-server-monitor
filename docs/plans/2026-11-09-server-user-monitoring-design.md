# 服务器用户只读监控设计

日期：2026-11-09  
状态：设计草案  
范围版本：0.3.0（只读用户监控第一版）

## 1. 目标与背景

实验室目前通过脚本创建用户：

- 创建 `/home/<user>`
- 设置登录 shell
- 设置密码
- 加入 `docker` 组
- 创建 `/data/<user>` 并归属该用户

这些步骤目前靠人工确保。系统需要提供一份只读视图，让管理员快速看到每台服务器上的实验室账号是否存在、权限是否符合标准、家目录和数据目录是否正常、各用户占用了多少空间。

第一版只做**只读监控**，不执行任何用户、密码、组、目录权限变更。用户创建、删除、改密、加入/移出组等操作留到后续版本。

## 2. 名词与范围

### 2.1 实验室用户

本设计中的“服务器用户”指**普通账号**：

- `/etc/passwd` 中的 UID >= 1000
- 登录 shell 不是 `*/nologin` 或 `*/false`

不展示、不采集系统账号（UID < 1000），包括 root、daemon、sshd 等。

### 2.2 第一版包含

- 所有配置主机的实验室用户清单
- 账号基础信息：用户名、UID、GID、主组、附加组、登录 shell
- 权限信息：是否在 `docker` 组、是否在 `sudo`/`wheel` 组
- 目录信息：用户家目录（`/etc/passwd` 中的 home 字段）和 `/data/<user>` 是否存在、所有者、所属组、权限
- 空间信息：两个目录的磁盘占用
- 全局“服务器用户”页面与主机详情“服务器用户”标签
- 普通账号异常告警：新增/删除、docker 组缺失、目录缺失、目录所有者不符
- 手动刷新

### 2.3 第一版不包含

- 系统账号展示或采集
- 创建、删除用户
- 修改密码、锁定/解锁账号
- 加入/移出 `docker`、`sudo` 等组
- 创建目录、修改所有者或权限
- 读取 `/etc/shadow` 或任何密码哈希
- 远程 shell、批量执行自定义命令
- 配额设置或强制限制

## 3. 安全约束（硬性）

1. 只执行固定白名单内的只读命令，不接受来自网页或 API 的任意命令。
2. 只读取 `/etc/passwd`、`/etc/group`、`stat`、`du` 的结果；不使用依赖 NSS 的 `getent`/`id` 来判定账号范围。
3. 不读取 `/etc/shadow`、SSH 私钥、用户文件内容。
4. 用户名先按 `/etc/passwd` 读取，再用严格正则校验；所有路径用 `shlex.quote` 处理。
5. sudo 只用于读取其他用户目录占用；有 sudo 密码时走现有 `run_sudo`，无密码时回退 `sudo -n`，失败则显示“无权限读取”，不静默伪造数据。
6. 所有写操作入口都不存在；`POST /api/users/refresh` 只触发采集，不修改目标主机。
7. 日志不记录 sudo 密码、用户文件内容或 shell 命令输出全文；只记录采集结果摘要和错误。

## 4. 数据采集

### 4.1 采集周期

- 账号、组、目录元数据：默认每 **1 小时** 一次。
- 目录占用 `du`：默认每 **6 小时** 一次，避免频繁遍历大目录影响服务器 I/O。
- 页面“立即刷新”会执行一次完整采集（账号 + 当前目录占用），复用同一个后台采集线程。
- 采集任务运行在独立后台线程（类似现有 `schedule_host_collection`），不占用共享调度线程；同一时刻只允许一个用户采集任务运行，手动刷新与定时任务互斥。
- 单台主机采集超时使用独立 `user_scan_command_timeout`（默认 120 秒）；`du` 使用同一超时，禁止沿用 20 秒的指标采集超时。

### 4.2 远端命令

使用一条固定的 bash 脚本读取账号与目录元数据，不逐个用户建立 SSH 连接。**只读本机 `/etc/passwd` 和 `/etc/group`，不使用 `getent`**，避免把 LDAP/AD/SSSD 等目录服务账号误当成实验室用户：

```bash
export LC_ALL=C
awk -F: '{printf "R\t%s\t%s\t%s\n", $1, $3, $4}' /etc/group
awk -F: '$3 >= 1000 && $7 !~ /(nologin|false)$/ {printf "U\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $3, $4, $6, $7, $5}' /etc/passwd |
while IFS=$'\t' read -r kind name uid gid home shell gecos; do
  if [ -d "$home" ]; then
    stat -c 'H\t'"$name"'\t%U\t%G\t%a\t%Y' -- "$home" 2>/dev/null || true
  fi
  if [ -d "/data/$name" ]; then
    stat -c 'D\t'"$name"'\t%U\t%G\t%a\t%Y' -- "/data/$name" 2>/dev/null || true
  fi
done
```

组关系由本地解析器根据 `R` 行的 `/etc/group` 成员列表计算；主组由用户 GID 对应 `/etc/group` 的组名。这样不依赖远端 `id` 的 NSS 解析结果。

目录占用使用单独的一次 sudo 调用，把本轮所有已存在的路径一次性传给 `du`：

```bash
du -sx --block-size=1 -- /home/alice /data/alice /home/bob /data/bob ...
```

- `-x` 防止跨文件系统。
- 路径来自远端 `/etc/passwd`，且全部经过 `shlex.quote`。
- 只对位于 `/home/` 或 `/data/` 下的路径执行 `du`；异常 home（如 `/`、`/usr`）只展示元数据，不做占用统计，避免遍历系统目录。
- 输出格式 `字节数\t路径`，解析后填回对应用户。
- 单条路径失败不影响其他路径；缺失或超时保留上一次数值，并标记 `usage_stale=true`。

### 4.3 输出模型

```text
HostUserAccount
  host_name: str
  username: str
  uid: int
  gid: int
  primary_group: str
  gecos: str
  home: str
  shell: str
  groups: list[str]
  in_docker: bool
  in_sudo: bool
  home_exists: bool
  home_owner: str | None
  home_group: str | None
  home_mode: str | None
  home_size_bytes: int | None
  data_exists: bool
  data_owner: str | None
  data_group: str | None
  data_mode: str | None
  data_size_bytes: int | None
  data_supported: bool = True
  usage_readable: bool = True
  usage_stale: bool = False
  usage_collected_at: datetime | None
  collected_at: datetime
  state: str = "present"          # present | missing
```

判定规则：

- `in_docker`: `groups` 含 `docker`
- `in_sudo`: `groups` 含 `sudo` 或 `wheel`
- `home_exists` / `data_exists`: 仅表示目录存在
- `data_supported`: 主机上是否存在 `/data` 目录；不存在时所有用户的 `/data` 检查视为“不适用”，不告警
- `usage_readable`: 本轮 `du` 是否被允许执行；没有 sudo 权限时为 `false`，只在该行显示“无权限读取占用”，不把主机标为异常
- `usage_stale`: 仅表示占用数据“超过有效期”。判定为 `last_usage_at is None` 或 `now - last_usage_at > usage_interval_seconds * 1.5`，或本轮到期的 `du` 执行失败。正常的“本轮未到 6 小时”不算 stale
- `state`: `present` 为当前存在；`missing` 为基线中存在但本轮快照缺失（账号已删除）
- 目录异常告警只针对**所有者不是该用户**；所属组、权限（含 setgid）只在页面展示，不单独告警，避免共享目录和高权限目录误报
- 目录缺失：
  - 用户家目录（passwd 的 home 字段）不存在
  - `/data/<user>` 不存在（仅 `data_supported=true` 时告警）

### 4.4 配置与范围

- 新增 `AppConfig.user_monitoring`：`enabled=True`、`scan_interval_seconds=3600`、`usage_interval_seconds=21600`、`command_timeout=120`。
- 新增 `HostConfig.user_monitoring: bool | None = None`，为空继承全局；可单独排除不适用主机（例如非 root 的运维跳板机）。
- 第一版不要求提供网页配置项，YAML 支持即可；设置页只显示采集状态。
- `/data` 是否适用由远端 `test -d /data` 判断，不使用主机配置中的磁盘挂载列表猜测。

## 5. 存储

新增表 `host_user_snapshot`：

```sql
CREATE TABLE host_user_snapshot (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER NOT NULL,
    gid INTEGER NOT NULL,
    primary_group TEXT,
    gecos TEXT,
    home TEXT,
    shell TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    home_exists INTEGER NOT NULL DEFAULT 0,
    home_owner TEXT,
    home_group TEXT,
    home_mode TEXT,
    home_size_bytes INTEGER,
    data_exists INTEGER NOT NULL DEFAULT 0,
    data_owner TEXT,
    data_group TEXT,
    data_mode TEXT,
    data_size_bytes INTEGER,
    data_supported INTEGER NOT NULL DEFAULT 1,
    usage_stale INTEGER NOT NULL DEFAULT 0,
    usage_collected_at TEXT,
    collected_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);
CREATE INDEX idx_host_user_snapshot_host ON host_user_snapshot(host_name);

CREATE TABLE host_user_baseline (
    host_name TEXT NOT NULL,
    username TEXT NOT NULL,
    uid INTEGER,
    gid INTEGER,
    primary_group TEXT,
    shell TEXT,
    home TEXT,
    groups_json TEXT NOT NULL DEFAULT '[]',
    in_docker INTEGER NOT NULL DEFAULT 0,
    in_sudo INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (host_name, username)
);

CREATE TABLE host_user_scan_state (
    host_name TEXT PRIMARY KEY,
    last_scan_at TEXT,
    last_usage_at TEXT,
    last_error TEXT
);
```

写入规则：

- 每次成功采集按主机事务替换快照：`BEGIN IMMEDIATE` → `DELETE FROM host_user_snapshot WHERE host_name = ?` → 批量 `INSERT` → `COMMIT`。
- `host_user_baseline` 保存“应存在的实验室账号”及其最近一次已知属性；首次采集只写入基线，不产生新增/删除/配置异常告警；之后每个新发现的普通账号写入基线并产生 `user-added` 事件。
- 账号从当前快照消失后，基线行保留（属性冻结为最后一次已知值），`user-present` 告警保持活动，账号在页面上以“已删除/缺失”行展示，直到账号重新出现或被人工从基线移除。
- `host_user_scan_state.last_usage_at` 保存每台主机最近一次成功 `du` 时间，用于跨重启保持 6 小时节奏；`last_error` 记录最近采集错误。
- 采集失败或主机离线：保留上一次快照，不删除、不写基线、不生成“用户被删除”事件。
- 删除主机时级联删除快照、基线、扫描状态。
- 不保存逐次历史版本；新增/删除事件通过告警表保留。

## 6. 告警

新增 `category="user"` 的告警事件，fingerprint 使用稳定键：

- `user-added:<host>:<username>`：基线中不存在的新普通账号
- `user-present:<host>:<username>`：基线中存在但本轮未出现（账号缺失）
- `user-docker:<host>:<username>`：用户不在 docker 组
- `user-home:<host>:<username>`：用户家目录（passwd 的 home）缺失
- `user-data:<host>:<username>`：`/data/<user>` 缺失（仅 `data_supported=true`）
- `user-config:<host>:<username>`：目录所有者不是该用户

严重度：

- 新增普通账号：`warning`
- 普通账号从基线中消失：`warning`
- docker 组缺失、目录缺失、所有者不符：`warning`
- 系统账号不产生任何告警

状态机：

- **状态类告警**（`user-present`、`user-docker`、`user-home`、`user-data`、`user-config`）每轮只要条件仍成立就重新生成，作为候选事件交给 `AlertEngine.process`；同时它们的 fingerprint 每轮都进入该主机的活动集合，供 `resolve_missing` 判断恢复。
- **转移类告警**（`user-added`）只在一个账号第一次进入基线时生成一次，不参与 `resolve_missing` 自动关闭。实现上 `resolve_missing(..., category="user", skip_prefixes=("user-added",))`，避免下一轮被当作“已恢复”而发出虚假恢复通知。转移类告警由用户在告警页手动确认（`POST /api/alerts/<id>/ack`）。
- 每轮采集把 `user-present` 作为**持续存在的候选事件**（只要账号仍缺失就每轮重新生成），交给 `AlertEngine.process` 去重/冷却；因此账号真正回来之前告警不会自行恢复。
- 新账号在写入基线时产生一次 `user-added`；下一轮它成为基线成员，不再重复新增告警。
- 账号重新出现后，`user-present` 不再生成，使用现有 `resolve_missing` 恢复。
- 主机离线或采集失败时跳过整台主机的候选事件与 `resolve_missing`，不误恢复。
- 首次建立基线时不产生新增/缺失/配置异常告警，异常只在页面显示。
- 未处理的删除告警重复通知遵循全局 `alerts.repeat_while_active`：默认 `false` 时，冷却期结束后不重复通知，直到账号恢复或被手动确认；开启后按 `cooldown_minutes` 周期重复。
- 人工“确认”复用现有告警确认（静默通知、状态改为已确认），基线行仍保留、页面仍显示缺失；如需彻底移除该账号的监控基线，使用单独的“从基线移除”操作（只改本地数据库，不影响服务器）。

## 7. API 与页面

### 7.1 API

- `GET /users`：服务器用户页面。
- `GET /api/users?host=<name>&q=<keyword>&status=all|warning|error`：返回当前快照与基线合并后的行、每台主机摘要、全局统计。合并规则：快照中的账号为 `present`；基线中存在但快照缺失的账号补一行 `state="missing"`，属性取基线中最后一次已知值，`uid/gid/groups` 等可用旧值展示，占用和目录状态显示“—”，并标记“已删除/缺失”。`status=warning` 表示账号/权限/目录异常（含 missing 行），`error` 仅表示该主机账号采集失败（SSH 失败、脚本失败、解析失败），`all` 包含两者。`usage_readable=false` 不算 `error`，只在对应行显示“无权限读取占用”。
- `POST /api/users/refresh`：异步触发一次只读全量采集；带 CSRF；立即返回 `{"ok": true, "started": true}`，如果已有任务运行返回 `{"ok": true, "started": false, "reason": "already_running"}`。
- `GET /api/users/refresh-status`：返回 `running`、`started_at`、`finished_at`、`error`、`hosts_done`、`hosts_total`，供页面轮询刷新按钮状态。
- `POST /api/users/baseline/remove`：带 CSRF，body `{"host": "...", "username": "..."}`；只删除本地 `host_user_baseline` 行和该账号仍处于 active 的 `user-present` 告警（标记 resolved，不发送恢复通知），不触碰服务器；用于确认“这个账号确实不再需要监控”。返回 `{"ok": true, "removed": 1}` 或 404。
- 主机详情通过 `_build_host_detail` 返回该主机的 `users`（同样含 missing 行），不需要额外 API。

### 7.2 全局“服务器用户”页面

顶部统计卡：

- 实验室账号总数（按基线计数，含缺失账号；另标注“当前在线账号数”）
- docker 组异常数
- 目录异常数
- `/home` 与 `/data` 总占用

表格列：

- 主机、用户名、UID、主组、附加组
- 状态（存在 / 已删除缺失）
- Docker、sudo
- 家目录状态（存在/缺失、所有者、权限、占用；路径取 passwd 的 home）
- `/data` 状态（存在/缺失、所有者、权限、占用）
- 最近采集时间

筛选：

- 主机
- 关键字（用户名、组名、主机名）
- 状态：全部 / 有异常 / 仅正常
- 手动刷新按钮

空状态：没有实验室账号或尚未采集时显示明确提示。

### 7.3 主机详情

在现有“登录用户”之外新增“服务器用户”标签，展示该主机普通账号清单：

- 基础账号信息
- docker/sudo 徽标
- 家目录（passwd 的 home）和 `/data` 状态、所有者、权限、占用
- 异常行高亮

## 8. 采集任务

在 `MonitorService` 中新增独立采集 worker，不复用同步 `Scheduler` 任务线程：

- 名称：`user_scan`
- 启动时执行一次，此后由 `Scheduler` 每分钟检查是否到达 1 小时间隔，实际扫描在 daemon thread 中运行。
- 同一时刻只允许一个 `user_scan`（`threading.Lock`）；手动刷新与定时扫描共用该锁。
- 主机按顺序扫描，默认串行，避免对多台服务器同时发起大量 `du`；未来可改成小并发池。
- 每轮对每台主机：
  1. 使用现有 SSH runner 执行账号脚本
  2. 解析普通账号
  3. 从 `host_user_scan_state.last_usage_at` 判断是否到达 6 小时目录占用周期；到则执行 `du` 批量命令
  4. 与 `host_user_baseline`、旧快照比较生成新增/删除/配置异常事件
  5. 事务替换快照、更新基线与扫描状态
  6. 通过现有 `AlertEngine.process` 分发事件
- 单台主机超时使用 `user_scan_command_timeout`（默认 120 秒，独立于指标采集的 20 秒）。
- 失败主机保留旧快照，任务状态记录错误，不删除用户、不写基线。

## 9. 测试计划

- 解析：本机 `/etc/passwd`/`/etc/group`、NSS 账号不进入、系统账号排除、nologin/false 排除、UID 边界。
- 采集：正常用户、缺目录、目录所有者异常、`du` 部分失败、sudo 失败、无 `/data` 主机跳过检查。
- 安全：用户名注入、路径含空格/特殊字符、命令不拼接网页输入。
- 存储：事务替换、首次基线、主机离线保留旧数据、删除主机级联、6 小时 `last_usage_at` 跨重启。
- 告警：新增/删除用户、删除告警持续到账号回归、docker 组缺失、目录缺失、恢复正常、首次采集不告警、系统账号不告警、`user-added` 不被下一轮 `resolve_missing` 误关闭、缺失账号在页面有行、`baseline/remove` 只改本地库。
- 新鲜度：未到 6 小时不置 `usage_stale`；超过 1.5 倍周期或到期 `du` 失败才置；无 sudo 权限只显示 `usage_readable=false`，不把主机计入 error。
- 任务：独立线程不阻塞指标调度、刷新互斥、刷新状态接口。
- API/UI：`/users` 页面、筛选、统计卡、主机详情标签、手动刷新 CSRF。
- 回归：全量 Python/Node 测试通过；打包与桌面端冒烟。

## 10. 验收标准

1. 所有配置主机的普通账号都能在“服务器用户”页看到，系统账号不显示。
2. 每个普通账号显示 UID/GID、组、docker/sudo、家目录（passwd 的 home）和 `/data` 状态及占用。
3. 账号新增/删除、docker 组缺失、目录缺失、所有者异常能产生告警并在页面高亮；删除的账号在页面以“已删除/缺失”行展示，告警持续到账号回归或人工从基线移除。
4. 主机离线或采集失败时保留旧快照，不误报“用户被删除”；无 `/data` 的主机不产生 `/data` 缺失告警。
5. 整个功能不执行任何写操作；刷新只重新采集。
6. 不与现有指标轮询、告警、报告冲突，全量测试通过。

## 11. 实施顺序（建议）

1. 模型与解析器
2. 存储表与事务替换
3. SSH 采集器与 sudo 目录占用
4. 采集任务与告警
5. `/users` 页面与主机详情标签
6. 测试、构建、发布 0.3.0

## 12. 对现有代码的最小改动

- `servermanage/alerts.py`：`resolve_missing()` 增加 `skip_prefixes: Sequence[str] = ()` 参数，跳过指定前缀的 fingerprint（默认空，不影响现有调用）；`AlertEngine` 其余逻辑不变。
- `servermanage/models.py`：新增 `HostUserAccount`、`UserMonitoringConfig`；`HostConfig.user_monitoring`、`HostReport.users`、`AppConfig.user_monitoring`。
- `servermanage/storage.py`：新增三张表及读写函数，`delete_host` 级联。
- `servermanage/app.py`：新增 `user_scan` worker 与调度挂钩，不影响现有指标/磁盘采集线程。
- `servermanage/web/routes.py`：新增 `/users`、`/api/users*`、`_build_host_detail` 增加 `users`。
- 前端新增 `users.js`/`users.html`，`host.html` 增加“服务器用户”标签。

## 13. 明确留给实现者的决定

- 具体 HTML/CSS 排布与表格列宽
- `du` 超时后的重试次数
- 未来版本是否增加用户创建/删除/改密等写操作（本设计明确不做）
