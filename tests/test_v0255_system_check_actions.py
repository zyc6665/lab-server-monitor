"""v0.1.155：系统自检卡可重新检查、复制结果。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_card_has_actions():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="system-check-refresh"' in page
    assert 'id="system-check-copy"' in page
    assert "重新检查" in page and "复制结果" in page


def test_script_builds_summary_text_and_wires_buttons():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var lastSystemChecks = null;" in js
    assert "function systemChecksText()" in js
    assert "lines.push('- [' + state + '] '" in js
    assert "function copyText(text)" in js
    assert "function bindSystemCheckActions()" in js
    assert "refresh.textContent = '检查中…';" in js
    assert "copy.textContent = '已复制';" in js
    assert "bindSystemCheckActions();" in js
    # 记住最近一次结果，才能复制
    assert "lastSystemChecks = payload || null;" in js


def test_styles_for_action_row():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.155 系统自检的重新检查与复制 -- */" in css
    assert ".check-actions {" in css
    assert ".check-actions .btn-link { font-size: 12.5px; }" in css
