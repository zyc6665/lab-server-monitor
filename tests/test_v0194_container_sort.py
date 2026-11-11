"""v0.1.94：容器占用排序与高占用提示。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _js() -> str:
    return (STATIC / "host-detail.js").read_text(encoding="utf-8")


def _css_tail() -> str:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    return css[css.index("v0.1.94 容器占用排序与高占用提示") :]


def test_container_body_has_stable_id():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="container-rows"' in html
    assert html.index('id="container-rows"') < html.index("data-container-row")


def test_rows_are_sorted_by_cpu_after_sampling():
    js = _js()
    assert "function sortContainerRowsByUsage()" in js
    assert "function usageValue(row, selector)" in js
    assert "sortContainerRowsByUsage();" in js
    # 先按 CPU 降序，再按内存降序
    assert "usageValue(b, '.container-cpu') - usageValue(a, '.container-cpu')" in js
    assert "usageValue(b, '.container-mem') - usageValue(a, '.container-mem')" in js


def test_hot_rows_use_thresholds():
    js = _js()
    assert "row.classList.toggle(" in js
    assert "'is-hot'" in js
    assert "(data.cpu_percent || 0) >= 50" in js
    assert "(data.memory_percent || 0) >= 80" in js


def test_hint_mentions_sorting():
    js = _js()
    assert "已按 CPU 占用排序" in js
    assert "占用为执行瞬间的单次采样 · 已按 CPU 占用排序" in js
    assert "hint.className = 'container-stats-hint';" in js


def test_hot_row_styles_exist():
    css = _css_tail()
    assert "#host-containers tr.is-hot .container-cpu," in css
    assert "#host-containers tr.is-hot td:first-child" in css
    assert "inset 3px 0 0 #d97706" in css
    assert 'html[data-theme="dark"] #host-containers tr.is-hot .container-cpu' in css
