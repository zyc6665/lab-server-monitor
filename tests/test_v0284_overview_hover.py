"""v0.1.184：概览整体趋势也支持悬停读数。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_overview_hover_helpers():
    js = app_js_source(STATIC)
    # M2：纯函数已抽到 pages/overview-trends.js（Node 单测覆盖），app.js 改为 import
    assert "from './pages/overview-trends.js'" in js
    assert "function bindOverviewHover(svg, indexed, values, key, labels)" in js
    module = (STATIC / "pages" / "overview-trends.js").read_text(encoding="utf-8")
    assert "export function overviewPathIndexed(" in module
    assert "export function overviewTrendText(" in module
    assert "var indexed = overviewPathIndexed(values, min, max, width, chartH, padX, padY);" in js
    assert "bindOverviewHover(svg, indexed, values, key, labels || []);" in js
    assert "points.map(overviewPointLabel)" in js


def test_overview_hover_label_and_style():
    js = app_js_source(STATIC)
    assert "label.textContent = (stamp ? stamp + ' · ' : '') + overviewTrendText(values[point[2]], key);" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.184 概览趋势悬停读数" in css
    assert "#overview-trend svg { cursor: crosshair; }" in css
