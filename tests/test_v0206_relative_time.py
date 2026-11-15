"""v0.1.206：概览把采集时间显示成相对时长。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_table_cell_shows_relative_time_with_absolute_title():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "host.collected_at ? formatRelative(host.collected_at) : '—'" in js
    assert "'mono col-collected'" in js
    assert "collectedCell.title = formatStamp(host.collected_at) + '（' + String(host.collected_at) + '）';" in js


def test_card_time_is_relative_too():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "time.textContent = host.collected_at ? formatRelative(host.collected_at) : '—';" in js
    assert "time.title = formatStamp(host.collected_at) + '（' + String(host.collected_at) + '）';" in js


def test_style_prevents_wrapping():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.206" in css
    assert "#host-table td.col-collected" in css
    assert "white-space: nowrap" in css
