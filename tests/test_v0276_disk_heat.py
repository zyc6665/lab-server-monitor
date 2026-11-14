"""v0.1.176：磁盘页可以只看达到指定温度的主机。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_heat_select_and_attributes():
    page = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-heat"' in page
    for value in ("0", "60", "70", "80"):
        assert f'<option value="{value}">' in page
    assert 'data-disk-heat="{{ host.temperature_max or 0 }}"' in page
    assert page.count("data-disk-heat=") >= 2  # 跳转芯片 + 主机卡片
    assert 'id="disk-heat-empty"' in page


def test_script_filters_by_heat_and_remembers():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "var HEAT_KEY = 'disk:heat';" in js
    assert "function heatLimit()" in js
    assert "(limit > 0 && heat < limit)" in js
    assert "saveHeat(heat.value === '0' ? '' : heat.value);" in js
    assert "readHeat();" in js


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.176 只看高温盘 -- */" in css
    assert ".disk-heat select { max-width: 120px; }" in css
