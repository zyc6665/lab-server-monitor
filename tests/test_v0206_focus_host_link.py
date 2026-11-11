"""v0.1.106：重点关注里的主机名可点击，直接筛出该主机。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _script() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def test_focus_host_is_a_button():
    script = _script()
    body = script.split("function updateFocusAlerts(alerts) {")[1].split("function bindFocusHosts")[0]
    assert "hostButton.className = 'focus-host';" in body
    assert "hostButton.setAttribute('data-focus-host', alert.host_name);" in body
    assert "hostButton.textContent = alert.host_name;" in body


def test_clicking_filters_the_host_table():
    script = _script()
    body = script.split("function bindFocusHosts() {")[1].split("function bindOverviewRanges")[0]
    assert "event.target.closest('[data-focus-host]')" in body
    assert "keyword.value = name;" in body
    assert "applyHostFilters();" in body
    assert "scrollIntoView({ behavior: 'smooth', block: 'start' })" in body
    assert "bindFocusHosts();" in script.split("function init()")[1]


def test_hint_mentions_the_shortcut():
    script = _script()
    assert "点主机名可筛选下表" in script


def test_styles_mark_the_host_button():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.106 重点关注定位主机")[1]
    assert ".focus-host {" in tail
    assert "color: var(--accent);" in tail
    assert 'html[data-theme="dark"] .focus-host' in tail
