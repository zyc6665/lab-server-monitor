# 用户模式 / 管理员模式 设计（v0.4.0）

## 目标

同一份客户端支持两种使用者：

- **管理员模式**（默认）：现有全部功能——所有主机、磁盘阵列、告警、服务器用户、终端、报告、维护。
- **用户模式**：实验室普通成员使用。只显示"我在哪些服务器上有账号"和"我的账号状态/占用"，隐藏一切需要管理员视角的内容。

身份采用"每份客户端一个模式"：用户在设置里选用户模式并填写自己的 Linux 账号名。不做多账号登录、不在服务端维护成员密码。

**安全边界说明**：模式是界面与接口的使用者约束，不是多租户隔离。SSH 凭据仍保存在本机，用户模式下不提供提权与批量操作入口；真正的权限边界依旧是服务器上的 sudo 与文件权限。

## 配置

`AppRuntimeConfig` 增加：

- `mode: str = "admin"`，取值 `admin` / `user`。
- `member_account: str = ""`，Linux 账号名，`^[a-z_][a-z0-9_-]{0,31}$`。

规则：

- `mode=user` 时 `member_account` 必填，否则配置错误（`ConfigError` / `SettingsError`，接口 400）。
- `mode=admin` 时忽略并清空 `member_account` 的展示含义（保留存储值，便于切回用户模式）。

持久化：`app_settings` 的 `monitoring` 分区新增 `mode`、`member_account`；`public_settings()["monitoring"]` 回传两者。YAML 中位于 `app.mode` / `app.member_account`。

## 服务端约束

`before_request` 在登录校验之后增加模式闸门。用户模式下允许的路径：

- `/login`、`/setup`、`/logout`、`/static/*`
- `/`（302 到 `/my`）、`/my`、`/api/my/summary`
- `/settings`、`/api/settings`、`/api/settings/monitoring`（仅 `mode`/`member_account` 两个键）、`/api/settings/password`
- `/api/runtime`

其余一律拒绝：HTML 页面 302 到 `/my`；`/api/*` 返回 403 `{"error": "admin_only", "message": "该功能仅在管理员模式下可用"}`。

用户模式下 `/api/users`、`/api/overview` 等不开放，避免顺带暴露其他成员信息。

## 我的服务器

`GET /api/my/summary` 返回：

```json
{
  "mode": "user",
  "member": "zhouyc",
  "generated_at": "2026-11-09T21:30:00+08:00",
  "hosts": [
    {
      "name": "a100",
      "address": "202.119.189.245",
      "status": "ok",
      "last_scan_at": "2026-11-09 21:10",
      "last_error": null,
      "account": { "username": "...", "uid": 1000, "groups": [...], "in_docker": true, "in_sudo": false, "home": "/home/zhouyc", "home_bytes": 1, "data_bytes": 2, "issues": [...] }
    }
  ]
}
```

实现：复用 `_build_users_payload`（含 present/missing 合并），按 `member_account` 过滤每台主机的账号行；只保留"该主机存在我的账号，或基线里有我但当前缺失"的主机；`account` 为 `null` 的主机不返回。

`GET /my` 渲染「我的服务器」页面：顶部显示当前账号与统计（有账号的主机数、在线数、异常数、总占用），下面是每台主机一张卡片，展示主机名/地址/在线状态、我的账号状态、docker/sudo 徽标、家目录与 `/data` 占用条、问题清单。没有任何主机时给出明确提示（账号名是否写错、是否还没采集）。

## 设置页

用户模式下 `/settings` 渲染精简版 `settings_user.html`：只有「使用模式」卡片（显示当前账号、切回管理员模式按钮）与「软件更新」卡片（桌面端）以及修改密码。不渲染主机、SSH、告警、邮件、报告、日志、系统状态等分区。

管理员模式的设置页在「监控与采集」分区新增「使用模式」单选（管理员模式 / 用户模式）+ 账号名输入；切到用户模式时提交 `mode=user&member_account=...`，保存成功后前端整页刷新。

## 导航

`base.html` 在用户模式下只渲染「我的服务器」「设置」两个入口，标题栏右侧保留主题切换与账号名；全局命令面板不加载（它依赖 `/api/overview`）。

## 测试

- 配置解析：`mode`/`member_account` 校验收敛、用户模式缺账号报错、YAML 兼容。
- 设置服务：`save_section("monitoring", ...)` 往返、非法模式 400、用户模式下只允许改这两个键。
- 模式闸门：用户模式下 `/disk-health` 302、`/api/alerts` 403、`/api/users` 403、`/api/settings/monitoring` 允许、`/my` 200；管理员模式全部放行。
- `/api/my/summary`：只含自己的账号；缺失账号时 `account.state="missing"`；其他主机不出现。
- 页面：用户模式导航只有两个入口、`/my` 渲染账号与占用、设置页为精简版。
