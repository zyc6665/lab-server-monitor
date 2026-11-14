"""v0.1.158：主机表两个「磁盘」列改成能分清的列名。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_headers_distinguish_usage_from_array_health():
    for name in ("overview.html", "hosts.html"):
        page = (TEMPLATES / name).read_text(encoding="utf-8")
        assert "磁盘使用率" in page
        assert "阵列健康" in page
        # 旧的重名表头不再出现
        assert '<th data-sort-key="disk">磁盘</th>' not in page
        assert '<th data-sort-key="health">磁盘健康</th>' not in page
        # 悬停能看懂这一列是什么
        assert 'title="根分区等挂载点里最高的使用率"' in page
        assert 'title="storcli 读到的物理盘与阵列健康"' in page


def test_counts_collapse_on_narrow_screens():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.158 主机表磁盘列更清楚 -- */" in css
    assert "#host-table .health-counts { display: none; }" in css
    assert "@media (min-width: 1320px) {" in css
    assert '#host-table th[data-sort-key="health"] { white-space: nowrap; }' in css
