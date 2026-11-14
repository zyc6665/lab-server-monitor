"""v0.1.195：磁盘表可选择隐藏次要列。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_menu_and_cell_classes():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert 'id="disk-columns"' in html
    for key in ("media", "errors", "predictive", "smart", "shield"):
        assert f'data-disk-col="{key}"' in html
        assert f'class="col-{key}"' in html or f'"col-{key} ' in html or f' {key}"' in html
    # 表头与数据行都要带同样的类，否则隐藏后列会错位
    assert html.count('class="col-media"') >= 1
    assert html.count('<td class="col-media">') == 1
    assert html.count('<td class="col-shield">') == 1


def test_script_and_styles():
    js = (STATIC / "disk-health.js").read_text(encoding="utf-8")
    assert "v0.1.195 磁盘表列显示偏好" in js
    assert "var STORE = 'disk:columns';" in js
    assert "table.classList.toggle('hide-' + key, Boolean(hidden[key]));" in js
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "v0.1.195 磁盘表列显示偏好" in css
    assert "table.disk-table.hide-media .col-media" in css
