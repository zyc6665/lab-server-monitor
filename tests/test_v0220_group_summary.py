"""v0.1.220：概览按分组汇总，点一组即筛选。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _tpl() -> str:
    return (TEMPLATES / "overview.html").read_text(encoding="utf-8")


def _js() -> str:
    return app_js_source(STATIC)


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_summary_block_present_and_hidden_by_default():
    tpl = _tpl()
    assert 'id="group-summary"' in tpl
    assert 'id="group-summary-grid"' in tpl
    assert "<h2>分组概览</h2>" in tpl


def test_summary_groups_and_filters():
    js = _js()
    assert "function renderGroupSummary(hosts)" in js
    assert "renderGroupSummary(hosts);" in js
    assert "data-group-summary" in js
    assert "select.value = name;" in js
    assert "applyHostFilters();" in js
    assert "name !== '未分组'" in js


def test_summary_style_block():
    css = _css()
    assert "v0.1.220 概览分组汇总" in css
    assert ".group-summary-grid" in css
    assert ".group-summary-item.is-static" in css
