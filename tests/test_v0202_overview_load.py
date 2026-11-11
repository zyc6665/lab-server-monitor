"""v0.1.102：概览整体趋势新增负载（1 分钟）维度。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def test_overview_has_load_chart():
    html = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'data-overview-trend="load_1"' in html
    assert 'data-overview-latest="load_1"' in html
    assert "负载平均（1 分钟）" in html


def test_script_draws_five_series():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "load_1: '#0ea5e9'" in script
    assert "var OVERVIEW_TREND_KEYS = ['cpu', 'memory', 'disk', 'gpu_util', 'load_1'];" in script
    assert "OVERVIEW_TREND_KEYS.forEach(function (key) {" in script
    # 负载不是百分比，单独格式化
    assert "key === 'load_1' ? numbers[numbers.length - 1].toFixed(2)" in script


def test_styles_use_five_columns_on_wide_screens():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.102 概览趋势负载维度")[1]
    assert "grid-template-columns: repeat(5, minmax(0, 1fr));" in tail
