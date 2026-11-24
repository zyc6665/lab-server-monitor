"""v0.1.210：概览趋势图带首/中/末三个时间刻度。"""

from __future__ import annotations

import re
from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return app_js_source(STATIC)


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
    # M2: the function may live in app.js (2-space indent) or an extracted
    # module (no indent); cut at the first closing brace at line start.
    match = re.search(r"\n\s*}\n", hover)
    hover = hover[: match.start()] if match else hover
    assert "tick.textContent" not in hover
