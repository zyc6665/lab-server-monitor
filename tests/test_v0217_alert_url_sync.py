"""v0.1.217：告警筛选同步到地址栏，刷新或分享仍保留。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _js() -> str:
    return app_js_source(STATIC)


def test_sync_helper_sets_expected_params():
    js = _js()
    assert "function syncAlertFiltersToUrl()" in js
    for param in ["status", "severity", "host", "category", "q"]:
        assert f"params.set('{param}'" in js, param
    assert "window.history.replaceState(null, '', next);" in js


def test_sync_runs_when_rows_render():
    js = _js()
    assert "updateAlertSelectionSummary();\n    syncAlertFiltersToUrl();" in js


def test_keyword_restored_from_query_string():
    js = _js()
    assert "new URLSearchParams(window.location.search).get('q')" in js
    assert "alertSearch.value = keywordParam;" in js
