"""v0.1.184：概览整体趋势也支持悬停读数。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_overview_hover_helpers():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function overviewPathIndexed(values, min, max, width, height, padX, padY)" in js
    assert "function bindOverviewHover(svg, indexed, values, key, labels)" in js
    assert "function overviewTrendText(value, key)" in js
    assert "var indexed = overviewPathIndexed(values, min, max, width, height, padX, padY);" in js
    assert "bindOverviewHover(svg, indexed, values, key, labels || []);" in js
    assert "points.map(overviewPointLabel)" in js


def test_overview_hover_label_and_style():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "label.textContent = (stamp ? stamp + ' · ' : '') + overviewTrendText(values[point[2]], key);" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.184 概览趋势悬停读数" in css
    assert "#overview-trend svg { cursor: crosshair; }" in css
