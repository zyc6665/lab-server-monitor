"""v0.1.234：概览/主机页标签筛选 + 关键字覆盖标签 + 格式化器统一。

- 主机的「标签」此前只能看不能筛：概览与主机页的筛选条只有分组/状态/关键字。
  现在筛选条多一个「标签」下拉（标签为自由文本，取全队去重排序），
  行按 ``data-tags`` 精确匹配（标签可含空格），关键字搜索同时覆盖标签文本；
  筛选记忆（localStorage）与「清除筛选」「空态提示」同步支持标签。
- users.js / my.js 的本地格式化器切换到共享实现（app.js 的
  ``window.servermonitorFmt``），口径与其它页面一致。
"""

from __future__ import annotations

import re
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"

ADMIN_PASSWORD = "AdminPass!23"


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "group": "训练节点",
                    "tags": ["训练", "A100"],
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
                {
                    "name": "infer-01",
                    "host": "10.0.0.2",
                    "group": "推理节点",
                    "tags": ["推理"],
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
            ],
        },
        allow_missing_secrets=True,
    )


def _client(tmp_path: Path):
    db = tmp_path / "m.db"
    app = create_app(config=_config(), db_path=db)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 后端：meta 标签清单与行属性
# ---------------------------------------------------------------------------


def test_overview_meta_lists_unique_sorted_tags(tmp_path: Path):
    client = _client(tmp_path)
    payload = client.get("/api/overview").get_json()
    assert payload["meta"]["tags"] == ["A100", "推理", "训练"]  # 中文按码点排序
    assert payload["meta"]["has_tags"] is True


def test_overview_page_renders_tag_filter_and_row_attributes(tmp_path: Path):
    client = _client(tmp_path)
    html = client.get("/").get_data(as_text=True)
    assert 'id="filter-tag"' in html
    assert '<option value="a100">A100</option>' in html
    assert '<option value="训练">训练</option>' in html
    # 行携带 data-tags（小写、| 连接）且关键字搜索覆盖标签文本
    assert 'data-tags="训练|a100"' in html
    assert "训练 a100" in html  # data-search 里包含标签


def test_hosts_page_renders_tag_filter_too(tmp_path: Path):
    client = _client(tmp_path)
    html = client.get("/hosts").get_data(as_text=True)
    assert 'id="filter-tag"' in html
    assert 'data-tags="推理"' in html


def test_pages_without_tags_hide_the_select(tmp_path: Path):
    client = _client(tmp_path)
    # 同一个 app 的两台主机都有标签；构造一台无标签主机的场景直接改配置。
    from servermanage.config import load_config_from_mapping

    config = load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "plain",
                    "host": "10.0.0.9",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        },
        allow_missing_secrets=True,
    )
    db = tmp_path / "plain.db"
    app = create_app(config=config, db_path=db)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
    html = client.get("/").get_data(as_text=True)
    assert 'id="filter-tag"' not in html


# ---------------------------------------------------------------------------
# 前端：筛选逻辑与记忆
# ---------------------------------------------------------------------------


def test_app_filters_match_by_tag():
    script = _read("app.js")
    assert "function hostRowMatches(tr, group, status, keyword, tag)" in script
    assert "(tr.getAttribute('data-tags') || '').split('|')" in script
    assert "tags.indexOf(tag) === -1" in script


def test_filter_state_includes_tag():
    script = _read("app.js")
    assert "function saveHostFilters(group, status, tag)" in script
    assert "[tagEl, saved.tag]" in script
    assert "var tagFilter = document.getElementById('filter-tag');" in script
    assert "if (tagFilter) { tagFilter.value = ''; }" in script
    assert "Boolean(group || status || keyword || tag)" in script
    assert "picked.push('标签「' + tag + '」')" in script


def test_templates_wire_tag_options_and_row_attributes():
    for name in ("overview.html", "hosts.html"):
        html = (TEMPLATES / name).read_text(encoding="utf-8")
        assert 'id="filter-tag"' in html, name
        assert "{% if meta.has_tags %}" in html, name
        assert "data-tags=" in html, name
        assert "host.tags or [])|join(' ')" in html, name


def test_keyword_search_covers_tags_in_data_search():
    for name in ("overview.html", "hosts.html"):
        html = (TEMPLATES / name).read_text(encoding="utf-8")
        assert "host.location ~ ' ' ~ (host.tags or [])|join(' ')" in html, name


# ---------------------------------------------------------------------------
# 格式化器统一
# ---------------------------------------------------------------------------


def test_users_and_my_pages_delegate_to_shared_formatter():
    users = _read("users.js")
    my = _read("my.js")
    assert "window.servermonitorFmt.bytes(value)" in users
    assert "window.servermonitorFmt.bytes(value)" in my
    assert "window.servermonitorFmt.stamp(value)" in my
    # 旧的本地口径实现必须移除
    assert "(num / 1099511627776).toFixed(2)" not in users
    assert 'units = ["B", "KB", "MB", "GB", "TB"]' not in my
