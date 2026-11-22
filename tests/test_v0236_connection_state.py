"""v0.1.236：连接状态去「割裂感」（方案 B）。

桌面客户端的后端是 Electron 自己管理的子进程，但标题栏却挂着一个
**永远显示「已连接」的静态标签**（后端挂了它也不变），加上 HTTP 探活
最长 15 秒才能感知异常——观感割裂且误导。

- Electron 主进程在生命周期各节点（启动完成 / 计划内重启 / 异常退出 /
  恢复成功）通过 IPC 推送状态；preload 暴露 ``onBackendState`` 订阅。
- 标题栏标签改为动态：桌面模式常态隐藏（无信息量），异常时红点闪烁显示
  「连接中断」并即时弹横幅（不等 15 秒探活）；恢复后自动隐藏并刷新数据。
  浏览器模式保留两种状态的显示。
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
ELECTRON = ROOT / "desktop" / "electron"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_main_emits_backend_state_on_lifecycle():
    main = _read(ELECTRON / "main.js")
    assert "function sendBackendState(state)" in main
    assert "webContents.send('desktop:backend-state'" in main
    # 启动完成 / 计划内重启 / 异常退出 / 恢复成功，四个节点都要发
    assert main.count("sendBackendState('running')") >= 3
    assert "sendBackendState('restarting')" in main
    assert "sendBackendState('stopped')" in main


def test_preload_exposes_state_subscription():
    preload = _read(ELECTRON / "preload.js")
    assert "onBackendState: (callback) => {" in preload
    assert "ipcRenderer.on('desktop:backend-state', listener);" in preload
    assert "removeListener('desktop:backend-state', listener);" in preload


def test_titlebar_pill_is_dynamic_and_hidden_by_default():
    html = _read(TEMPLATES / "base.html")
    assert 'id="conn-status-pill"' in html
    assert '<span class="conn-status" id="conn-status-pill" hidden>' in html
    # 不再是写死的静态「已连接」
    assert '<span class="conn-status"><span class="conn-dot" aria-hidden="true"></span>已连接</span>' not in html


def test_app_updates_pill_and_subscribes_ipc():
    script = _read(STATIC / "app.js")
    assert "function updateConnPill(lost)" in script
    assert "window.desktopBridge && window.desktopBridge.isDesktop" in script
    assert "bridge.onBackendState(function (payload)" in script
    # 恢复后自动补一次数据刷新
    assert "setConnectionBanner(false, true);\n            refreshAll();" in script
    # 桌面模式常态隐藏「已连接」
    assert "pill.hidden = Boolean(desktop);" in script


def test_pill_styles_cover_hidden_and_bad_states():
    css = _read(STATIC / "style.css")
    assert ".conn-status[hidden] { display: none; }" in css
    assert ".conn-status.conn-status-bad" in css
    assert "@keyframes conn-blink" in css


def test_custom_recovery_messages_surface_immediately():
    script = _read(STATIC / "app.js")
    assert "'后台服务正在重启…'" in script
    assert "'后台服务已停止，正在自动恢复…'" in script
