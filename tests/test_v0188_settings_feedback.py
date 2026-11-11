"""v0.1.88：设置保存后的生效提示。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_js_has_section_messages():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert "var SAVE_MESSAGE = {" in js
    assert 'monitoring: "已保存，下个轮询周期生效"' in js
    assert 'alerts: "已保存，新规则从下一轮判断开始生效"' in js
    assert "function saveMessage(sectionName, restartRequired)" in js
    assert "需重启后台服务后生效" in js


def test_js_no_longer_restarts_silently():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    body = js[js.index("function saveSection(sectionName)") : js.index("qsa(\"[data-save]\")")]
    # 保存流程不应再自动重启，而是交给用户点按钮
    assert "restartBackend()" not in body
    assert "renderSaveNotice(button, message, restartRequired)" in body


def test_js_notice_offers_restart_button():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert "function renderSaveNotice(button, message, restartRequired)" in js
    assert "save-notice-restart" in js
    assert "重启后台服务" in js
    assert "后台已重启，新设置已生效" in js
    assert "重启失败，请手动关闭并重开客户端" in js
    assert "请关闭客户端并重新打开" in js


def test_styles_for_save_notice():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.88 设置保存后的生效提示") :]
    assert ".save-notice {" in tail
    assert ".save-notice-restart {" in tail
    assert ".save-notice-error {" in tail
    assert ".save-notice-action {" in tail
    assert 'html[data-theme="dark"] .save-notice {' in tail
