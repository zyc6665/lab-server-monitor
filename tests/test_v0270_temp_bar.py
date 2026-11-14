"""v0.1.170：磁盘温度列带一条相对热度的小柱。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_temperature_cell_has_bar():
    page = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'class="temp-bar"' in page
    assert 'class="temp-bar-fill"' in page
    # 25–65 °C 映射到 0–100%，并夹在区间内
    assert "[[(temp - 25) * 100 // 40, 0]|max, 100]|min" in page
    assert 'style="width: {{ pct }}%"' in page


def test_bar_styles_and_heat_colors():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.170 磁盘温度柱状条 -- */" in css
    assert ".temp-bar {" in css
    assert ".temp-bar-fill {" in css
    assert ".disk-temp.is-hot .temp-bar-fill { background: #d97706; }" in css
    assert ".disk-temp.is-critical .temp-bar-fill { background: #dc2626; }" in css
