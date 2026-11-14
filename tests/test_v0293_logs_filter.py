"""v0.1.193：运行日志支持关键字与级别过滤。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_toolbar_exists():
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert 'id="logs-filter"' in html
    assert 'id="logs-level"' in html
    assert '<option value="ERROR">错误</option>' in html
    assert 'id="logs-count"' in html
    assert 'id="logs-output"' in html


def test_filtering_logic():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert "function renderLogs()" in js
    assert "var lastLogText" in js
    assert "line.indexOf(level) < 0" in js
    assert "line.toLowerCase().indexOf(keyword) < 0" in js
    assert '"显示 " + matched.length + " / " + lines.length + " 行"' in js
    # 刷新日志时保留原文再过滤，避免过滤后刷新丢行
    assert "lastLogText = (payload && (payload.text || payload.lines)) || \"\";" in js
    assert "logsFilter.addEventListener(\"input\", renderLogs);" in js


def test_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.193 运行日志过滤" in css
    assert ".logs-filter" in css
