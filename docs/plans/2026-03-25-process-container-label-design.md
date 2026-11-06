# 进程容器标识增强设计

## 目标

在服务器日报中，为 `Top CPU Processes`、`Top Memory Processes` 和 `Proc By User` 补充 Docker 容器标识，解决容器内进程统一显示为 `root` 时无法区分实际使用者的问题。

## 已确认需求

- 目标服务器的容器运行时统一为 Docker。
- 需要通过宿主机进程 PID 识别其所属 Docker 容器。
- `Top CPU Processes` 和 `Top Memory Processes` 中，容器标识拼接到 `USER` 列，而不是 `CMD` 列。
- `Proc By User` 需要按“容器标识 + 用户名”聚合，避免不同容器内的 `root` 混在一起。
- 容器标识优先使用容器名。
- 如果容器 ID 能取到但容器名映射失败，则展示容器短 ID（前 12 位），内部仍保留完整容器 ID。
- 未识别到容器时，保持当前用户名展示方式，不影响宿主机普通进程。

## 方案选择

### 候选方案

1. 只修改 Top 进程表，在 `CMD` 前拼接容器名。
2. 修改 Top 进程表的 `USER` 列，并将 `Proc By User` 改成按“容器标识 + 用户名”聚合。
3. 新增独立的容器使用情况板块，按容器汇总资源。

### 选型结论

采用方案 2。

原因：

- 能直接解决“容器内都是 `root`”导致的判别问题。
- 改动集中在现有采集、解析和报表链路内，不需要引入新板块。
- 展示位置稳定，`USER` 列天然适合承载“容器 + 用户”语义。
- 仅扩展当前模型，不做额外的资源统计，符合 KISS 和 YAGNI。

## 总体方案

### 数据采集

保留现有系统信息、Top 进程和全量 PID 用户映射采集，再新增两类数据：

- Docker 容器清单：构建 `container_id -> container_name` 映射。
- 全量 PID 的容器归属：构建 `pid -> container_id` 映射。

推荐新增采集阶段：

- `docker_containers`
- `pid_container_map`

其中：

- `docker_containers` 通过 `docker ps --no-trunc` 获取完整容器 ID 和容器名。
- `pid_container_map` 通过遍历 `/proc/<pid>/cgroup`，为当前宿主机上的进程提取 Docker 容器 ID。

### 数据解析

解析阶段分三步：

1. 解析已有 `ps` 输出，得到进程列表和全量 `pid -> username / command` 信息。
2. 解析 Docker 容器映射与 PID 容器映射。
3. 将容器信息回填到 Top 进程列表和 `Proc By User` 聚合结果中。

容器标签规则：

- 若 `pid -> container_id` 不存在，则该进程视为宿主机进程。
- 若存在容器 ID 且能映射到容器名，则使用容器名。
- 若存在容器 ID 但映射不到容器名，则展示该容器 ID 的前 12 位短 ID。

## 模型设计

涉及文件：

- `servermanage/models.py`

建议扩展：

- `ProcessRow` 新增：
  - `container_id: str | None`
  - `container_name: str | None`
- `UserProcessCount` 新增：
  - `container_id: str | None`
  - `container_name: str | None`

展示时不直接依赖原始字段拼接，统一在渲染前生成展示文本，避免模板中写复杂条件逻辑。

## 展示设计

涉及文件：

- `servermanage/report.py`
- `servermanage/templates/report.html.j2`
- `servermanage/templates/report.txt.j2`

### Top CPU / Top Memory

`USER` 列展示：

- 有容器名时：`容器名 | 用户名`
- 仅有容器 ID 时：`短容器 ID | 用户名`
- 无容器时：`用户名`

示例：

- `zhangz-train | root`
- `3fa4c1b92e10 | root`
- `systemd-network`

`CMD` 列保持现有命令内容，不额外拼接容器信息。

### Proc By User

按“容器标签 + 用户名”聚合。

示例：

- `zhangz-train | root=128`
- `duanzt-exp01 | root=96`
- `systemd-network=2`

宿主机进程不额外显示 `host` 前缀，保持当前阅读习惯。

## 采集命令设计

涉及文件：

- `servermanage/commands.py`

新增命令建议：

- `docker_containers`
  - 获取完整 Docker 容器 ID 和名称。
- `pid_container_map`
  - 遍历当前进程的 `/proc/<pid>/cgroup`，提取 Docker 容器 ID。

设计要求：

- 命令必须容忍进程在采集时瞬时退出。
- 命令失败不能导致整台主机采集失败，只记录局部错误。
- 解析逻辑同时兼容常见 Docker cgroup 形式，例如：
  - `/docker/<id>`
  - `docker-<id>.scope`

## 错误处理

- `docker` 命令不可用或权限不足：
  - 不中断主机采集。
  - Top 进程和聚合结果退化为现有用户名行为。
- `pid_container_map` 采集失败：
  - 不中断主机采集。
  - 仅缺失容器标签增强能力。
- 某些 PID 在采集后消失：
  - 视为正常竞态，直接跳过。
- 识别出容器 ID 但未匹配到容器名：
  - 使用短容器 ID 作为展示标签。

## 测试设计

涉及文件：

- `tests/test_parsers.py`
- `tests/test_collectors.py`
- `tests/test_report.py`

至少覆盖：

1. `docker ps --no-trunc` 输出可以正确解析出 `container_id -> container_name`。
2. `/proc/<pid>/cgroup` 提取出的 `pid -> container_id` 可以正确回填到进程表。
3. `Top CPU Processes` 和 `Top Memory Processes` 的 `USER` 列展示容器标签。
4. `Proc By User` 按“容器标签 + 用户名”聚合，不混淆多个容器内的 `root`。
5. 容器名缺失时，渲染层使用短容器 ID。
6. Docker 相关命令失败时，主机报告仍能成功生成。

## 非目标

当前增强不包含：

- 新增独立容器资源统计板块
- 按容器汇总 CPU/内存/GPU 使用率
- 自动把容器名映射到业务用户名
- 跨容器平台兼容，例如 Kubernetes 或 containerd
