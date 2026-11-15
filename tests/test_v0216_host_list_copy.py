"""v0.1.216：设置页可把筛选后的主机清单复制成文本。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _tpl() -> str:
    return (TEMPLATES / "settings.html").read_text(encoding="utf-8")


def _js() -> str:
    return (STATIC / "settings.js").read_text(encoding="utf-8")


def test_template_has_copy_button_next_to_filter():
    tpl = _tpl()
    assert 'id="host-copy-list"' in tpl
    assert "复制清单" in tpl
    assert tpl.index('id="host-filter-count"') < tpl.index('id="host-copy-list"')


def test_script_builds_tab_separated_list():
    js = _js()
    assert "function hostListText()" in js
    assert '"名称", "状态", "地址", "端口", "用户", "认证", "分组", "负责人", "采集时间"' in js
    assert 'lines.push(values.join("\\t"));' in js
    assert "if (row.hidden || !row.getAttribute(\"data-host-name\")) { return; }" in js


def test_copy_button_is_wired_with_clipboard_fallback():
    js = _js()
    assert "function copyHostList(button)" in js
    assert 'hostCopyButton.addEventListener("click"' in js
    assert "document.execCommand(\"copy\")" in js
    assert 'button.textContent = "复制失败";' in js
