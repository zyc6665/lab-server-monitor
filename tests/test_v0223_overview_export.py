"""v0.1.123：概览趋势导出 CSV。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "servermanage" / "web" / "static" / "app.js"
TEMPLATE = ROOT / "servermanage" / "web" / "templates" / "overview.html"
STYLE = ROOT / "servermanage" / "web" / "static" / "style.css"


def test_template_has_export_button():
    markup = TEMPLATE.read_text(encoding="utf-8")
    assert 'id="overview-trend-export"' in markup
    assert 'id="overview-trend-export" hidden>导出 CSV</button>' in markup


def test_script_exports_current_history():
    script = SCRIPT.read_text(encoding="utf-8")
    assert "var overviewHistory = { range: '24h', points: [], previous: [] };" in script
    assert "overviewHistory = { range: rangeKey, points: points, previous: previous };" in script
    assert "exportButton.hidden = points.length === 0;" in script
    assert "function exportOverviewHistory()" in script
    assert "link.download = 'overview-trend-' + overviewHistory.range + '-' + stamp + '.csv';" in script
    assert "header.push('上一周期时间');" in script
    assert "bindOverviewExport();" in script


def test_script_escapes_and_uses_bom():
    script = SCRIPT.read_text(encoding="utf-8")
    assert 'text.split(\'"\').join(\'""\')' in script
    assert "type: 'text/csv;charset=utf-8'" in script


def test_style_covers_export_button():
    css = STYLE.read_text(encoding="utf-8")
    block = css[css.index("v0.1.123 概览趋势导出 CSV"):]
    assert "#overview-trend .trend-export" in block
    assert "#overview-trend .trend-export[hidden] { display: none !important; }" in block
    assert 'html[data-theme="dark"] #overview-trend .trend-export:hover' in block
