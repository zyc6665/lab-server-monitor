"""v0.1.93：告警时间分布点击筛选。"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _app_js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_toolbar_has_bucket_chip():
    html = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-bucket-chip"' in html
    assert "chip-clear" in html


def test_clicking_a_bar_filters_alerts_by_bucket():
    js = _app_js()
    assert "function bucketStartFor(value, range)" in js
    assert "var alertBucket = 0;" in js
    assert "alertBucket && bucketStartFor(alert.created_at, timelineRange) !== alertBucket" in js
    assert "data-timeline-start" in js
    assert "alertBucket = alertBucket === start ? 0 : start;" in js
    assert "function updateAlertBucketChip()" in js


def test_bucket_resets_when_range_or_filters_change():
    js = _app_js()
    # 切换时间范围与清除筛选都应把桶筛选重置
    assert js.count("alertBucket = 0;") >= 3
    assert "updateAlertBucketChip();" in js


def test_selected_bar_and_chip_styles():
    css = _css()
    tail = css[css.index("v0.1.93 时间分布点击筛选") :]
    assert ".timeline-bar.is-clickable" in tail
    assert ".timeline-bar.is-selected" in tail
    assert ".chip-clear {" in tail
    assert ".chip-clear[hidden]" in tail
    assert 'html[data-theme="dark"] .chip-clear' in tail
