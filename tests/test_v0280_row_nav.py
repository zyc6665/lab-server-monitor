"""v0.1.180：主机表整行可点进详情，键盘也能用。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_script_navigates_from_rows():
    js = app_js_source(STATIC)
    assert "function bindHostRowNavigation()" in js
    assert "bindHostRowNavigation();" in js
    assert "event.target.closest('a, button, input, select, textarea, label')" in js
    assert "window.location.href = '/host/' + encodeURIComponent(row.getAttribute('data-host'));" in js
    assert "if (event.key !== 'Enter') { return; }" in js
    assert "tr.setAttribute('tabindex', '0');" in js


def test_style_marks_clickable_rows():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.180 主机表整行可点 -- */" in css
    assert "#host-table tbody tr[data-host] { cursor: pointer; }" in css
    assert "#host-table tbody tr[data-host]:focus-visible" in css
