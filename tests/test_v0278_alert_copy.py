"""v0.1.178：告警列表可以一键复制成文本，方便贴到群里。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_copy_button():
    page = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-copy"' in page
    assert "复制列表" in page


def test_script_formats_and_copies():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function alertListText()" in js
    assert "function copyAlertList(button)" in js
    assert "function bindAlertCopy()" in js
    assert "bindAlertCopy();" in js
    assert "rows.slice(0, 50)" in js
    assert "… 其余 " in js
    assert "button.textContent = '已复制';" in js
    assert "button.textContent = '复制失败';" in js
    assert "document.execCommand('copy')" in js
    assert "STATUS_TEXT = { active: '活动'" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.178 复制告警列表 -- */" in css
    assert "#alert-copy { white-space: nowrap; }" in css
