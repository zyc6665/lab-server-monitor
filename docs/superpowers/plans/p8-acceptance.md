# P8 验收记录（去 Python 切割 + 单栈安装版交付）

- 日期：2026-11-26
- 分支：`refactor/single-stack-b1`，基线 HEAD `0a88dc6`，版本 `0.2.0`
- 执行：计划 `2026-11-26-p8-cutover-release-plan.md` Task 8 + Task 9
- 验收过程中**没有修改代码**（本次 commit 只有这份报告）。

## 1. 门禁数字（复跑）

| 门禁 | 结果 |
| --- | --- |
| `pnpm --filter servermonitor-backend typecheck` | 通过 |
| `pnpm --filter servermonitor-backend test` | 97 files；1926 passed / 1 skipped（1927） |
| `cd desktop && pnpm typecheck` | 通过 |
| `cd desktop && pnpm test:unit` | 6 files；122 passed |
| `node scripts/bump-version.mjs --check` | `version consistent: 0.2.0`，exit 0 |
| `node --test scripts/bump-version.test.mjs` | pass 4 / fail 0 |
| `git ls-files \| grep -iE '\.py$\|\.bat$\|\.ps1$'` | 空（0 行） |
| `git ls-files \| grep -iE 'servermanage/\|^tests/\|pyproject\|packaging/'` | 空（0 行） |

## 2. 打包

- 先删除了旧的 `desktop/release-electron`（里面是 0.1.239 的 Setup.exe、blockmap、latest.yml、win-unpacked）。
- 执行 `pnpm --filter servermonitor-backend build`（含 stage-vendor）→ `cd desktop && pnpm build:main && pnpm exec electron-builder --win --publish never`。
- 产物：`ServerMonitor-0.2.0-Setup.exe`（124152606 B）、`ServerMonitor-0.2.0-Setup.exe.blockmap`、`latest.yml`；after-pack 已翻转 fuses；未签名（没有证书）。
- `latest.yml`：`version: 0.2.0`，`sha512: 9S9ilZPotiYn9FCttXwAnMEhg5BQP0PFd36xU0gB74Gi0Bj0yr9H51Y+dVruNvhXoMoJSrRUibA+4FslIVKlSg==`，`size: 124152606`。用 Node 对 exe 实际计算的 sha512(base64) 和 size **与之一致**。

## 3. 静默安装（自定义非 C 盘目录）

- 命令：`ServerMonitor-0.2.0-Setup.exe /S /D=D:\Tools\ServerMonitor_p8test`。exit 0，约 9 s。
- 产物：主程序、`Uninstall 服务器轮询监测工具.exe`、`resources/backend/{main.cjs, assets/{web,report-templates}, node_modules}`（node_modules 6.9 MB）。安装后的 `assets/report-templates` 与仓库 `backend/assets/report-templates` 逐字节相同（`diff -r` 无差异）。
- HKCU 卸载项 `Uninstall\54e6ceab-120a-5096-8c08-4d8706d9fdf7`：`DisplayVersion 0.2.0`，`UninstallString`/`QuietUninstallString` 都指向 `D:\Tools\ServerMonitor_p8test`（参数 `/currentuser [/S]`）。
- **发现（环境问题，不是产品缺陷，未修复）**：安装包直接放在仓库的中文路径 `D:\工具\…\release-electron\` 下执行 `/S` 时，以下三种方式都返回 exit 0，但什么都没装上：PowerShell `Start-Process -Wait`、`cmd /c`、bash 直接调用。复制到 ASCII 路径 `D:\tmp\sm020.exe` 后再执行就成功了。推测与 NSIS 自解压时对非 ASCII 源路径的处理有关。用户正常双击下载目录里的安装包一般不受影响，但**存放路径含中文时的交互安装列为人工待验**。

## 4. 后端冒烟（使用安装产物 `resources/backend/main.cjs`，系统 Node v22.14.0）

| 场景 | 结果 |
| --- | --- |
| 全新数据目录 `--data-dir D:\SMDataP8 --port 28911 --runtime …` | 日志 `no legacy database found; starting with a fresh database`；`/setup` 200、`/login` 302、`/static/style.css` 200、`/api/system/health` 428（setup_required）；生成 `servermonitor.db`(+wal/shm)、`runtime.json` |
| 旧库导入：空数据目录 `D:\SMDataP8Imp` + `SERVERMONITOR_LEGACY_DB=D:\SMLegacySrc\servermonitor.db`（`data/servermonitor.db` 的**副本**）+ `--import-legacy` | 日志 `copied legacy database from D:\SMLegacySrc\servermonitor.db`；生成迁移前备份 `backups/pre-migrate-0-20261126T035733423Z.db`（200704 B）；迁移后 DB 299008 B，21 张表，`alerts` 3 行；`/setup` 200、`/login` 302、CSS 200 |
| 补充：旧库副本直接作为数据目录内的 DB | `existing database found; legacy import skipped`，同样生成 `pre-migrate-0-*.db` 备份，页面同上 |
| 原文件保护 | 测试前后 `data/servermonitor.db` 的 sha256 都是 `b892643c…93bf2a7`，未改动 |
| 报表生成 | 安装产物的报表模板与源码一致；`vitest run test/report`：3 files / 104 passed（`render.test.ts` 62 个用例覆盖 technical/executive/weekly 三种变体）。冒烟时未登录，没有通过 HTTP 触发报表生成（需要 setup 管理员 + 主机数据），列为人工待验 |

## 5. 升级（0.2.0 → 0.2.1，安装器覆盖）

- 用 `node scripts/bump-version.mjs 0.2.1` 临时改版本，构建出 `ServerMonitor-0.2.1-Setup.exe`。
- 预置 HKCU 数据指针 `HKCU\Software\ServerMonitor\DataDir = D:\SMDataP8Imp`（模拟 GUI 首启写入的值）。
- 执行 `sm021.exe /S /D=D:\Tools\ServerMonitor_p8test`，exit 0。卸载项 `DisplayVersion` 变为 0.2.1；`DataDir` 指针保留；数据目录清单哈希升级前后都是 `f4f908f9…`（不变），备份文件仍在；`assets` 完整。
- 用 `node scripts/bump-version.mjs 0.2.0` 恢复版本，`git status` 干净，0.2.1 安装包已删除，没有提交 0.2.1。
- electron-updater 从 rc Release 在线升级的路径：**未做**（需要先 push 并发布 Release）。

## 6. 卸载（静默）

- 执行 `"Uninstall 服务器轮询监测工具.exe" /currentuser /S`，exit 0。
- 程序目录 `D:\Tools\ServerMonitor_p8test` 已完全移除（没有空目录残留）；数据目录 `D:\SMDataP8Imp`（db、backups、runtime.json）**保留**；HKCU 卸载项已移除；`HKCU\Software\ServerMonitor`（DataDir 指针）按 `installer.nsh` 的设计删除（`DeleteRegValue` + `DeleteRegKey /ifempty`）。
- 交互卸载的「否/是」分支（`MB_YESNO|MB_DEFBUTTON2`）需要人工点击，见下表。

## 7. 清理

已删除：测试安装目录、`D:\SMDataP8`、`D:\SMDataP8Legacy`、`D:\SMDataP8Imp`、`D:\SMLegacySrc`、`D:\tmp` 下的临时安装包、脚本和日志、0.2.1 构建产物。保留：`desktop/release-electron` 下的 0.2.0 产物（未入库）。

## 8. 人工待验清单

1. 交互安装向导：默认目录 `D:\Tools\ServerMonitor`、可改目录、快捷方式、首启选择数据目录 → `/setup` → 登录页。
2. 单托盘：第二实例只聚焦窗口；关闭窗口后托盘只有一个图标。
3. 开机自启：开启后注销重登，托盘出现、没有窗口（`--start-hidden`）。
4. 交互卸载三分支：选「否」→ 数据保留且 `$INSTDIR` 无残留；选「是」→ 数据目录删除；运行中卸载 → 提示先退出托盘（重试/取消）。
5. 运行中执行静默覆盖安装：`customCheckAppRunning` 静默模式下 taskkill 后再安装。
6. 安装包存放在中文路径下的交互安装（见 §3 发现）。
7. GUI 内首启自动导入旧库后，主机/历史/密钥在界面中可用；登录后手动生成一份日报/周报。
8. electron-updater 从 GitHub rc Release 在线升级。

## 9. CI

未 push。push 后需要用 rc 版本（如 `0.2.0-rc.1`）触发 `release-windows.yml` 的 workflow_dispatch，验证 ci 绿灯，以及 Release 中三件产物（Setup.exe / latest.yml / blockmap）齐全——**未做**。

## 附：中文路径静默安装问题复核（2026-11-26）

- 结论：与中文路径无关。同一安装包在 `D:\工具\sm_cn_test\`（中文、仓库外）可正常 `/S` 安装。
- 根因：仓库目录继承了开发沙箱 ACL（`Mandatory Label\Low Mandatory Level:(I)(OI)(CI)(NW)` 等），从该处启动的安装程序以 Low 完整性运行，无法写 `D:\Tools` 与 HKCU，静默模式下仍返回 exit 0。
- 处理：无需改代码。在沙箱内构建的安装包须复制到工作区外再执行；可用 `icacls <exe>` 检查是否带 `Low Mandatory Level`。
- 另见：注册表残留旧安装记录但目录已手动删除时，electron-builder 模板的 `uninstallOldVersion` 会弹 "Failed to uninstall old application files"（`/S` 下也会阻塞）；正常安装/升级/卸载流程不触发。
- §8 人工待验中的“中文路径安装”项据此关闭。
