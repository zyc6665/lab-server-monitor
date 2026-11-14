"""v0.1.160：没有配置分组时，页面给出引导（只读提示，不写任何东西）。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _client(tmp_path: Path, group: str | None = None):
    server = {
        "name": "gpu-01",
        "host": "10.0.0.1",
        "port": 22,
        "username": "root",
        "auth": {"type": "key", "key_data": "PEM"},
    }
    if group:
        server["group"] = group
    config = load_config_from_mapping({"servers": [server]})
    app = create_app(config=config, db_path=tmp_path / "servermonitor.db")
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_hint_appears_when_no_group_is_configured(tmp_path: Path):
    client = _client(tmp_path)
    for path in ("/", "/hosts", "/disk-health"):
        html = client.get(path).get_data(as_text=True)
        assert "group-hint" in html, path
        assert "还没有配置分组" in html, path
        assert "/settings#hosts" in html, path


def test_hint_disappears_once_a_group_exists(tmp_path: Path):
    client = _client(tmp_path, group="训练节点")
    for path in ("/", "/hosts", "/disk-health"):
        html = client.get(path).get_data(as_text=True)
        assert "还没有配置分组" not in html, path


def test_hint_is_styled_subtly():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.160 分组未配置时的引导 -- */" in css
    assert ".group-hint {" in css
    assert ".group-hint a { color: var(--accent);" in css
