"""v0.1.152：设置页主机列表的关键字过滤与排序。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_template_has_filter_bar_and_row_attributes():
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'id="host-filter"' in html
    assert 'id="host-sort"' in html
    assert 'id="host-filter-count"' in html
    assert 'data-host-name="{{ host.name }}"' in html
    assert 'data-host-search="{{ (host.name ~ \' \' ~ host.host ~ \' \' ~ host.username' in html
    assert "data-host-group=\"{{ host.group or '' }}\"" in html


def test_script_filters_and_sorts_without_reloading():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert "function applyHostTable()" in js
    assert 'body.querySelectorAll("tr[data-host-name]")' in js
    assert "row.hidden = !hit;" in js
    assert 'mode === "group"' in js
    assert "body.appendChild(row);" in js
    assert '"匹配 " + visible + " / " + rows.length + " 台主机"' in js
    assert "hostFilterInput.addEventListener(\"input\", applyHostTable);" in js


def test_styles_for_the_filter_bar():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.152 设置页主机列表过滤 -- */" in css
    assert ".host-filter-bar {" in css
    assert ".host-filter-bar input[type=\"search\"] { min-width: 260px; }" in css
