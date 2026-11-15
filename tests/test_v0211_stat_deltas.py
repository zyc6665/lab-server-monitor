"""v0.1.211：主机概览卡片显示较 24 小时前的变化。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _tpl() -> str:
    return (TEMPLATES / "host.html").read_text(encoding="utf-8")


def _js() -> str:
    return (STATIC / "host-detail.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_cards_have_delta_slots():
    tpl = _tpl()
    for key in ["cpu", "memory", "disk"]:
        assert f'data-stat-delta="{key}" hidden' in tpl


def test_script_computes_and_labels_deltas():
    js = _js()
    assert "function renderStatDeltas(points)" in js
    assert "if (historyRange === '24h') { renderStatDeltas(points); }" in js
    assert "'较 24 小时前 持平'" in js
    assert "box.classList.toggle('is-up', delta > 0.05);" in js


def test_style_has_delta_states():
    css = _css()
    assert "v0.1.211" in css
    assert ".stat-delta.is-up" in css
    assert ".stat-delta.is-down" in css
