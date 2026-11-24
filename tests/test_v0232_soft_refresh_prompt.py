"""v0.1.232：主机详情软刷新 + 主题化输入对话框。

- 主机详情页的「立即采集 / 运行服务检查」完成后此前 ``location.reload()``：
  Electron 下白屏闪烁、滚动位置丢失。现在重新拉取当前页面并只替换 ``<main>``，
  重新绑定事件（事件绑定收进可重入的 ``mountDetail()``），趋势区间保持用户选择。
- 「复制主机」此前用阻塞式 ``window.prompt``：换成 ``servermonitorPrompt``
  主题输入对话框（Enter 提交、Esc 取消、空值视为取消）。
- 至此设置相关脚本不再有任何阻塞式原生弹窗（confirm/prompt/alert）。
"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_host_detail_soft_refresh_replaces_reload():
    script = _read("host-detail.js")
    assert "function softRefreshDetail()" in script
    assert "function mountDetail()" in script
    assert "mountDetail();" in script
    # 采集完成与运行检查两条路径都走软刷新
    assert "softRefreshDetail().then(function () { setStatus(''); });" in script
    assert "window.setTimeout(softRefreshDetail, 900);" in script
    # 只剩兜底：结构异常时才整页 reload
    assert script.count("window.location.reload()") == 1
    # 会话过期时跳登录而不是把登录页塞进 main
    assert "response.url.indexOf('/login') !== -1" in script


def test_mount_detail_preserves_history_range():
    script = _read("host-detail.js")
    assert "loadHistory(historyRange || '24h');" in script
    assert "tab.getAttribute('data-history-range') === historyRange" in script


def test_settings_uses_input_dialog_for_host_copy():
    settings = _read("settings.js")
    assert "window.servermonitorPrompt({" in settings
    assert 'value: name + "-copy",' in settings
    assert "window.prompt(" not in settings


def test_app_exports_prompt_dialog():
    script = app_js_source(STATIC)
    assert "function servermonitorPrompt(options)" in script
    assert "window.servermonitorPrompt = servermonitorPrompt;" in script
    # Enter 提交、Esc 取消、空输入视为取消
    assert "if (event.key === 'Enter') { event.preventDefault(); submit(); }" in script
    assert "finish(value || null);" in script


def test_no_blocking_native_dialogs_left_in_settings_scripts():
    for name in ("settings.js", "settings-health.js", "settings-update.js"):
        script = _read(name)
        assert "window.confirm(" not in script, name
        assert "window.prompt(" not in script, name


def test_input_dialog_styles_exist():
    css = _read("style.css")
    assert ".confirm-dialog-input {" in css
