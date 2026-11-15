"""v0.1.210：概览趋势图带首/中/末三个时间刻度。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _trend_block() -> str:
    js = _js()
    start = js.index("function drawOverviewTrend(")
    end = js.index("function bindOverviewHover(", start)
    return js[start:end]


def test_trend_reserves_space_for_ticks():
    block = _trend_block()
    assert "var chartH = height - 12;" in block
    assert "overviewPathIndexed(values, min, max, width, chartH, padX, padY)" in block


def test_trend_renders_three_labels():
    block = _trend_block()
    assert "if (labels && labels.length) {" in block
    assert "tick.textContent = labels[pair[0]];" in block
    assert "svg.appendChild(tick);" in block


def test_ticks_live_in_draw_not_in_hover_binding():
    js = _js()
    hover = js[js.index("function bindOverviewHover("):]
    hover = hover[:hover.index("\n  }\n")]
    assert "tick.textContent" not in hover
