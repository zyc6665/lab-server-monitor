"""v0.1.91：告警时间分布测试。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def test_timeline_card_markup():
    html = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-timeline-card"' in html
    assert 'id="alert-timeline"' in html
    assert 'id="alert-timeline-ranges"' in html
    assert html.count("data-timeline-range=") == 3
    assert "24 小时" in html and "7 天" in html and "30 天" in html
    assert "timeline-key-critical" in html
    assert "timeline-key-warning" in html
    assert "timeline-key-info" in html
    assert 'id="alert-timeline-hint"' in html


def test_timeline_script_helpers():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var TIMELINE_RANGES = {" in js
    assert "'24h': { hours: 24, stepHours: 1" in js
    assert "function timelineBuckets(range)" in js
    assert "function buildAlertTimeline(alerts, range)" in js
    assert "function timelineLabel(bucket, range)" in js
    assert "function renderAlertTimeline(alerts)" in js
    assert "function bindAlertTimeline()" in js
    assert "bindAlertTimeline();" in js
    # 时间分布随列表刷新
    assert "renderAlertTimeline(filteredAlerts());" in js
    # 分级别堆叠
    assert "timeline-seg-' + level" in js
    assert "severity === 'critical' || alert.severity === 'warning'" in js


def test_timeline_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.91 告警时间分布") :]
    assert ".timeline {" in tail
    assert ".timeline-bar {" in tail
    assert ".timeline-seg-critical { background: #dc2626; }" in tail
    assert ".timeline-seg-warning { background: #d97706; }" in tail
    assert ".timeline-seg-info { background: #94a3b8; }" in tail
    assert 'html[data-theme="dark"] .timeline-bar' in tail
    assert "@media (max-width: 760px)" in tail
