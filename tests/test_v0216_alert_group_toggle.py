"""v0.1.116：告警分组一键展开/折叠。"""

from __future__ import annotations

from pathlib import Path
from _frontend import app_js_source

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web"
TEMPLATES = STATIC / "templates"
STATIC = STATIC / "static"


def test_template_has_expand_button():
    page = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-group-expand"' in page
    assert "全部折叠" in page
    assert page.index('id="alert-group-toggle"') < page.index('id="alert-group-expand"')


def test_expand_button_follows_grouping_state():
    script = app_js_source(STATIC)
    assert "function updateGroupExpandLabel(alerts)" in script
    assert "expand.hidden = !alertGrouped;" in script
    assert "updateGroupExpandLabel(filteredAlerts(true));" in script


def test_toggle_all_groups_flips_every_host():
    script = app_js_source(STATIC)
    assert "function groupHostsFor(alerts)" in script
    assert "function toggleAllGroups(alerts)" in script
    assert "hosts.forEach(function (host) { collapsedHosts[host] = !allCollapsed; });" in script


def test_expand_button_is_bound():
    script = app_js_source(STATIC)
    assert "groupExpand.addEventListener('click', function () {" in script
    assert "toggleAllGroups(filteredAlerts(true));" in script
