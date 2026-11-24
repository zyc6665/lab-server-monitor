"""v0.1.219：概览空态说明筛选条件，并提供清除按钮。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _overview() -> str:
    return (TEMPLATES / "overview.html").read_text(encoding="utf-8")


def _js() -> str:
    return app_js_source(STATIC)


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_empty_state_has_text_and_clear_button():
    tpl = _overview()
    assert 'id="empty-state-text"' in tpl
    assert 'id="empty-state-clear"' in tpl
    assert "清除筛选" in tpl


def test_filters_are_described_and_clear_wired():
    js = _js()
    assert "function clearHostFilters()" in js
    assert "emptyClearButton.addEventListener('click', clearHostFilters);" in js
    assert "'没有符合条件的主机：'" in js
    for label in ["分组「", "状态「", "关键字「"]:
        assert label in js, label


def test_empty_state_style_block():
    css = _css()
    assert "v0.1.219 空态可清除筛选" in css
    assert ".empty-state[hidden]" in css
