# 实验室服务器轮询监测工具（PC 版）设计

日期：2026-11-06
状态：已确认（2026-11-06 用户批准）

## 一、背景与目标

现有 `servermanage` 是一个部署在服务器上的 Docker 常驻工具：通过 SSH 中心化采集多台 Linux 服务器的资源信息，按 cron 生成并发送 HTML 日报/周报/领导摘要邮件，历史数据落 SQLite。

实验室服务器数量增多后，出现了三个现实问题：

1. 在每台/某台服务器上部署周报工具比较麻烦，运维成本高。
2. 希望随时打开就能看到所有机器当前状态，而不是被动等邮件。
3. 服务器都做了 RAID，坏一块盘能扛住，但需要**及时发现"有坏道 / 预警"的物理盘**并更换，避免第二块一起坏导致阵列失效。

因此目标是把工具改造为：**在个人 Windows 11 PC 上免安装（绿色包）部署的轮询监测工具**，保留原有采集/日报/周报/邮件能力，并新增本地网页仪表盘、多通道告警和基于 storcli 的每块物理盘健康度检查。

## 二、已确认需求（来自与用户沟通）

- 运行位置：个人 **Windows 11 PC 原生**运行，不在服务器上装 agent，仍由 PC 通过 SSH 中心化采集。
- 交付形态：**免安装绿色包**，解压后双击启动，后台常驻。
- 界面：**本地网页仪表盘**，后台常驻，浏览器打开即看；**允许局域网访问，并需要访问密码**。
- 通知：**桌面弹窗 + 邮件 + Webhook 机器人**三路都支持；机器人支持企业微信/钉钉/通用 Webhook，配置化，默认不启用。
- 保留功能：原有 CPU/内存/磁盘/用户/进程/NVIDIA GPU 采集、日报、周报、领导摘要、SMTP 邮件、SQLite 历史。
- 新增：**每块物理盘（PD）健康度**检查。各服务器阵列构建不同（有 MegaRAID，也有普通 RAID），但**都装了 storcli**，可查到每块盘。
- 轮询频率默认：**状态每 10 分钟、磁盘健康每天**，且可在配置中修改。

### 2.1 补充确认（builder-check 后）

- 网络：PC 与服务器**同一局域网直连**（已实测 a100/v100/4090/h100 四台可直连）。
- 账号与提权：SSH 用普通用户 `zhouyc`（在 sudo 组，但**当前需要密码**，未配置免密 sudo）；storcli/smartctl 需 root 才能读盘。**提权方式待用户确认**（推荐受限 NOPASSWD sudo，见 2.2）。
- 规模：**10 台以内**，机器**基本 7×24 常开**，需要"主机离线"告警（连续 2 次采集失败判离线）。
- 运行 PC：**7×24 不睡眠常开**；杀软/EDR 是否拦截未签名 exe **不确定**，打包后实测，必要时加白名单或代码签名。
- 与现有部署：**先并存观察，再切换**。并存期只让一方发日报/告警，避免重复推送；切换有明确步骤（见第十六节）。
- 时区与统计口径：日报/周报/看板统一按**本地 Asia/Shanghai** 日界；日/周统计**先按天聚合再统计**（而非把所有高频样本直接平均）。
- 磁盘解析样本：开发期由用户提供 SSH 连接，**从 PC 直连真实服务器抓取 storcli 原始输出**（每种控制器各一份）后再定稿解析器与健康判定。
- 由本设计自行决定（不再询问）：邮件/Webhook 通道均可关闭（无 SMTP 也能启动，仅看板+桌面弹窗）；开机自启提供**可选**脚本，不强制。

### 2.2 现场勘察结果（2026-11-06，4 台真实机器）

- 连通性：`a100`（409-A100）、`v100`（mis409gpu3）、`4090`（4090）、`h100` 均可由本 PC 用 `zhouyc` + `~/.ssh/id_ed25519` 直连。root 别名使用 `~/.ssh/zyc`，但该私钥**文件损坏/格式无效**（`ssh-keygen` 报 `invalid format`），root 直连暂不可用。
- storcli：四台均装 storcli 007.2705。a100/4090/h100 为软链 `/usr/local/bin/storcli -> /opt/MegaRAID/storcli/storcli64`；v100 为实体文件 `/usr/local/bin/storcli`。**非 root 运行返回 `No Controller found`**（权限问题），root 下可见控制器。
- 控制器与物理盘（storcli 视角）：
  - **a100**：AVAGO MegaRAID SAS 9364-8i，6 块（2×Samsung 870 EVO 1TB SSD + 4×HGST 8TB HDD）。
  - **v100**：AVAGO MegaRAID SAS 9361-8i，2 块 Micron 5200 480G SSD；另有 4 块 `INSPUR MCS` 设备（sdb–sde，40T/7.9T）**不在 storcli 控制器下**（疑为外部存储/JBOD/其它阵列，storcli 看不到）。
  - **4090**：MR9362-8i（6×WD 16TB）+ MR9361-8i（2×Intel SATA SSD），共 8 块。
  - **h100**：AVAGO MegaRAID SAS 9460-8i，5 块（2×Samsung SM863a SSD + 3×WDC 22TB）。
- **真实 JSON 解析已验证**：`storcli /cX/eall/sall show all J` 结构为 `Controllers[].Response Data["Drive /cX/eY/sZ"]`（汇总：`EID:Slt/DID/State/Model/Size/Intf`）+ `["Drive /cX/eY/sZ - Detailed Information"]["Drive /cX/eY/sZ State"]`（`Shield Counter / Media Error Count / Other Error Count / Drive Temperature / Predictive Failure Count / S.M.A.R.T alert flagged by drive`）+ `["... Device attributes"]`（`SN / Model Number / Firmware Revision`）。用脚本对四台真实样本解析，**21 块 storcli 可见盘字段全部齐全**（当前均 `Onln`、错误计数 0、温度 26–32℃）。
- 采样方式说明：因当前无免密 sudo，样本通过 `docker run --privileged` 载入 storcli **只读**采集（仅用于取样本）。正式工具**不应依赖 docker**，建议改为受限 NOPASSWD sudo（见 2.3）。
- 其他：`a100` 无 `smartctl`；v100/4090/h100 有 `smartctl`，但非 root 因 `/dev/sdX` 权限（`root:disk 660`）无法读取。NVMe 盘可见（如 4090 的 7T Intel、h100 的 nvme0n1/nvme1n1）。

### 2.3 提权方案（已选定：A）

storcli/smartctl 必须 root。用户已确认采用 **A. 受限 NOPASSWD sudo**（2026-11-06）。实施前需在每台服务器 `/etc/sudoers.d/servermonitor` 增加一行（路径按实际 storcli 位置）：

`zhouyc ALL=(root) NOPASSWD: /opt/MegaRAID/storcli/storcli64, /usr/local/bin/storcli, /usr/sbin/smartctl`

工具统一用 `sudo -n <storcli> ...`：最小权限、非交互、无需存口令。

备选（未采用）：B. 提供可用 root SSH 私钥（当前 `~/.ssh/zyc` 已损坏）；C. 在 `.env` 保存 sudo 密码用 `sudo -S`（明文口令，不推荐）。

## 三、非目标

- 不做服务器端 agent / 分布式采集端。
- 不做多租户与用户体系（仅单管理员 + 一个访问密码）。
- 不做移动 App / 桌面原生 GUI（用本地 Web 代替）。
- 不做自动修复/自动重建阵列，只做发现、展示与告警。
- 不重写现有采集解析逻辑（复用 `collectors` / `parsers`）。

## 四、方案选择

### 4.1 界面：本地 Web 仪表盘 vs 桌面 GUI

| 候选 | 说明 | 结论 |
| --- | --- | --- |
| 本地 Web（Flask + waitress + Jinja） | 复用现有 Jinja 模板与 HTML 渲染，手机/其它电脑也能看 | **采用** |
| 桌面 GUI（PySide/Tkinter） | 需重写全部展示层，跨设备不可用 | 否 |
| Electron | 体积大、需 Node 构建链，重 | 否 |

选型理由：现有代码已经是 Jinja2 渲染 HTML，仪表盘可以最大程度复用样式与上下文构造逻辑；Web 形态天然支持"手机/其它电脑随时打开"，且无需引入前端构建链（原生 JS 轮询即可）。

### 4.2 调度：自研轻量调度线程 vs APScheduler

采用**自研轻量调度器**（基于单调时钟 + 持久化 `last_run` 时间戳）。理由：需要"PC 关机错过定时任务后开机补跑（catch-up）"的语义，自研更可控；依赖更少，打包更小。

### 4.3 打包：PyInstaller onedir vs 内嵌 Python vs Nuitka

采用 **PyInstaller `--onedir`** 生成绿色目录（`servermonitor.exe` + 依赖目录 + `config/` + `data/` + `logs/`）。理由：无需目标机装 Python；`onedir` 相比 `onefile` 启动快、被杀软误报少、便于替换配置。

### 4.4 磁盘健康解析：storcli JSON 优先、文本兜底

`storcli` 支持 `J` 参数输出 JSON（如 `storcli /cALL show J`、`storcli /c0/eall/sall show all J`）。优先解析 JSON，失败时回退到文本键值解析（`Media Error Count =`、`S.M.A.R.T alert flagged by drive =` 等）。理由：不同控制器/固件版本的文本排版差异大，JSON 更稳。

## 五、总体架构

### 5.1 组成

- **配置层** `config`：读取扩展后的 `config.yaml` + `.env`，做启动校验。
- **SSH 层** `ssh_client`：复用现有 Paramiko 封装。
- **状态采集** `collectors` / `parsers`：复用现有系统/GPU 采集与解析。
- **磁盘健康采集** `disk_health`（新）：SSH 执行 storcli，解析控制器/虚拟盘/物理盘健康。
- **存储** `storage`：SQLite，新增快照/磁盘/告警表，保留原历史表。
- **调度器** `scheduler`（新）：状态轮询、磁盘健康轮询、日报/周报定时，支持 catch-up。
- **告警引擎** `alerts`（新）：规则评估、去重/冷却、多通道发送。
- **Web 仪表盘** `web`（新）：Flask 应用 + waitress，页面 + JSON API。
- **报告** `report` / `weekly` / `mailer`：复用现有日报/周报/邮件渲染与发送。

### 5.2 运行流程

1. 双击 `servermonitor.exe`（或 `启动.bat`）启动进程。
2. 加载配置，初始化 SQLite，执行迁移。
3. 启动调度器线程：
   - 状态轮询：每 `poll_interval_seconds`（默认 600s）并发采集所有主机，写快照、评估告警。
   - 磁盘健康：每 `disk_poll_interval_seconds`（默认 86400s）采集 storcli 健康，写快照、评估告警。
   - 报告任务：每天/每周固定时刻发送日报/周报/领导摘要；启动时检查是否错过并补发。
4. 启动 Web 服务（默认 `0.0.0.0:8080`，需登录）。
5. 浏览器访问 `http://127.0.0.1:8080`（本机）或 `http://<PC局域网IP>:8080`（其它设备）。

### 5.3 线程模型

- 主线程：Web 服务（waitress）。
- 调度线程：一个 loop，按各任务 `next_run_at` 触发；采集任务内部用 `ThreadPoolExecutor(max_workers=concurrency)` 并发处理多主机。
- 告警发送：放入有界队列，由单独发送线程消费，避免阻塞采集。

## 六、配置设计

沿用 `config.yaml`（非敏感）+ `.env`（敏感）。在现有基础上**新增**以下配置段（现有 `smtp`/`ssh`/`servers`/`report`/`storage` 保持兼容）：

```yaml
app:
  poll_interval_seconds: 600        # 状态轮询，默认 10 分钟
  disk_poll_interval_seconds: 86400 # 磁盘健康，默认每天
  concurrency: 8                    # 并发采集主机数
  retention_days: 90                # 历史数据保留天数
  timezone: "Asia/Shanghai"

dashboard:
  host: "0.0.0.0"                   # 监听地址（局域网访问）
  port: 8080
  auth:
    enabled: true
    username: "admin"
    password_env: "DASHBOARD_PASSWORD"  # 密码放 .env
  session_secret_env: "DASHBOARD_SECRET"

alerts:
  enabled: true
  desktop_notification: true
  email: true
  webhook:
    enabled: false
    type: "wecom"                   # wecom | dingtalk | generic
    url_env: "ALERT_WEBHOOK_URL"
  thresholds:
    cpu_percent: 90
    memory_percent: 90
    disk_percent: 90
    gpu_memory_percent: 90
    disk_temperature_c: 55
  cooldown_minutes: 60              # 同一告警冷却时间，避免刷屏
  repeat_while_active: false        # true=持续异常每冷却周期重发

disk_health:
  enabled: true
  use_sudo: true                    # 用 sudo -n 提权（见 2.3）
  storcli_candidates:               # 按顺序探测
    - "storcli"
    - "storcli64"
    - "/opt/MegaRAID/storcli/storcli64"
    - "/opt/lsi/storcli/storcli64"
    - "/usr/local/bin/storcli"
    - "/usr/sbin/storcli"
  alert_on_media_errors: true
  alert_on_other_errors: true
  alert_on_predictive_failure: true
  alert_on_smart_flag: true
  alert_on_state_not_optimal: true
  alert_on_error_increase: true     # 错误计数比上次增加即告警
```

每台服务器支持可选覆盖（应对不同阵列）：

```yaml
servers:
  - name: "gpu-01"
    host: "10.10.0.11"
    port: 22
    username: "root"
    auth: { type: "key", key_path: "ssh/id_rsa" }
    disk_health:
      enabled: true
      storcli_path: "/opt/MegaRAID/storcli/storcli64"   # 可选
    tags: ["gpu"]
```

> 说明：Windows 本地运行后，SSH 私钥路径改为**本机路径**（如 `ssh/id_rsa` 相对绿色包目录），不再使用容器内 `/app/ssh`。

## 七、磁盘健康采集设计（storcli）

### 7.1 探测与采集顺序

0. 权限：按 2.3 选定的方式提权（推荐受限 NOPASSWD sudo），所有 storcli 调用形如 `sudo -n <storcli> ...`。若 `sudo -n` 返回权限错误（`sudo: a password is required` / `not in the sudoers file`），标记该主机磁盘健康为 `permission_denied`（区别于"无盘/无控制器"），**不产生 critical 坏盘误报**，仪表盘提示"权限不足，请配置免密 sudo"。
1. 探测可用的 storcli：依次尝试 `disk_health.storcli_candidates`（含 `/usr/local/bin/storcli`、`/opt/MegaRAID/storcli/storcli64` 等，或主机级覆盖），执行 `sudo -n <storcli> -v` 确认可用。
2. 枚举控制器：`<storcli> /cALL show J`（失败回退 `show`）。得到控制器数量、型号、固件、BBU/CacheVault 状态。
3. 虚拟盘（VD）：`<storcli> /cX/vall show J`。得到 VD 编号、RAID 级别、State（Optimal/Degraded/Offline/Partially Degraded）、大小。
4. 物理盘（PD）概览：`<storcli> /cX/eall/sall show J`。得到 EID:Slt、DID、State、DG、Size、Intf、Model、SN。
5. 物理盘详情：`<storcli> /cX/eall/sall show all J`。逐盘得到：
   - `State`（UGood/Onln/Offln/Rebuild/Failed/Missing/JBOD…）
   - `Media Error Count`、`Other Error Count`
   - `Predictive Failure Count`
   - `S.M.A.R.T alert flagged by drive`（Yes/No）
   - `Drive Temperature`（解析出摄氏度）
   - `Shield Counter`、`SN`、`Model`、`Firmware Revision`
6. 如 JSON 不可用，用文本解析上述关键字段（正则匹配 `Key = Value`，以及 `Drive /c0/e252/s0 - Detailed Information:` 分段）。

### 7.2 单盘健康判定

对每块物理盘计算 `health` 等级并给出原因：

| 条件 | 等级 | 说明 |
| --- | --- | --- |
| State ∈ {Failed, Offline, Missing, Offln} | **critical** | 盘已失效，需立即更换 |
| State ∈ {Rebuild, Rbld, Copyback, Degraded} | **warning** | 正在重建/降级 |
| Predictive Failure Count > 0 | **warning** | 预测性故障 |
| S.M.A.R.T alert = Yes | **warning** | SMART 预警 |
| Media Error Count > 0 或 Other Error Count > 0 | **warning** | 有坏道/错误计数 |
| 错误计数比上一次快照增加（delta>0） | **warning/critical** | 恶化中，优先更换 |
| 温度 > 阈值（默认 55℃） | **warning** | 过热 |
| 其余 | **healthy** | 正常 |

虚拟盘 / 控制器：VD State 非 `Optimal` → warning/critical；BBU/CacheVault 异常 → info/warning。

### 7.3 展示

仪表盘单机详情中新增"磁盘阵列"区块：
- 控制器卡：型号、固件、BBU/CacheVault 状态。
- 虚拟盘表：VD、RAID 级别、State、容量、健康徽标。
- **物理盘表（重点）**：槽位(EID:Slt)、型号、序列号、State、温度、Media Err、Other Err、Predictive、SMART、Shield、健康徽标与原因。
- 坏盘/预警盘置顶并红色高亮；提供"上次变化"与错误计数趋势（最近 N 次）。

### 7.4 非 storcli 纳管的盘

用 `lsblk -d` / `lsscsi` 枚举系统可见块设备，与 storcli 物理盘对照（按序列号/型号/容量）：
- storcli 能看到的盘：正常展示每盘健康（本设计重点）。
- storcli 看不到、但系统可见的盘（如 v100 的 `INSPUR MCS` 设备、部分 NVMe）：标注 **"未纳管 / 无法获取健康"** 并给出原因（非 LSI/MegaRAID 控制器，或为外部存储）。
- **绝不伪造健康状态**；不把"看不到"当成"坏"或"好"。
- 若后续需覆盖这些盘，再评估 `smartctl`（SATA/SAS）、`nvme-cli`（NVMe）或存储厂商工具，属新增范围，另行确认。
- **已确认（2026-11-06）**：v100 的 4 块 `INSPUR MCS` 设备为**外部存储**，按用户意见忽略、不纳入展示；其余机器 NVMe 等如出现同类情况也按"未纳管"处理。

## 八、数据存储设计（SQLite）

保留现有 `host_metrics_history`（趋势/周报用，不改结构，必要时 `ALTER TABLE` 追加列）。新增：

- `host_latest_snapshot`：`host_name` 主键，`collected_at`、`success`、`raw_json`（完整 `HostMetrics`，供单机详情实时展示）。
- `disk_controller_snapshot`：`id, collected_at, host_name, controller, model, firmware, bbu_state, raw_json`。
- `disk_vd_snapshot`：`id, collected_at, host_name, controller, vd_id, raid_level, state, size, health`。
- `disk_pd_snapshot`：`id, collected_at, host_name, controller, enclosure, slot, did, model, serial, state, media_errors, other_errors, predictive_failures, smart_alert, temperature_c, shield_counter, health, reasons, raw_json`。
- `alerts`：`id, created_at, host_name, category(system|disk|vd|controller), severity, title, message, fingerprint, status(active|resolved), notified_channels, ack_at`。
- `task_state`：`task_name, last_run_at, last_result`（调度 catch-up 用）。

索引：`(host_name, collected_at)`、`(fingerprint)`、`(created_at)`。保留策略：按 `retention_days` 定期清理快照与已解决告警。

## 九、Web 仪表盘设计

技术：Flask + waitress + Jinja2 + 原生 JS（fetch 轮询，无构建链）。

### 9.1 页面

1. **概览页 `/`**：全局摘要（在线/离线/告警数）+ 每台主机卡片：在线状态、CPU/内存/磁盘/GPU 水位条、磁盘健康摘要（`12 正常 / 1 预警 / 0 故障`）、最近采集时间。异常卡片置顶高亮。
2. **单机详情 `/host/<name>`**：复用现有技术报告上下文的展示（基础信息、资源、磁盘挂载、Top 进程、GPU），追加"磁盘阵列"区块。
3. **告警页 `/alerts`**：当前活动告警 + 历史（可确认 ack）。
4. **趋势页 `/host/<name>/trend`**（可选，复用现有 SVG 折线图）：CPU/内存/GPU/磁盘使用率最近 7 天。
5. **关于/设置 `/settings`**：只读展示当前生效配置与轮询周期（修改通过编辑 `config.yaml` 后重启，符合"配置里能修改"）。

### 9.2 API

- `GET /api/overview`：所有主机当前状态摘要。
- `GET /api/host/<name>`：单机最新完整快照 + 磁盘健康。
- `GET /api/alerts?status=active`：告警列表。
- `POST /api/alerts/<id>/ack`：确认告警。
- 前端每 30s 轮询 `overview` 与 `alerts`。

### 9.3 访问控制

- 启用 `dashboard.auth`：未登录跳转 `/login`，校验 `username` 与 `.env` 中的 `password_env`。
- 使用 Flask 签名 session（`session_secret_env`），默认 12 小时过期。
- 监听 `0.0.0.0` 供局域网访问；README 明确提示仅在可信实验室网络使用，并给出防火墙放行说明。

## 十、告警设计

### 10.1 触发规则

- **主机离线**：SSH 连接失败 / 连续 N 次采集失败（默认 2 次防抖）→ critical。
- **资源阈值**：CPU / 内存 / 磁盘 / GPU 显存超过 `alerts.thresholds` → warning。
- **磁盘健康**：见第七节判定（critical/warning）。
- **恢复**：状态从异常回到正常时发送"已恢复"通知，并更新告警 status=resolved。

### 10.2 去重与冷却

- 每条告警生成 `fingerprint`（如 `disk:host:c0:e252:s3:predictive`）。
- 同一 fingerprint 在 `cooldown_minutes` 内只发一次；`repeat_while_active=false` 时持续异常不重复刷。
- 错误计数增加视为"新的恶化事件"，可突破冷却再发一次。

### 10.3 通知通道

- **桌面弹窗**：Windows Toast。优先使用 `winotify` 库；不可用时降级为调用 PowerShell 的 Windows.UI.Notifications 发送，均失败则只写日志。
- **邮件**：复用现有 `mailer`/SMTP，可配置独立告警收件人（默认沿用 `smtp.to_addrs`）。
- **Webhook**：`wecom`（企业微信群机器人）/ `dingtalk`（钉钉自定义机器人，支持加签可选）/ `generic`（POST JSON）。默认关闭，配置 `url_env` 后启用。

告警发送失败不影响采集，写入 `alerts.notified_channels` 记录。

## 十一、报告调度与 catch-up

- 保留日报（技术版 + 领导摘要）、周报，渲染与发送逻辑不变。
- **时区口径**：所有"日期/周"边界统一按 `app.timezone`（默认 `Asia/Shanghai`）本地日界计算，不再使用现有 `DATE(collected_at)` 的 UTC 分桶。入库时间戳带时区信息；查询时按本地日界换算。
- **统计口径**：日/周报表先在"每个自然日"内对高频样本**聚合为日均值**（CPU/内存/磁盘/GPU 等），再基于日均值做周统计，避免 10 分钟高频采样让忙时样本主导、与历史不可比。
- 调度配置沿用 `report.daily_time` / `report.weekly`（新增运行时刻字段；默认日报 09:00、周报周五 16:00）。
- **catch-up**：启动时读取 `task_state.last_run_at`；若"本应发送的最近一次"尚未发送且当前时间已过，则立即补发一次，并在日志注明"补发"。
- PC 已确认 7×24 常开不睡眠，调度可靠性高；仍保留 catch-up 以防进程意外退出后重启漏发。

## 十二、打包与部署（绿色包）

### 12.1 目录结构（发布包）

```text
servermonitor/
├── servermonitor.exe          # PyInstaller 入口
├── _internal/                 # PyInstaller 依赖（onedir）
├── config/
│   ├── config.yaml            # 首次运行若缺失则从模板生成
│   └── .env.example
├── data/                      # SQLite 数据库
├── logs/                      # 运行日志（滚动）
├── ssh/                       # 私钥（可选）
├── 启动.bat                    # 双击启动（后台运行并打开看板）
├── 停止.bat                    # 停止后台进程
└── 注册开机自启.ps1            # 可选：schtasks 注册登录自启
```

### 12.2 首次运行

- 检测 `config/config.yaml` 与 `.env`，缺失则生成模板并提示编辑后重启。
- 校验配置与依赖（Python 已打包，无需用户安装）。
- 启动后在控制台/日志打印看板地址与登录提示。

### 12.3 开发期运行

- 开发机 `pip install -e .[dev]` 后 `python -m servermonitor`（新入口模块），或用 `servermanage` 兼容入口。
- 保留现有测试，新增磁盘解析/告警/调度/Web 测试。

## 十三、安全

- 密码、SSH 口令、Webhook URL 均放 `.env`，不入 YAML、不入日志。
- 看板默认需要登录；session 使用随机 secret。
- SSH 仍用 `AutoAddPolicy`（沿用现状）；README 说明可在可信环境使用，如需更严格可后续加 known_hosts 校验（非本期目标）。
- 数据库与日志仅存本机。

## 十四、错误处理

- 单主机采集失败：记录失败原因，仪表盘标红，不影响其它主机。
- storcli 未安装/无控制器：该主机磁盘健康标 `N/A` 并给出原因，不影响系统采集。
- **sudo 权限不足**：标 `permission_denied`（不是 `critical`），提示配置免密 sudo；绝不因权限问题误报坏盘。
- storcli JSON 解析失败：回退文本解析；仍失败则记录原始输出片段便于排查。
- Web 服务端口占用：启动失败并提示更换端口。
- 任一通道通知失败：写日志，不重试阻塞主流程。

## 十五、测试策略

- 复用现有 pytest 结构与 fixtures。
- 新增单元测试：
  - `storcli` JSON/文本输出解析（含坏盘、预测性故障、SMART 告警、温度、错误计数增加等样本）。
  - 单盘健康判定（各状态/阈值/变化）。
  - 告警去重与冷却逻辑。
  - 调度 catch-up 计算（含 PC 关机跨天场景）。
  - Web 路由与登录鉴权（Flask test client）。
- 集成冒烟：用 mock SSH runner 跑一轮状态轮询 + 磁盘健康，断言入库与 API 输出。
- 用真实机器输出（用户提供）固化解析回归样本。

## 十六、迁移与兼容（先并存、再切换）

- 现有 `config.yaml` / `.env` 保持可用；新增配置段均有默认值。
- 现有 `host_metrics_history` 与周报逻辑不变；因统计口径改为本地时区，迁移历史库时**不做破坏性改写**，查询层同时兼容旧 UTC 数据（按记录的显式时间戳换算），避免把历史当过期数据删除。
- 现有 Docker 部署方式保留为可选；本期先与 PC 版**并存观察**。

### 16.1 并存期规则（避免重复推送）

- 同一时间**只允许一方**发送日报/周报/告警：
  - 并存观察期：让 PC 版**只做采集与看板展示**（`reports.daily_enabled=false`、`reports.weekly_enabled=false`、`alerts.enabled=false` 或仅桌面），Docker 继续负责邮件推送。
  - 观察确认 PC 采集与磁盘健康无误后，切换为 **PC 主导**：在 Docker 侧关闭 `CRON_SCHEDULE`/`WEEKLY_CRON_SCHEDULE`，PC 侧开启 `reports`/`alerts`。
- 仪表盘"设置/关于"页显示当前"报告归属方（PC / Docker / 关闭）"，避免误配。

### 16.2 切换清单

1. 校验 PC 版能 SSH 全部主机（含 `sudo -n`）。
2. 校验磁盘健康解析与真实 storcli 输出一致（抓样本回归）。
3. PC 侧开启看板与桌面告警，观察 1–3 天。
4. Docker 侧停掉 cron（或整机停容器），PC 侧开启邮件与报告。
5. 观察一周后停用旧 Docker（或保留为冷备）。
6. 如需历史连续，将旧 `data/servermanage.db` 拷贝到 PC `data/` 后按本地时区口径核对一次。

## 十七、目录结构（改造后）

```text
servermanage/
├── servermanage/                # 复用并扩展
│   ├── main.py                  # 保留 CLI（报告），新增服务入口
│   ├── app.py                   # 新：服务总入口（调度 + Web）
│   ├── config.py                # 扩展配置
│   ├── models.py                # 扩展数据模型
│   ├── ssh_client.py            # 复用
│   ├── collectors.py            # 复用
│   ├── parsers.py               # 复用
│   ├── disk_health.py           # 新：storcli 采集 + 解析 + 健康判定
│   ├── storage.py               # 扩展表与查询
│   ├── scheduler.py             # 新：调度 + catch-up
│   ├── alerts.py                # 新：规则 + 去重 + 多通道
│   ├── notify_desktop.py        # 新：Windows Toast
│   ├── notify_webhook.py        # 新：企业微信/钉钉/通用
│   ├── web/                     # 新：Flask 蓝图、模板、静态资源
│   │   ├── __init__.py
│   │   ├── routes.py
│   │   ├── templates/
│   │   └── static/
│   ├── report.py / weekly.py / mailer.py  # 复用
│   └── templates/               # 现有邮件模板
├── packaging/
│   ├── servermonitor.spec       # PyInstaller 配置
│   └── build.ps1               # 打包脚本
├── config.yaml.example / .env.example
├── pyproject.toml              # 增加 flask/waitress/winotify 等依赖
└── tests/
```

## 十八、里程碑（建议）

1. **抓真实样本**（从 PC 经 `sudo -n` 直连）固化为回归 fixture；随后做配置/存储扩展 + 磁盘健康解析与健康判定（含测试）。
2. 调度器 + 告警引擎 + 多通道通知。
3. Web 仪表盘（概览/详情/告警/登录）。
4. 报告调度与 catch-up 整合。
5. PyInstaller 绿色包 + 启动脚本 + README。
6. 真实服务器联调与打包验证。

## 十九、决策落定情况

builder-check 的 7 个问题已在第 2.1 节及对应章节全部落定；现场勘察与真实 storcli 样本解析均已完成（见 2.2，样本在 `samples/storcli/`）。

已确认决策（2026-11-06，无遗留）：

- 提权方案：**A. 受限 NOPASSWD sudo**（2.3 节）。
- v100 的 4 块 `INSPUR MCS`：**外部存储，忽略**（7.4 节）。
- 技术选型：Flask + waitress + Jinja2 + 原生 JS；自研调度线程；PyInstaller onedir；storcli JSON 优先。

以下属实现细节，不再询问：
- Windows Toast 具体库（`winotify` vs PowerShell 直调）：实现期按打包成功率择优。
- 趋势图：默认提供（复用 SVG 折线）。
- 维护/静默时段：默认不做，后续可加。
- 杀软拦截：打包后实测，必要时加白名单/代码签名。
