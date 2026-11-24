"""v0.1.209：告警导出 CSV 的级别/类别/状态使用中文，时间用统一格式。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return app_js_source(STATIC)


def test_csv_uses_localised_labels():
    js = _js()
    assert "SEVERITY_TEXT[alert.severity] || alert.severity" in js
    assert "alertCategoryLabel(alert.category)" in js
    assert "STATUS_TEXT[alert.status] || alert.status" in js


def test_csv_uses_shared_time_format():
    js = _js()
    assert "formatStamp(alert.created_at)" in js


def test_csv_still_exports_filtered_rows():
    js = _js()
    start = js.index("function exportAlertsCsv()")
    body = js[start:start + 800]
    assert "var rows = filteredAlerts();" in body
