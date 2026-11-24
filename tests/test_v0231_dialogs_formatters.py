"""v0.1.231：全站确认对话框 + 共享格式化器。

- ``window.confirm`` 原生弹窗在 Electron 下会冻结整窗渲染，且与站内对话框
  风格割裂；此前一个页面一套确认方式（原生 confirm / 站内 dialog / 无确认）。
  现在 app.js 提供 ``servermonitorConfirm``，设置相关页面的四个破坏性操作
  （删除主机、解除静默、恢复备份、安装更新）全部换成主题对话框。
- 字节格式化此前四处实现、口径不一（settings-health 的 TB 级显示成
  "2048.00 GB"）；静默时间直接 ``toLocaleString``。现在统一走
  ``window.servermonitorFmt``。
"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 共享对话框与格式化器
# ---------------------------------------------------------------------------


def test_app_exports_shared_confirm_and_formatters():
    # M2：对话框实现已抽到 lib/ui.js，app.js 改为 import 并保持全局门面。
    script = app_js_source(STATIC)
    ui = (STATIC / "lib" / "ui.js").read_text(encoding="utf-8")
    assert "export function servermonitorConfirm(options)" in ui
    assert "window.servermonitorConfirm = servermonitorConfirm;" in script
    assert "window.servermonitorFmt = { bytes: formatBytesShared, stamp: formatStampShared };" in script
    # 危险操作用 danger 按钮并可自定义文案
    assert "opts.danger ? 'danger-button' : 'primary-button'" in ui


def test_no_native_confirm_left_in_settings_scripts():
    for name in ("settings.js", "settings-health.js", "settings-update.js"):
        script = _read(name)
        assert "window.confirm(" not in script, f"{name} still uses window.confirm"


def test_destructive_actions_use_the_dialog():
    settings = _read("settings.js")
    assert "确定删除主机 " in settings and "servermonitorConfirm({" in settings
    assert "确定解除这条静默吗" in settings
    health = _read("settings-health.js")
    assert "servermonitorConfirm({" in health and "确定继续吗？" in health
    update = _read("settings-update.js")
    assert "servermonitorConfirm({" in update and "安装更新" in update


def test_confirm_dialog_styles_cover_dark_theme():
    css = _read("style.css")
    assert ".confirm-dialog {" in css
    assert ".confirm-dialog::backdrop" in css
    # M3：对话框背景用 --card-bg，暗色在 token 块重定义
    assert ".confirm-dialog {" in css and "background: var(--card-bg)" in css
    # 复用 v0.1.224 的对话框按钮行
    assert ".user-confirm-foot" in css
    assert ".danger-button {" in css


# ---------------------------------------------------------------------------
# 共享格式化器
# ---------------------------------------------------------------------------


def test_settings_silence_times_use_shared_stamp():
    settings = _read("settings.js")
    assert "window.servermonitorFmt.stamp(silence.starts_at)" in settings
    assert ".toLocaleString(" not in settings


def test_settings_health_format_bytes_delegates_to_shared():
    script = _read("settings-health.js")
    assert "window.servermonitorFmt.bytes(value)" in script
    # 旧的 GB 封顶实现必须移除（TB 会显示成 2048.00 GB）
    assert "(1024 * 1024 * 1024)).toFixed(2) + ' GB'" not in script


def test_shared_bytes_uses_tb_units():
    script = _read("lib/format.js")
    assert "num >= 1099511627776" in script
    assert "' TB'" in script
