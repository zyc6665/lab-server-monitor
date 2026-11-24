"""v0.1.185：告警页把主机/类别/时间/排序收进「更多筛选」。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_more_filters_wrapped():
    html = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-more-toggle"' in html
    assert 'id="alert-more"' in html
    start = html.index('id="alert-more"')
    block = html[start:]
    for name in ("alert-host-filter", "alert-category-filter", "alert-range-filter", "alert-sort"):
        assert name in block
    # search box stays in the primary row, before the toggle
    assert html.index('id="alert-search"') < html.index('id="alert-more-toggle"')


def test_more_filters_script_and_style():
    js = app_js_source(STATIC)
    assert "function bindAlertMore()" in js
    assert "apply(panel.hidden);" in js
    assert "bindAlertTimeline();\n    bindAlertMore();" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.185 告警筛选收进" in css
    assert ".alert-more[hidden] { display: none !important; }" in css
