# 服务器 HTML 日报巡检工具（ServerMonitor）

Windows 桌面客户端：对多台 Linux 服务器做每日巡检，采集资源指标并生成 HTML 日报邮件。自 **v0.2.0** 起为**单栈安装版**：Electron 桌面端 + Node 后端，通过 NSIS 安装程序 `ServerMonitor-<版本>-Setup.exe` 分发，程序内自动更新。

## 版本与更新记录

- **更新历史**：见 [CHANGELOG.md](CHANGELOG.md)。
- **版本号规则**：以根目录、`backend/`、`desktop/` 三个 `package.json` 的 `version` 为准，由 `node scripts/bump-version.mjs <版本>` 同步，`node scripts/bump-version.mjs --check` 校验；对外发布对应 GitHub Release 标签 `v*`（带 `-rc.N` 等后缀的为 prerelease）。
- **当前版本**：`0.2.0`。

## 它做什么

- 通过 SSH 连接多台 Linux 服务器
- 采集 CPU、内存、磁盘、在线用户、进程、NVIDIA GPU 信息
- 每天定时把一封 HTML 巡检日报发送到指定收件人
- 桌面窗口 + 内置调度器 + 本地看板；关闭窗口后驻留系统托盘，后台继续监测
- 凭据（SSH 密码/私钥、邮箱密码、Webhook）用当前 Windows 账户的 DPAPI 加密保存在本地数据库，界面不回显明文

## 你需要提前准备什么

- 一台 Windows 10/11 电脑
- 一个可发邮件的 SMTP 邮箱账号及 SMTP 授权码
- 至少一台能通过 SSH 登录的 Linux 服务器（私钥登录则准备私钥文件）

## 安装与使用

### 1. 下载并安装

从 [GitHub Releases](https://github.com/zyc6665/lab-server-monitor/releases) 下载最新的 `ServerMonitor-<版本>-Setup.exe` 并运行：

1. 选择**安装目录**（默认 `D:\Tools\ServerMonitor`，无 D 盘时为 `%LOCALAPPDATA%\Programs\ServerMonitor`）；
2. 选择**数据目录**（存放数据库、日志、运行时文件，升级/卸载默认保留）；
3. 完成后从开始菜单或桌面快捷方式启动。

静默安装：`ServerMonitor-<版本>-Setup.exe /S /D=<安装目录>`。

### 2. 首次启动

1. 首次启动自动进入 `/setup`，设置管理员用户名和密码后登录；
2. 「设置 → 主机与 SSH」添加服务器（也可从 `.ssh\config` 批量导入）；
3. 「设置 → 通知 / 报告」填写 SMTP 与收件人、每日发送时间；
4. 回到「概览」查看主机状态。

关闭窗口 = 最小化到托盘；彻底退出请用托盘菜单「退出」。开机自启可在设置页/托盘开关（登录后仅托盘运行、不弹窗）。

### 3. 自动更新

「设置 → 看板与安全 → 软件更新」检查更新；程序通过 electron-updater 从 GitHub Release 下载新安装包（`latest.yml` 校验 sha512）并安装重启，数据目录保留。

### 4. 卸载

「设置 → 应用」或控制面板卸载。卸载时会询问是否删除数据目录，**默认保留**；静默卸载（`/S`）一律保留数据。

## 从旧绿色包（v0.1.x zip）迁移

旧绿色包内置的更新器无法升级到安装版，需要**手动下载一次** `ServerMonitor-<版本>-Setup.exe` 安装。安装版首次启动会自动导入旧目录中的 `data\servermonitor.db`（主机、历史、凭据；凭据须同一 Windows 账户才能解密）。确认无误后退出旧程序，备份旧目录的 `config\`、`data\`、`logs\` 后即可删除旧文件夹；旧的启动/停止/自启脚本不再需要。

## 开发

需要 Node.js 22 与 pnpm（`corepack enable`）：

```powershell
pnpm install                          # 安装工作区依赖
pnpm test                             # 后端测试（vitest）
pnpm --filter servermonitor-backend build
cd desktop; pnpm install; pnpm test; pnpm test:unit
pnpm --filter server-monitor-desktop build   # 产出 desktop/release-electron/ 下 Setup.exe、latest.yml、blockmap
node scripts/bump-version.mjs 0.2.1   # 同步版本号
```

发布：推送 `v*` 标签或手动触发 `release-windows` 工作流，CI 跑 Node 门禁后打包 NSIS 安装包，校验 `latest.yml` 的 sha512 与 Setup.exe 一致，再上传 Setup.exe、`latest.yml`、`.blockmap` 三件到 GitHub Release。

## 常见报错怎么处理

- **SMTP 认证失败**：核对「设置 → 通知」中地址、端口（多数 465/SSL）与 **SMTP 授权码**（不是网页登录密码）。
- **SSH 登录失败**：先在电脑上 `ssh 用户名@地址` 手动验证，再核对「设置 → 主机」字段。
- **私钥不存在**：日志出现 `SSH key path does not exist` 时改为真实私钥路径，带口令的同时填写口令。
- **收不到邮件**：检查收件人、垃圾箱、数据目录下 `logs` 中的日志、发送时间。
- **看板打不开 / 端口占用**：托盘「复制看板地址」查看当前地址，关闭占用程序后重启客户端。

## 最后提醒

- 需要长期保留的是数据目录；换电脑后 DPAPI 加密的凭据无法解密，需在「设置」页重新填写。
