"""页面内锚点工具。

磁盘健康页的“按主机分组”区块与主机详情页的互相跳转需要同一个锚点规则，
放在这里避免两处各写一份正则。
"""

import re

_NON_SLUG = re.compile(r"[^0-9A-Za-z_-]+")


def anchor_slug(name: object) -> str:
    """把主机名转换成可用作 HTML id 的 ASCII 片段。"""
    return _NON_SLUG.sub("-", str(name or "")).strip("-") or "host"
