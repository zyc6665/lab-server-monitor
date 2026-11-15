"""v0.1.212：告警时间分布支持 90 天。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _tpl() -> str:
    return (TEMPLATES / "alerts.html").read_text(encoding="utf-8")


def test_timeline_ranges_include_ninety_days():
    js = _js()
    assert "'90d': { hours: 24 * 90, stepHours: 24, label: '90 天' }" in js


def test_template_has_four_range_tabs():
    tpl = _tpl()
    for key in ["24h", "7d", "30d", "90d"]:
        assert f'data-timeline-range="{key}"' in tpl
    assert ">90 天</button>" in tpl
