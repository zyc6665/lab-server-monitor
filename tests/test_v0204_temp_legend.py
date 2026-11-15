"""v0.1.204：磁盘页给出温度色阶图例。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_template_has_legend():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-legend"' in html
    assert "25 °C 起画、65 °C 满格" in html
    assert "55 °C 起偏热" in html
    assert "65 °C 起过热" in html


def test_style_present():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.204" in css
    assert ".disk-legend-bar" in css
    assert "linear-gradient(90deg, var(--accent), #d97706, #dc2626)" in css
    assert 'html[data-theme="dark"] .disk-legend-critical' in css
