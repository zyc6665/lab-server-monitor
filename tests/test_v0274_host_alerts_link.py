"""v0.1.174：主机详情「最近告警」可直接跳到只含该主机的告警列表。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _client(tmp_path: Path):
    config = load_config_from_mapping(
        {
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "port": 22,
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ]
        }
    )
    app = create_app(config=config, db_path=tmp_path / "servermonitor.db")
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_host_page_links_to_the_alerts_list(tmp_path: Path):
    client = _client(tmp_path)
    html = client.get("/host/gpu-01").get_data(as_text=True)
    assert 'id="host-alerts-all"' in html
    assert "查看全部" in html
    assert "/alerts?host=gpu-01&amp;status=all" in html


def test_alerts_page_accepts_the_host_filter(tmp_path: Path):
    client = _client(tmp_path)
    page = client.get("/alerts?host=gpu-01&status=all")
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert 'value="gpu-01" selected' in html


def test_link_style():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.174 主机详情跳到告警列表 -- */" in css
    assert "#host-alerts-all { margin-left: auto; font-size: 12.5px; }" in css
