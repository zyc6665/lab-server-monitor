"""v0.1.162：资源占用排行增加「温度」维度（只读，来自快照）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_rank_tabs_include_temperature():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'data-rank-metric="temp"' in page
    assert ">温度</button>" in page


def test_script_reads_temperature_and_formats_it():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "temp: '温度'" in js
    assert "else if (metric === 'temp') { value = host.temperature_c; }" in js
    # 温度用 °C 展示，柱宽按 0–100 收口
    assert "Math.round(item.value) + ' °C'" in js
    assert "resourceRankMetric === 'temp' ? 85 : 90" in js
    assert "resourceRankMetric === 'temp' ? 70 : 75" in js


def test_overview_payload_exposes_temperature():
    routes = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert routes.count('"temperature_c":') >= 2
