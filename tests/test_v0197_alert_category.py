"""v0.1.97：告警按类别筛选。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _js() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def test_toolbar_has_category_select():
    html = (TEMPLATES / "alerts.html").read_text(encoding="utf-8")
    assert 'id="alert-category-filter"' in html
    assert "全部类别" in html
    # 放在主机筛选之后、时间范围之前
    assert html.index('id="alert-host-filter"') < html.index('id="alert-category-filter"')
    assert html.index('id="alert-category-filter"') < html.index('id="alert-range-filter"')


def test_category_state_and_filtering():
    js = _js()
    assert "var alertCategory = '';" in js
    assert "if (alertCategory && (alert.category || '') !== alertCategory) { return false; }" in js


def test_category_labels_and_options_are_built_from_data():
    js = _js()
    assert "var ALERT_CATEGORY_LABELS = {" in js
    assert "user: '服务器账号'," in js
    assert "availability: '服务检查'," in js
    assert "function populateAlertCategories(alerts)" in js
    assert "populateAlertCategories(alerts);" in js
    assert "select.remove(1);" in js


def test_category_is_synced_to_url_and_reset():
    js = _js()
    assert "if (alertCategory) { params.push('category=' + encodeURIComponent(alertCategory)); }" in js
    assert "alertCategory = '';" in js
    assert "var category = document.getElementById('alert-category-filter');" in js
    assert "alertCategoryFilter.addEventListener('change'" in js
    assert "alertCategory = alertCategoryFilter.value || '';" in js
