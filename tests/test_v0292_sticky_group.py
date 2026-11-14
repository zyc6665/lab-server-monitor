"""v0.1.192：磁盘页分组标题在滚动时吸顶。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def test_group_header_is_sticky():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css.split("v0.1.192 磁盘分组标题吸顶")[1]
    assert "#disk-groups .disk-group-head {" in tail
    assert "position: sticky;" in tail
    assert "top: 0;" in tail
    # 吸顶需要不透明底色，否则下面的表格会透出来
    assert "background: var(--card-bg);" in tail
    assert 'html[data-theme="dark"] #disk-groups .disk-group-head' in tail
