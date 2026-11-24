"""v0.1.203：概览趋势可关闭「对比上一周期」虚线。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_compare_toggle():
    html = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="overview-compare"' in html
    assert "对比上一周期" in html
    # 默认勾选，保持原有行为
    assert 'id="overview-compare" checked' in html


def test_script_respects_toggle():
    js = app_js_source(STATIC)
    assert "var TREND_COMPARE_KEY = 'overview:compare';" in js
    assert "function readTrendCompare()" in js
    assert "(trendCompare ? '&compare=1' : '')" in js
    assert "trendCompare ? ((payload && payload.previous) || []) : []" in js
    assert "compareBox.addEventListener('change'" in js
    assert "saveTrendCompare();" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.203" in css
    assert ".trend-compare" in css
