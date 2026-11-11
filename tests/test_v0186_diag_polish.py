"""v0.1.86：诊断卡片打磨（空阵列不误报 + 复制摘要）。"""

from __future__ import annotations

from pathlib import Path

from test_v0185_diagnostics import NOW, _detail, build_host_diagnostics

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_empty_ok_disk_health_row_is_skipped():
    """status=ok 但没有盘明细时不要输出误导性的「0 块盘全部健康」。"""

    detail = _detail(disk={"status": "ok", "drives": [], "message": ""})
    rows = build_host_diagnostics(detail, now=NOW)
    assert all(row["key"] != "disk_health" for row in rows)


def test_healthy_disk_row_still_reported():
    detail = _detail(disk={"status": "ok", "drives": [{"health": "healthy"}]})
    row = [r for r in build_host_diagnostics(detail, now=NOW) if r["key"] == "disk_health"][0]
    assert row["level"] == "ok"
    assert "1 块盘全部健康" in row["detail"]


def test_host_page_has_copy_summary_button():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="host-diag-copy"' in html
    assert 'data-host-name="{{ detail.name }}"' in html
    assert "复制摘要" in html


def test_copy_summary_script_and_styles():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function diagSummaryText()" in js
    assert "function bindDiagCopy()" in js
    assert "bindDiagCopy();" in js
    assert "navigator.clipboard.writeText" in js
    assert "'（建议：'" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.86 诊断摘要复制") :]
    assert ".diag-head-actions {" in tail
    assert ".diag-head-actions .btn-link" in tail
    assert ":focus-visible" in tail
