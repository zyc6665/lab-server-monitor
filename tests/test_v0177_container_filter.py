"""v0.1.77: Docker container search and state filter on the host page."""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult, ContainerInfo, HostMetrics, HostReport
from servermanage.storage import init_storage, save_host_snapshot
from servermanage.web import create_app
from datetime import datetime, timezone

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def _client(tmp_path: Path):
    config = load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )
    db_path = tmp_path / "monitor.db"
    app = create_app(config=config, db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client, db_path


def _seed(db_path: Path) -> None:
    init_storage(db_path)
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="202.119.189.245",
            success=True,
            metrics=HostMetrics(
                collected_at=datetime(2026, 11, 11, 4, 0, tzinfo=timezone.utc),
                containers=[
                    ContainerInfo(name="train-py", image="pytorch/pytorch:2.4", state="running", status="Up 3 days"),
                    ContainerInfo(name="jupyter", image="jupyter/scipy", state="exited", status="Exited (0) 2 hours ago"),
                ],
            ),
        ),
        db_path,
    )


def test_template_has_container_filter_controls(tmp_path: Path):
    client, db_path = _client(tmp_path)
    _seed(db_path)
    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert 'id="container-search"' in html
    assert 'id="container-state"' in html
    assert 'id="container-count"' in html
    assert 'id="container-filter-empty"' in html
    assert 'data-container-row' in html
    assert 'data-container-state="running"' in html
    assert 'data-container-state="exited"' in html
    assert 'data-container-search="train-py pytorch/pytorch:2.4"' in html


def test_host_detail_script_filters_rows():
    script = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindContainerFilter()" in script
    assert "bindContainerFilter();" in script
    assert "data-container-search" in script
    assert "row.hidden = !ok" in script


def test_container_filter_styles():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    index = css.index("v0.1.77 容器搜索与状态筛选")
    block = css[index:]
    assert ".container-toolbar" in block
    assert ".container-search" in block
    assert "[data-container-row][hidden]" in block
