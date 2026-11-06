# 服务器 HTML 日报巡检工具

这是一个给多台 Linux 服务器做日报巡检的 Docker 工具喵～

它会做这些事：

- 通过 SSH 连接多台服务器
- 采集 CPU、内存、磁盘、在线用户、进程、NVIDIA GPU 信息
- 每天定时发一封 HTML 邮件到指定收件人
- 容器常驻，容器内用 `supercronic` 定时执行

这份 README 不讲太多原理，只讲怎么一步一步部署成功喵～

## 你需要提前准备什么

在开始之前，主人先准备好这些东西：

- 一台已经安装好 Docker 和 Docker Compose 的机器
- 一个可以发邮件的 SMTP 邮箱账号
- 这个邮箱对应的 SMTP 授权码或密码
- 至少一台能通过 SSH 登录的 Linux 服务器
- 如果要用私钥登录，再准备一个私钥文件

如果这些还没准备好，先不要往后走，不然后面大概率会卡住喵～

## 第 1 步：把项目放到一台机器上

把项目放到一台准备长期运行的机器上，例如：

```bash
mkdir -p "/opt/servermanage"
cd "/opt/servermanage"
```

如果项目代码已经在这里了，就直接进入项目目录：

```bash
cd "/opt/servermanage"
```

## 第 2 步：准备目录和配置文件

在项目根目录执行：

```bash
mkdir -p "ssh"
cp "config.yaml.example" "config.yaml"
cp ".env.example" ".env"
```

做完后，目录至少应该像这样：

```text
.
├── config.yaml
├── .env
├── ssh/
│   └── id_rsa
├── Dockerfile
├── docker-compose.yml
└── docker/
    └── entrypoint.sh
```

说明：

- `config.yaml`：主配置文件
- `.env`：放密码和授权码
- `ssh/`：放私钥

如果主人不用私钥登录，`ssh/` 目录可以先保留空着喵～

## 第 3 步：修改 config.yaml

打开 `config.yaml`，重点改下面几块。

### 3.1 修改邮箱配置

把这一段改成自己的 SMTP 信息：

```yaml
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs:
    - "ops@example.com"
    - "admin@example.com"
```

每个字段是什么意思：

- `host`：SMTP 服务器地址
- `port`：SMTP 端口
- `username`：发件邮箱账号
- `password_env`：密码对应的环境变量名，不直接写密码
- `use_ssl`：大多数 465 端口填 `true`
- `from_addr`：发件人邮箱
- `to_addrs`：收件人列表，可以写多个

如果主人想指定邮件发送对象，就改 `to_addrs`：

```yaml
to_addrs:
  - "alice@example.com"
  - "bob@example.com"
```

### 3.2 修改服务器列表

这个项目支持两种登录方式混用：

- 密码登录
- 私钥登录

#### 密码登录示例

```yaml
- name: "prod-gpu-01"
  host: "10.10.0.11"
  port: 22
  username: "root"
  auth:
    type: "password"
    password_env: "PROD_GPU_01_SSH_PASSWORD"
```

这里要改的只有：

- `name`：自己起一个名字
- `host`：服务器 IP
- `username`：SSH 用户名
- `password_env`：这个服务器密码在 `.env` 里的变量名

#### 私钥登录示例

```yaml
- name: "prod-gpu-02"
  host: "10.10.0.12"
  port: 22
  username: "ops"
  auth:
    type: "key"
    key_path: "/app/ssh/id_rsa"
    passphrase_env: "PROD_GPU_02_KEY_PASSPHRASE"
```

注意这里的私钥路径一定是：

```yaml
key_path: "/app/ssh/id_rsa"
```

为什么不是宿主机路径？

因为 Docker 容器里只能看到容器内路径。当前 `docker-compose.yml` 会把宿主机的 `./ssh` 挂载到容器里的 `/app/ssh`，所以私钥路径必须写容器内路径喵～

如果私钥本身带口令，还要再加一项：

```yaml
passphrase_env: "PROD_GPU_02_KEY_PASSPHRASE"
```

这个字段表示：

- 私钥文件本身的解锁口令不直接写进 `config.yaml`
- 真实口令放在 `.env`
- 容器启动时从环境变量读取

如果主人使用的是无口令私钥，这个字段可以省略喵～

### 3.3 一份最小可用的 config.yaml 示例

如果主人只想照着改，可以直接参考这份模板：

```yaml
smtp:
  host: "smtp.qq.com"
  port: 465
  username: "your_mail@qq.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "your_mail@qq.com"
  to_addrs:
    - "admin1@example.com"
    - "admin2@example.com"

ssh:
  connect_timeout: 10
  command_timeout: 20

report:
  subject_prefix: "[Server Daily Report]"
  include_failed_hosts: true

servers:
  - name: "gpu-01"
    host: "10.10.0.11"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU_01_PASSWORD"

  - name: "gpu-02"
    host: "10.10.0.12"
    port: 22
    username: "ops"
    auth:
      type: "key"
      key_path: "/app/ssh/id_rsa"
      passphrase_env: "GPU_02_KEY_PASSPHRASE"
```

## 第 4 步：修改 .env

打开 `.env`，把里面的值改成真实的：

```bash
SMTP_PASSWORD="你的SMTP授权码"
PROD_GPU_01_SSH_PASSWORD="你的SSH密码"
PROD_GPU_02_KEY_PASSPHRASE="你的私钥口令"
```

如果 `config.yaml` 里还有别的 `password_env` 或 `passphrase_env`，这里也要加上对应变量，例如：

```bash
GPU_01_PASSWORD="服务器1密码"
GPU_03_PASSWORD="服务器3密码"
GPU_02_KEY_PASSPHRASE="服务器2私钥口令"
```

规则很简单：

- `config.yaml` 里写了什么 `password_env`
- `.env` 里就必须有同名变量
- `config.yaml` 里写了什么 `passphrase_env`
- `.env` 里也必须有同名变量

不然容器启动后会直接报错喵～

## 第 5 步：如果用私钥，把私钥文件放到 ssh/ 目录

如果主人使用私钥登录，把私钥放到：

```bash
ssh/id_rsa
```

例如：

```bash
cp "/root/.ssh/id_rsa" "./ssh/id_rsa"
chmod 600 "./ssh/id_rsa"
```

如果主人只用密码登录，这一步可以跳过。

## 第 6 步：启动容器

在项目根目录执行：

```bash
docker compose up -d --build
```

这一步会做三件事：

- 构建镜像
- 启动容器
- 在容器里启动 `supercronic`

## 第 7 步：检查有没有启动成功

先看容器状态：

```bash
docker compose ps
```

如果正常，应该能看到 `servermanage` 处于运行状态。

再看日志：

```bash
docker compose logs -f servermanage
```

正常情况下，主人应该能看到类似：

- 已生成 supercronic 任务
- 当前 cron 表达式
- 到时间后执行巡检脚本

如果这里已经报错，先不要继续，直接看下面的“常见报错怎么处理”喵～

## 第 8 步：修改每天什么时候发送

打开 `docker-compose.yml`，找到：

```yaml
environment:
  TZ: Asia/Shanghai
  CRON_SCHEDULE: "0 9 * * *"
```

这表示：

- 使用 `Asia/Shanghai` 时区
- 每天早上 `09:00` 执行一次

常见例子：

- 每天早上 8 点：`0 8 * * *`
- 每天晚上 9 点：`0 21 * * *`
- 每 6 小时一次：`0 */6 * * *`

改完后重启容器：

```bash
docker compose up -d
```

## 第 9 步：怎么看邮件有没有发成功

先看容器日志：

```bash
docker compose logs -f servermanage
```

如果脚本执行成功，一般至少说明：

- 配置加载成功
- SSH 已经能连到服务器
- 邮件发送流程已经走通

然后去收件箱看邮件。

如果收件箱没有，再看：

- 垃圾邮件箱
- SMTP 配置是不是对的
- 收件人是不是写错了

## 常见报错怎么处理

### 1. SMTP 认证失败

常见原因：

- `smtp.host` 写错
- `smtp.port` 写错
- `username` 写错
- `.env` 里的 `SMTP_PASSWORD` 不是授权码

处理方法：

1. 确认邮箱服务商的 SMTP 地址和端口
2. 确认 `SMTP_PASSWORD` 填的是授权码，不是网页登录密码
3. 重启容器后再看日志

### 2. SSH 登录失败

常见原因：

- 服务器 IP 写错
- 用户名写错
- 22 端口不通
- 密码变量没写到 `.env`
- 私钥没挂进去
- 私钥口令变量没写到 `.env`

处理方法：

1. 检查 `config.yaml` 里的 `host`、`username`
2. 检查 `.env` 里是否存在对应的 `password_env`
3. 如果用了 `passphrase_env`，检查 `.env` 里是否存在对应变量
4. 如果用私钥，确认宿主机有 `./ssh/id_rsa`
5. 确认 `config.yaml` 里的私钥路径写的是 `/app/ssh/id_rsa`

### 3. 私钥路径错误

如果日志里看到类似：

```text
SSH key path does not exist: /app/ssh/id_rsa
```

说明：

- 宿主机上没有 `./ssh/id_rsa`
- 或者没有正确挂载进容器

处理方法：

```bash
ls -l "./ssh"
```

确认 `id_rsa` 确实存在。

### 4. 收不到邮件

先检查：

- `to_addrs` 是否写对
- 发件邮箱是否真的发出去了
- 收件箱垃圾邮件
- 容器日志里有没有 SMTP 报错

### 5. 容器能启动，但连不到目标服务器

这通常是网络问题，不是脚本问题。

处理方法：

- 默认先用 Docker bridge 网络
- 如果宿主机能 SSH，容器不能 SSH，再考虑把 `docker-compose.yml` 里的 `network_mode` 改成 `host`

## 常用命令

启动：

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
```

查看日志：

```bash
docker compose logs -f servermanage
```

重启：

```bash
docker compose restart servermanage
```

停止：

```bash
docker compose down
```

## 最后再提醒一次

真正要改的文件只有这几个：

- `config.yaml`
- `.env`
- `ssh/id_rsa`（如果用私钥）
- `docker-compose.yml` 里的 `CRON_SCHEDULE`（如果要改定时）

只要这几个地方改对，大多数情况下就能跑起来喵～

---

## Windows PC 绿色包（免 Docker）

除上面的 Docker 部署外，本项目还提供 **Windows 11 绿色包**：用 PyInstaller 打成
`onedir` 目录，解压即用，自带常驻 Web 看板（`http://127.0.0.1:8080`），不依赖
Docker，也不需要安装 Python。

### 和 Docker 版的区别

| 项目 | Docker 版（旧） | Windows PC 绿色包（新） |
| --- | --- | --- |
| 运行方式 | `supercronic` 定时执行日报 | 常驻服务 + 内置调度器 + 本地 Web 看板 |
| 配置文件 | 根目录 `config.yaml` / `.env` | `config/config.yaml` / `config/.env` |
| 示例模板 | 根目录 `config.yaml.example` / `.env.example`（保留不动） | `config/config.yaml.example` / `config/.env.example` |
| 数据库 | 容器内 `data/servermanage.db` | `data/servermonitor.db` |
| 登录方式 | 私钥或密码 | 示例统一用**密码**，无需私钥文件 |
| 启停 | `docker compose up/down` | `启动.bat` / `停止.bat` |

> 根目录旧的 `config.yaml.example`、`.env.example` 仍服务于 Docker 文档，请勿删除；
> PC 版请改用 `config/` 下的新模板。

### 一、构建（开发者，可选）

在装有 Python 3.11+ 的 Windows 上，于项目根目录执行：

```powershell
pwsh packaging/build.ps1
```

脚本会 `pip install -e ".[build]"` 安装 PyInstaller，然后执行
`python -m PyInstaller packaging/servermonitor.spec --noconfirm --clean`，
产物为 `dist/servermonitor/servermonitor.exe`（onedir 形式）。

### 二、组装绿色包目录

把下面这些内容一起拷进 `dist/servermonitor/`：

```text
dist/servermonitor/
├── servermonitor.exe        # 构建产物
├── config/
│   ├── config.yaml          # 由 config.yaml.example 复制并填写
│   └── .env                 # 由 .env.example 复制并填写
├── data/                    # 存放 servermonitor.db（可空目录）
├── logs/                    # 运行日志（可空目录）
├── 启动.bat
├── 停止.bat
└── 注册开机自启.ps1
```

首次使用：

```text
copy config\config.yaml.example config\config.yaml
copy config\.env.example config\.env
```

然后编辑 `config\config.yaml`（服务器 IP、SMTP 等）与 `config\.env`（密码）。

### 三、启动 / 停止 / 开机自启

- **启动**：双击 `启动.bat`（会自检 `servermonitor.exe`、`config\config.yaml`、
  `config\.env`，缺文件给出中文提示并暂停），后台最小化启动，浏览器访问
  `http://127.0.0.1:8080`。
- **停止**：双击 `停止.bat`，会先检测 `servermonitor.exe` 是否存在，存在才结束进程，
  否则给出提示。
- **开机自启**：右键 `注册开机自启.ps1` →「使用 PowerShell 运行」。脚本会创建计划任务
  `ServerMonitorDashboard`（登录时触发），可重复运行（先删除同名任务）；权限不足时自动
  回退到「启动」文件夹快捷方式。

> 1.1 起 `config\.env` 可选：`启动.bat` 只在文件存在时传入，首次也可以不建 `.env`，
> 直接打开网页完成首次设置。

### 四、网页在线设置（1.1 新增）

1. 初次启动后打开 `http://127.0.0.1:8080`，本机会自动跳到 `/setup`，设置管理员密码。
2. 登录后进入「设置」页，可在浏览器里修改：
   - 主机与 SSH 凭据（密码或粘贴私钥）
   - 通知（桌面/邮件/Webhook）与各类阈值
   - 日报/周报启停与发送时间
   - 磁盘健康规则、每台主机的容量监控目录（默认 `/` 和 `/data`）
   - 看板监听地址/端口、管理员密码
3. 保存后轮询任务立即按新配置运行；监听地址/端口改动需要重启程序。
4. 敏感值（SSH 密码/私钥、邮箱密码、Webhook 地址）用**当前 Windows 账户的 DPAPI**
   加密保存在 `data\servermonitor.db`，界面永不回显原文。
5. 把整个文件夹拷到另一台电脑时，请在新电脑重新 `/setup` 并重新填写凭据；
   主机清单、阈值等非敏感配置会保留。
6. 在 Linux/Docker 下运行时设置页为只读，继续使用 `config.yaml` + `.env`。
