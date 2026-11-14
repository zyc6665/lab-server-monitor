"""v0.1.163：概览「重点关注」按严重级别筛选的入口。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_card_has_severity_container():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="focus-severity" hidden' in page


def test_script_builds_level_links():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function renderFocusSeverity(alerts)" in js
    assert "chip.href = '/alerts?status=active&severity=' + level;" in js
    assert "chip.textContent = pair[1] + ' ' + counts[level];" in js
    assert "box.hidden = shown === 0;" in js
    assert "renderFocusSeverity(alerts);" in js


def test_styles_mark_levels():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.163 重点关注按级别筛选 -- */" in css
    assert ".focus-sev {" in css
    assert ".focus-severity[hidden] { display: none !important; }" in css
    assert ".focus-sev-critical { color: #b91c1c;" in css
