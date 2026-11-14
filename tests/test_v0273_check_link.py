"""v0.1.173：概览的服务检查徽标可直接进入该主机的「服务可用性」分区。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_check_badge_links_to_the_checks_tab():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "checkBadge = document.createElement('a');" in js
    assert "checkBadge.href = '/host/' + encodeURIComponent(host.name || '') + '#tab-checks';" in js
    assert "checkBadge.title = '查看这台的服务器检查明细';" in js
    assert "checkSpan = document.createElement('a');" in js
    assert "checkSpan.href = '/host/' + encodeURIComponent(host.name || '') + '#tab-checks';" in js


def test_checks_tab_exists_on_the_host_page():
    page = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'data-host-tab="checks"' in page


def test_link_has_affordance():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.173 服务检查徽标可点 -- */" in css
    assert "a.check-summary {" in css
    assert "border-bottom: 1px dashed currentColor;" in css
