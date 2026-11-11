"""v0.1.95：概览界面密度（舒适 / 紧凑）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _css_tail() -> str:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    return css[css.index("v0.1.95 概览界面密度") :]


def test_template_has_density_toggle():
    html = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'class="view-toggle density-toggle"' in html
    assert 'data-density="cozy"' in html
    assert 'data-density="compact"' in html
    assert html.index('data-density="compact"') < html.index('data-host-view="table"')


def test_density_is_persisted_and_applied():
    js = _js()
    assert "var DENSITY_KEY = 'overview:density';" in js
    assert "function readDensity()" in js
    assert "function applyDensity(value)" in js
    assert "function bindDensity()" in js
    assert "root.setAttribute('data-density', 'compact')" in js
    assert "root.removeAttribute('data-density')" in js
    assert "bindDensity();" in js


def test_density_defaults_to_cozy():
    js = _js()
    assert "return 'cozy';" in js
    assert "value === 'compact' ? 'compact' : 'cozy'" in js


def test_compact_styles_shrink_layout():
    css = _css_tail()
    assert 'html[data-density="compact"] .container' in css
    assert 'html[data-density="compact"] .card' in css
    assert 'html[data-density="compact"] .data-table th,' in css
    assert 'html[data-density="compact"] .host-card' in css
    assert 'html[data-density="compact"] .host-card-grid' in css
    assert 'html[data-density="compact"] .timeline' in css
