"""v0.1.117：概览筛选记忆与一键清除。"""

from __future__ import annotations

from pathlib import Path

WEB = Path(__file__).resolve().parents[1] / "servermanage" / "web"
TEMPLATES = WEB / "templates"
STATIC = WEB / "static"


def test_template_has_clear_button():
    page = (TEMPLATES / "overview.html").read_text(encoding="utf-8")
    assert 'id="filter-clear"' in page
    assert "清除筛选" in page


def test_filters_are_persisted_and_restored():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "var HOST_FILTER_KEY = 'overview:filters';" in script
    assert "localStorage.setItem(HOST_FILTER_KEY" in script
    assert "localStorage.removeItem(HOST_FILTER_KEY);" in script
    assert "function restoreHostFilters()" in script
    assert "restoreHostFilters();" in script


def test_restore_skips_unknown_option():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "if (el.options[i].value === value) { found = true; break; }" in script
    assert "if (found) { el.value = value; }" in script


def test_clear_button_visibility_and_reset():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "clear.hidden = !(group || status || keyword);" in script
    assert "clearFilterButton.addEventListener('click', function () {" in script


def test_styles_cover_clear_button():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.117 概览筛选记忆与清除")[1]
    assert ".filter-bar .filter-clear[hidden]" in tail
    assert ":focus-visible" in tail
