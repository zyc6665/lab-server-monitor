"""v0.1.177：设置页主机表显示采集状态，省得为看在线与否跳到概览。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_status_column():
    page = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert "<th>名称</th><th>状态</th>" in page
    assert 'class="host-status-cell" data-host-status="{{ host.name }}"' in page
    assert 'colspan="11"' in page


def test_script_loads_statuses():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert "function loadHostStatuses()" in js
    assert 'api("GET", "/api/overview")' in js
    assert "status-chip status-" in js
    assert "loadHostStatuses();" in js
    assert "shortStamp(" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.177 设置页显示主机采集状态 -- */" in css
    assert ".status-chip {" in css
    assert "html[data-theme=\"dark\"] .status-offline" in css
