"""v0.1.154：磁盘健康表按盘位 / 温度 / 健康 / 介质错误排序（纯前端）。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_headers_expose_sort_keys():
    page = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    for key in ("slot", "media", "temp", "health"):
        assert f'data-disk-sort="{key}"' in page
    assert "data-disk-row" in page
    assert 'data-temp="{{ d.temperature_c if d.temperature_c is not none else \'\' }}"' in page


def test_script_sorts_rows_and_remembers_choice():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "var STORE = 'disk:sort';" in js
    assert "var HEALTH_RANK = { ok: 0, warning: 1, error: 2, critical: 3 };" in js
    assert "rows.forEach(function (row) { body.appendChild(row); });" in js
    assert "localStorage.setItem(STORE, JSON.stringify(state));" in js
    # 空值排在最后，不参与比较
    assert "if (va === null) { return 1; }" in js
    assert js.strip().endswith("})();")


def test_sortable_headers_have_affordance():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.154 磁盘表可按列排序 -- */" in css
    assert ".disk-table th.sortable {" in css
    assert '.disk-table th[aria-sort="ascending"]::after' in css
    assert '.disk-table th[aria-sort="descending"]::after' in css
