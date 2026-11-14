"""v0.1.183：趋势图悬停显示读数。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_hover_helpers_exist():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindTrendHover(svg, points, values, key, stamps)" in js
    assert "function stampOf(value)" in js
    assert "svg.addEventListener('mousemove'" in js
    assert "svg.addEventListener('mouseleave'" in js
    assert "points.push([x, y, index]);" in js


def test_hover_label_and_cursor():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "label.textContent = (stamp ? stamp + ' · ' : '') + trendText(value, key);" in js
    assert "var stamps = points.map(function (point) { return stampOf(point.t); });" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.183 趋势图悬停读数" in css
    assert ".trend-block svg { cursor: crosshair; }" in css
