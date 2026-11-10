"""Tests for the 0.4.2 experience polish (card collapse, inline alert detail, save hints).

These are the pieces a browser actually executes, so the assertions cover both
the served markup (the anchors the scripts attach to) and the shipped script
and stylesheet text (the behaviour itself). They are intentionally textual:
there is no bundler step, so the served JS/CSS *is* the product.
"""

from __future__ import annotations

from pathlib import Path

SERVED = Path(__file__).resolve().parents[1] / "servermanage" / "web"
STATIC = SERVED / "static"
TEMPLATES = SERVED / "templates"


def _script(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def _template(name: str) -> str:
    return (TEMPLATES / name).read_text(encoding="utf-8")


def _style() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_overview_cards_can_be_collapsed_and_remembered() -> None:
    markup = _template("overview.html")
    for section_id in ("focus-card", "system-check", "resource-rank", "capacity-forecast"):
        assert f'id="{section_id}"' in markup, section_id

    app = _script("app.js")
    assert "function setupCardCollapse" in app
    assert "overview:collapsed:" in app
    assert "is-collapsed" in app
    assert "localStorage.setItem" in app
    assert "setupCardCollapse();" in app

    css = _style()
    assert ".card-toggle" in css
    assert "section.card.is-collapsed > *:not(.section-head)" in css


def test_alert_rows_expand_inline_without_leaving_the_page() -> None:
    markup = _template("alerts.html")
    assert 'id="alerts-body"' in markup
    assert 'id="alerts-table"' in markup

    app = _script("app.js")
    assert "function setupAlertRowExpansion" in app
    assert "function buildAlertDetailRow" in app
    assert "function toggleAlertDetail" in app
    assert "alert-detail-row" in app
    assert "aria-expanded" in app
    assert "setupAlertRowExpansion();" in app

    css = _style()
    assert ".alert-detail-row" in css or ".alert-detail-cell" in css
    assert ".alert-detail-meta" in css


def test_settings_save_state_is_shown_per_section() -> None:
    markup = _template("settings.html")
    assert "data-section=" in markup
    assert "data-save=" in markup

    settings = _script("settings.js")
    assert "function markDirty" in settings
    assert "function markSaved" in settings
    assert "function clockLabel" in settings
    assert "有未保存修改" in settings
    assert '"save-hint"' in settings
    assert "markSaved(sectionName" in settings

    css = _style()
    assert ".save-hint" in css
    assert ".save-hint-dirty" in css
    assert ".save-hint-ok" in css


def test_host_page_offers_a_retry_when_collection_failed() -> None:
    markup = _template("host.html")
    assert 'id="host-collect-notice"' in markup
    assert 'id="host-collect-now"' in markup
    assert "detail.errors" in markup

    script = _script("host-detail.js")
    assert "function bindCollectNow" in script
    assert "/collect" in script
    assert "collection-status?names=" in script
    assert "bindCollectNow();" in script

    css = _style()
    assert ".collect-notice" in css


def test_alert_table_hides_secondary_columns_on_narrow_screens() -> None:
    markup = _template("alerts.html")
    assert '<th class="col-secondary">类别</th>' in markup
    assert 'class="alert-message col-wide"' in markup

    app = _script("app.js")
    assert "col-secondary" in app
    assert "col-wide" in app

    css = _style()
    assert "#alerts-table .col-secondary { display: none; }" in css
    assert "#alerts-table .col-wide { display: none; }" in css


def test_hosts_page_empty_state_points_at_settings_and_ssh_import() -> None:
    markup = _template("hosts.html")
    assert "还没有主机" in markup
    assert "~/.ssh/config" in markup
