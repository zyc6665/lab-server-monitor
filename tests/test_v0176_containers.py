"""v0.1.76：Docker 容器只读概览。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.commands import DOCKER_STATUS_STAGE
from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult, ContainerInfo, HostMetrics, HostReport
from servermanage.parsers import parse_docker_containers, parse_host_metrics
from servermanage.storage import get_host_snapshot, init_storage, save_host_snapshot
from servermanage.web import create_app


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "group": "GPU",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    app = create_app(config=_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client, db_path


def _snapshot(db_path: Path, containers: list[ContainerInfo]) -> None:
    save_host_snapshot(
        HostReport(
            host_name="a100-zyc",
            host="202.119.189.245",
            success=True,
            metrics=HostMetrics(
                collected_at=datetime(2026, 11, 11, 4, 0, tzinfo=timezone.utc),
                containers=containers,
            ),
        ),
        db_path,
    )


def test_parse_docker_containers_reads_tab_separated_rows():
    output = (
        "train-py\tpytorch/pytorch:2.4-cuda\trunning\tUp 3 days\n"
        "jupyter\tjupyter/scipy-notebook:latest\trunning\tUp 2 hours (healthy)\n"
    )
    containers = parse_docker_containers(output)
    assert [c.name for c in containers] == ["train-py", "jupyter"]
    assert containers[0].image == "pytorch/pytorch:2.4-cuda"
    assert containers[1].status == "Up 2 hours (healthy)"


def test_parse_docker_containers_tolerates_partial_and_empty_output():
    assert parse_docker_containers("") == []
    assert parse_docker_containers(None) == []
    containers = parse_docker_containers("solo\n")
    assert containers == [ContainerInfo(name="solo", image="", state="", status="")]


def test_parse_docker_containers_caps_payload():
    output = "\n".join(f"c{i}\timage\tstate\tstatus" for i in range(260))
    assert len(parse_docker_containers(output)) == 200


def test_parse_host_metrics_includes_containers():
    results = {
        DOCKER_STATUS_STAGE: CommandResult(
            stdout="web\tnginx:1.25\trunning\tUp 5 minutes\n",
            stderr="",
            exit_status=0,
        )
    }
    metrics = parse_host_metrics(results, _config().servers[0])
    assert [c.name for c in metrics.containers] == ["web"]
    assert metrics.containers[0].image == "nginx:1.25"


def test_snapshot_round_trip_keeps_containers(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    _snapshot(
        db_path,
        [ContainerInfo(name="web", image="nginx:1.25", state="running", status="Up 5 minutes")],
    )
    snapshot = get_host_snapshot("a100-zyc", db_path)
    assert snapshot is not None
    containers = snapshot["metrics"]["containers"]
    assert containers[0]["name"] == "web"
    assert containers[0]["image"] == "nginx:1.25"


def test_host_page_lists_containers(tmp_path: Path):
    client, db_path = _client(tmp_path)
    init_storage(db_path)
    _snapshot(
        db_path,
        [
            ContainerInfo(name="train-py", image="pytorch/pytorch:2.4-cuda", state="running", status="Up 3 days"),
            ContainerInfo(name="jupyter", image="jupyter/scipy-notebook", state="exited", status="Exited (0) 2 hours ago"),
        ],
    )

    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert 'data-host-tab="containers"' in html
    assert "Docker 容器" in html
    assert "2 个运行中" in html
    assert "train-py" in html
    assert "pytorch/pytorch:2.4-cuda" in html
    assert "Exited (0) 2 hours ago" in html


def test_host_page_shows_empty_container_state(tmp_path: Path):
    client, db_path = _client(tmp_path)
    init_storage(db_path)
    _snapshot(db_path, [])

    html = client.get("/host/a100-zyc").get_data(as_text=True)
    assert "这台主机没有运行中的 Docker 容器" in html
    assert 'data-host-tab="containers">Docker 容器</button>' in html


def test_overview_payload_reports_container_count(tmp_path: Path):
    client, db_path = _client(tmp_path)
    init_storage(db_path)
    _snapshot(db_path, [ContainerInfo(name="web"), ContainerInfo(name="db")])

    payload = client.get("/api/overview").get_json()
    row = next(item for item in payload["hosts"] if item["name"] == "a100-zyc")
    assert row["container_count"] == 2


def test_host_card_shows_container_count():
    static = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
    script = (static / "app.js").read_text(encoding="utf-8")
    assert "host-card-containers" in script
    assert "host.container_count" in script
    style = (static / "style.css").read_text(encoding="utf-8")
    assert ".host-card-containers" in style
