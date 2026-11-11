"""v0.1.74 概览主机卡片视图：表格/卡片切换（纯前端、只读）。"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))

from test_v171_disk_groups import STATIC, _client  # noqa: E402


def _overview(tmp_path):
    client = _client(tmp_path)
    response = client.get("/")
    assert response.status_code == 200
    return response.get_data(as_text=True)


def test_overview_renders_view_toggle_and_card_grid(tmp_path):
    body = _overview(tmp_path)
    assert 'class="view-toggle"' in body
    assert 'data-host-view="table"' in body
    assert 'data-host-view="cards"' in body
    assert 'id="host-cards"' in body
    assert 'id="host-table-wrap"' in body
    # 卡片由前端渲染，服务端只留空容器。
    assert 'id="host-cards" hidden></div>' in body


def test_app_js_renders_cards_and_remembers_choice():
    script = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function buildHostCard(host)" in script
    assert "function renderHostCards(hosts)" in script
    assert "function applyHostView(view)" in script
    assert "var HOST_VIEW_KEY = 'overview:host-view';" in script
    assert "renderHostCards(rows);" in script
    assert "bindHostView();" in script
    # 卡片同样参与分组/状态/关键字筛选。
    assert "grid.querySelectorAll('[data-host]')" in script
    # 卡片上的快捷采集复用同一个 action 类名，事件委托无需额外改动。
    assert "collectButton.className = 'btn-link host-collect';" in script


def test_card_view_styles_are_available():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.74 主机卡片视图" in css
    tail = css[css.index("v0.1.74 主机卡片视图"):]
    assert ".view-toggle" in tail
    assert ".view-tab.active" in tail
    assert ".host-card-grid" in tail
    assert "grid-template-columns: repeat(auto-fill, minmax(268px, 1fr));" in tail
    assert ".host-card-metrics" in tail
    assert 'html[data-theme="dark"] .host-card' in tail
