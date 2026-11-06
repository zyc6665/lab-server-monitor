# 服务器日报巡检设计

## 目标

在一台管理机上，通过 `SSH` 访问多台 Linux 服务器，按日采集资源与进程信息，并通过 `SMTP` 发送一封 HTML 日报邮件，同时提供纯文本兜底版本。

## 已确认需求

- 巡检方式：中心化巡检
- 连接方式：`SSH`，支持密码和私钥
- 目标主机：全部为 Linux
- GPU 类型：全部为 NVIDIA
- 邮件发送：`SMTP` 邮箱账号发送
- 发送策略：每天固定发送 1 封日报
- 报告形式：HTML 邮件，附带纯文本 fallback
- 当前范围：不做自动异常判断，不做即时告警

## 方案选择

### 候选方案

1. `Bash + ssh + mail`
2. `Python + Paramiko + SMTP + cron`
3. `Ansible + 调度 + 邮件`

### 选型结论

采用 `Python + Paramiko + SMTP + cron`。

原因：

- 能同时支持 `SSH` 密码与私钥认证
- 多主机配置结构清晰，扩展成本低
- HTML 邮件模板和纯文本 fallback 更容易维护
- 依赖数量可控，符合 KISS 和 YAGNI

## 总体架构

### 运行流程

1. `cron` 每天触发一次巡检脚本
2. 主脚本加载配置文件和环境变量
3. 逐台通过 `SSH` 登录服务器
4. 在远端执行固定命令采集系统与 GPU 信息
5. 对命令输出进行结构化解析
6. 生成 HTML 日报和纯文本 fallback
7. 通过 `SMTP` 发送到指定收件人
8. 将运行日志写入本地日志文件

### 模块划分

- `config`：配置读取与校验
- `ssh_client`：SSH 连接与命令执行封装
- `collectors`：远端采集编排
- `parsers`：系统命令与 `nvidia-smi` 输出解析
- `report`：HTML / 纯文本邮件渲染
- `mailer`：SMTP 发送
- `main`：主流程与错误处理

## 配置设计

### 文件划分

- `config.yaml`：非敏感配置
- `.env`：敏感配置，例如 SMTP 密码、SSH 密码
- `logs/`：运行日志目录

### 配置内容

`config.yaml` 中包含：

- SMTP 主机、端口、发件人、收件人
- SMTP 密码对应的环境变量名
- SSH 连接超时、命令超时
- 服务器列表
- 邮件主题前缀

每台服务器配置：

- `name`
- `host`
- `port`
- `username`
- `auth.type`：`password` 或 `key`
- `auth.password_env` 或 `auth.key_path`

### 配置原则

- 密码不写死在 YAML 中
- 允许密码与密钥认证混用
- 启动时先做配置校验，提前暴露错误

## 采集范围

### 基础信息

- 主机名
- IP
- 采集时间
- 系统版本
- 内核版本
- 运行时长

### CPU / 内存 / 磁盘

- `load average`
- CPU 核数
- CPU 总体使用率
- 内存总量、已用、可用、使用率
- Swap 使用情况
- 各挂载点磁盘容量与使用率

### 用户与进程

- 当前在线用户
- 当前总进程数
- 按用户汇总的进程数量
- CPU Top 10 进程
- Memory Top 10 进程

### GPU

通过 `nvidia-smi` 采集：

- GPU 型号
- GPU 数量
- 利用率
- 显存已用 / 总量
- 温度
- GPU 进程列表

GPU 进程字段：

- GPU 编号
- PID
- 用户
- 占用显存
- 进程命令

### 兼容性处理

- 无 GPU：报告中标记 `N/A`
- `nvidia-smi` 不可用：标记为 GPU 信息不可获取
- 某条命令失败：仅影响对应字段，不中断整台主机采集

## 邮件设计

### 发送格式

采用 `multipart/alternative`：

- `text/plain`
- `text/html`

### HTML 风格

- 兼容优先，不使用外链 CSS、JS、图片
- 使用内联样式
- 单列布局，适配桌面与移动端邮箱
- 使用简洁卡片和表格结构
- 白底 / 浅灰底 + 克制状态色

### HTML 内容结构

1. 顶部摘要区
2. 失败主机区
3. 逐台服务器详情卡片

每台服务器详情卡片包含：

- 基础信息
- 资源概览
- 磁盘信息
- 在线用户
- Top CPU 进程
- Top Memory 进程
- GPU 摘要
- GPU 进程

### 纯文本 fallback

保留结构化纯文本版本，确保弱兼容客户端也能阅读核心信息。

## 错误处理

- 某台主机 SSH 失败：记录失败原因，并继续其他主机
- 单台主机部分字段采集失败：邮件中标注，不影响整封日报
- SMTP 发送失败：写日志并返回非 0 退出码
- 配置缺失：启动前失败并输出明确错误

## 非目标

当前版本不包含：

- 自动异常阈值判断
- 即时告警邮件
- 历史数据持久化
- Web 页面
- 分布式 agent
- 趋势图表

## 目录建议

```text
servermanage/
├── config.yaml.example
├── .env.example
├── pyproject.toml
├── README.md
├── logs/
├── servermanage/
│   ├── __init__.py
│   ├── main.py
│   ├── config.py
│   ├── models.py
│   ├── ssh_client.py
│   ├── collectors.py
│   ├── parsers.py
│   ├── report.py
│   ├── mailer.py
│   └── templates/
│       ├── report.html.j2
│       └── report.txt.j2
└── tests/
    ├── test_config.py
    ├── test_parsers.py
    ├── test_report.py
    └── test_main.py
```

## 运维部署方式

定时调度使用 `cron`，例如：

```cron
0 9 * * * /usr/bin/python3 /opt/servermanage/servermanage/main.py --config /opt/servermanage/config.yaml >> /opt/servermanage/logs/cron.log 2>&1
```

## 原则说明

- `KISS`：中心化单脚本 + SMTP + cron，避免引入额外平台
- `YAGNI`：只做日报，不做历史、告警、图表和 Web
- `DRY`：统一主机配置、统一采集命令、统一模板渲染
- `SOLID`：按配置、连接、采集、解析、渲染、发送分层
