"""v0.1.89：后端断连提示与自动恢复。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_base_template_has_connection_banner():
    html = (TEMPLATES / "base.html").read_text(encoding="utf-8")
    assert 'id="conn-banner"' in html
    assert 'class="conn-dot"' in html
    assert "与后台的连接已断开，正在自动重试…" in html
    assert 'role="status"' in html


def test_app_js_watches_connection():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var CONNECTION_WATCH_MS = 15000;" in js
    assert "function checkConnection()" in js
    assert "fetch('/api/runtime', { cache: 'no-store' })" in js
    assert "function setConnectionBanner(lost, recovered)" in js
    assert "已恢复与后台的连接" in js
    assert "function startConnectionWatch()" in js
    assert "startConnectionWatch();\n    if (!hasDashboard())" in js


def test_connection_banner_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.89 后端断连提示") :]
    assert ".conn-banner {" in tail
    assert ".conn-banner[hidden] { display: none !important; }" in tail
    assert ".conn-banner-ok {" in tail
    assert "@keyframes conn-pulse" in tail
    assert 'html[data-theme="dark"] .conn-banner {' in tail
    assert "@media (prefers-reduced-motion: reduce)" in tail
