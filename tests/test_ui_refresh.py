"""v0.7.0 视觉重构：全宽工作区、指标带、发丝分隔与时间戳收敛。"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from servermanage.web import create_app
from servermanage.config import load_config_from_mapping

REPO = Path(__file__).resolve().parents[1]
STATIC = REPO / "servermanage" / "web" / "static"
TEMPLATES = REPO / "servermanage" / "web" / "templates"


def _style() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def _tail() -> str:
    """v0.7.0 之后追加的重构层，覆盖旧规则。"""
    css = _style()
    marker = "v0.7.0 视觉重构"
    assert marker in css
    return css.split(marker, 1)[1]


def _app():
    config = load_config_from_mapping({}, allow_empty_servers=True)
    return create_app(config=config, db_path=REPO / "data" / "ui-test.db")


def test_container_is_full_width_with_fluid_gutter() -> None:
    css = _style()
    tail = _tail()
    assert "--gutter: clamp(" in tail
    container = tail.split(".container {", 1)[1].split("}", 1)[0]
    assert "max-width: none" in container
    assert "padding: clamp(" in container
    assert css.count("v0.7.0 视觉重构") == 1


def test_metric_strip_merges_stat_cards() -> None:
    tail = _tail()
    block = tail.split(".stat-grid {", 1)[1].split("}", 1)[0]
    assert "grid-template-columns: repeat(4, minmax(0, 1fr))" in block
    assert "gap: 0" in block
    assert ".stat-card + .stat-card { border-left: 1px solid var(--border); }" in tail
    assert ".stat-value" in tail and "tabular-nums" in tail


def test_lists_use_hairline_rows_instead_of_nested_cards() -> None:
    tail = _tail()
    for selector in (".focus-item", ".check-row", ".rank-row", ".capacity-row"):
        block = tail.split(selector + " {", 1)[1].split("}", 1)[0]
        assert "border-bottom: 1px solid var(--border)" in block, selector
        assert "border-radius: 0" in block, selector


def test_tables_keep_dense_padding_and_sticky_header() -> None:
    css = _style()
    assert "#host-table td { padding: 9px 9px; }" in css
    assert "text-overflow: ellipsis" in css
    assert ".data-table thead th { position: sticky; top: 0; z-index: 1; }" in css


def test_stamp_filter_shortens_iso_timestamps() -> None:
    app = _app()
    stamp = app.jinja_env.filters["stamp"]
    assert stamp("2026-11-10T20:11:46.576946+08:00") == "11-10 20:11"
    assert stamp("2026-11-10T20:11:46") == "11-10 20:11"
    assert stamp("") == "—"
    assert stamp(None) == "—"
    assert stamp("not-a-date") == "not-a-date"


def test_templates_use_stamp_filter_with_full_value_in_title() -> None:
    alerts = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'title="{{ alert.created_at }}"' in alerts
    assert "{{ alert.created_at|stamp }}" in alerts

    host = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert "{{ detail.collected_at|stamp }}" in host
    assert "{{ check.checked_at|stamp }}" in host

    overview = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert "{{ host.collected_at|stamp }}" in overview


def test_app_js_formats_stamps_client_side() -> None:
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function formatStamp(value)" in script
    assert "textCell(formatStamp(host.collected_at), 'mono')" in script
    assert "textCell(formatRelative(alert.created_at), 'mono alert-time')" in script
    assert "formatStamp(alert.created_at)" in script  # 悬停显示绝对时间 / 重点关注
