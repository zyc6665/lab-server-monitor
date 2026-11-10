"""v0.7.2：磁盘健康页只看异常主机 + 与主机详情双向跳转。"""

from __future__ import annotations

from pathlib import Path

from test_v171_disk_groups import STATIC, _client


def _js(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


def test_disk_page_offers_only_issue_filter(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert 'id="disk-only-issues"' in html
    assert 'id="disk-filter-empty"' in html
    assert "只看异常主机" in html
    assert "disk-health.js" in html
    # 有告警/严重/采集失败的主机标 1，健康主机标 0。
    assert 'data-disk-issues="1"' in html
    assert 'data-disk-issues="0"' in html


def test_attention_flag_covers_warning_and_missing_storcli(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)
    chunks = html.split('class="disk-host" id="disk-')

    flagged: dict[str, bool] = {}
    for chunk in chunks[1:]:
        anchor = chunk.split('"', 1)[0]
        flagged[anchor] = 'data-disk-issues="1"' in chunk
    assert flagged["4090-zyc"] is True  # 一块盘 warning
    assert flagged["k80-zyc"] is True  # storcli 不可用
    assert flagged["a100-zyc"] is False


def test_filter_script_persists_and_unhides_hash_target() -> None:
    script = _js("disk-health.js")

    assert "disk:onlyIssues" in script
    assert "localStorage.getItem" in script and "localStorage.setItem" in script
    assert "location.hash" in script
    assert "disk-filter-empty" in script
    assert "querySelectorAll('[data-disk-issues]')" in script


def test_filter_styles_hide_sections_and_style_toggle() -> None:
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.7.2 磁盘健康筛选") :]

    assert ".disk-filter-toggle" in tail
    assert ".disk-host[hidden]" in tail and "display: none !important" in tail
    assert ".disk-jump-link[hidden]" in tail


def test_host_page_links_back_to_disk_groups(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)

    assert 'href="/disk-health#disk-a100-zyc"' in html
    assert "在磁盘健康页查看" in html


def test_disk_header_links_into_storage_panel(tmp_path: Path) -> None:
    html = _client(tmp_path).get("/disk-health").get_data(as_text=True)

    assert 'href="/host/a100-zyc#disk-array"' in html


def test_host_detail_hash_opens_the_matching_panel() -> None:
    script = _js("host-detail.js")

    assert "'disk-array': 'storage'" in script
    assert "scrollIntoView({ block: 'start' })" in script
