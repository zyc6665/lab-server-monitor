"""v0.1.169：概览统计卡可点，直接按状态筛选主机表。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_cards_carry_filter_values():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'data-stat-filter="online"' in page
    assert 'data-stat-filter="offline"' in page
    assert 'data-stat-filter="alert"' in page
    assert 'role="button"' in page


def test_script_toggles_status_filter():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function bindSummaryCards()" in js
    assert "statusEl.value = statusEl.value === value ? '' : value;" in js
    assert "applyHostFilters();" in js
    assert "table.scrollIntoView({ behavior: 'smooth', block: 'start' });" in js
    assert "bindSummaryCards();" in js
    # 键盘也能触发
    assert "event.key === 'Enter' || event.key === ' '" in js


def test_pointer_and_focus_affordance():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.169 概览统计卡可点筛选 -- */" in css
    assert ".stat-card[data-stat-filter] { cursor: pointer; }" in css
    assert ".stat-card[data-stat-filter]:focus-visible {" in css
