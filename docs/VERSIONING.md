# 版本号与发布规则

本文件说明项目版本号的**单一事实来源**、当前状态与自此往后的发布约定。

## 1. 机器可读版本（唯一事实来源）

| 文件 | 字段 | 当前值 | 作用 |
| --- | --- | --- | --- |
| `pyproject.toml` | `[project] version` | `0.1.236` | Python 包版本、pip 元数据 |
| `desktop/package.json` | `version` | `0.1.236` | Electron 应用版本，`app.getVersion()` 读取 |
| `servermanage/__init__.py` | `__version__` | `0.1.236` | 界面右上角版本、`/api/system/health`、侧栏版本显示 |

三处由 `tools/bump_version.py <version>` 一次性同步，**不要在别处硬编码版本号**。

## 2. 对外发布版本（GitHub Releases）

`.github/workflows/release-windows.yml` 支持两种触发方式：

1. 推送 `v*` 标签 —— 版本号取标签去掉前缀 `v`（`github.ref_name.TrimStart("v")`）；
2. 手动 `workflow_dispatch` —— 版本号取输入的 `version`（工作流说明示例为 `1.5.1`）。

工作流在构建前执行 `python tools/bump_version.py <version>`，因此**发布产物的版本与三处文件一致**，产物命名
`lab-server-monitor-Windows-x64-v<version>.zip`，并生成 `.zip.sha256`、创建同名 `v<version>` Release。

## 3. 当前存在的问题（尚未归一）

- 仓库内三处版本为 `0.1.236`，而 README 记载的桌面端发布线已到 `v1.6.1`（另见 CHANGELOG 的 v1.2–v1.6 章节）。
- `release/服务器轮询监测工具-Windows-x64-v0.1.236.zip` 是**本地 `packaging/build-portable.ps1` 产出**，未经过发布工作流，
  版本号停留在 `0.1.x` 线。
- 自动更新（`desktop/electron/updater-core.js`）用 `app.getVersion()` 与 Release 标签比较。当前安装 0.1.236 的机器
  会判定线上 `v1.6.1` 更高，从而**反复提示可更新、更新后版本号回落到 0.1.236**，形成「已是最新却提示更新」的循环。

## 4. 约定（自此往后）

1. **发布前必须 bump**：对外分发前执行 `python tools/bump_version.py <x.y.z>`，并让 `<x.y.z>` 与即将创建的 Release 标签一致。
2. **本地构建不得直接对外分发**：`build-portable.ps1` 产物仅供内部验证；对外发布走 `release-windows.yml`，由工作流注入版本。
3. **版本线归一（2026-11-23 已决策：A，留在 0.1.x 线）**：后续发布标签一律 `v0.1.237`、`v0.1.238`……；历史 `v1.x` Release 由维护者在 GitHub 上标记为 **prerelease**（或删除）；`desktop/electron/updater-core.js` 已加防御（忽略 prerelease/draft，忽略 major 不一致的标签）；`python tools/bump_version.py --check` 在 CI 中校验三处版本一致。原 A/B 备选记录如下：
   - **A. 回落到 0.1.x 线**：后续发布标签改为 `v0.1.237`、`v0.1.238`……与仓库现状一致，历史 `v1.x` 标签保留但不再递增；
   - **B. 抬升到 1.x 线**：仓库三处版本 bump 到 `1.6.2`（或下一个语义化版本），此后一律 `1.x.y`，`0.1.236` 视为历史遗留。
4. **README / CHANGELOG 不写死版本**：文档中以「参见 Release 页面」表述，避免再次出现 `v1.4` 与 `1.6.1` 并存。
