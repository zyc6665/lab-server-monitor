"""v0.1.90：按需查看容器资源占用。"""

from __future__ import annotations

from pathlib import Path

import pytest

from servermanage import container_stats
from servermanage.models import AuthConfig, HostConfig


def _host():
    return HostConfig(
        name="a100",
        host="10.0.0.1",
        port=22,
        username="zyc",
        auth=AuthConfig(type="key", key_path="/home/zyc/.ssh/id_ed25519"),
    )

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


class _Result:
    def __init__(self, stdout: str, exit_status: int = 0):
        self.stdout = stdout
        self.exit_status = exit_status


class _SSH:
    def __init__(self, result):
        self.result = result
        self.commands: list[str] = []

    def run(self, command, timeout=None):
        self.commands.append(command)
        return self.result


def test_parse_stats_converts_percentages_and_sorts():
    output = (
        "web\t0.50%\t1.20%\t120MiB / 8GiB\n"
        "train-py\t312.40%\t48.75%\t3.9GiB / 8GiB\n"
        "idle\t0.00%\t0.00%\t1MiB / 8GiB\n"
    )
    rows = container_stats.parse_container_stats(output)
    assert [row["name"] for row in rows] == ["train-py", "web", "idle"]
    assert rows[0]["cpu_percent"] == 312.4
    assert rows[0]["memory_percent"] == 48.8
    assert rows[0]["memory_usage"] == "3.9GiB / 8GiB"


def test_parse_stats_tolerates_missing_fields_and_empty():
    assert container_stats.parse_container_stats(None) == []
    assert container_stats.parse_container_stats("") == []
    rows = container_stats.parse_container_stats("only-name\n\n  \n")
    assert rows == [
        {"name": "only-name", "cpu_percent": None, "memory_percent": None, "memory_usage": ""}
    ]


def test_parse_stats_caps_rows():
    output = "".join(f"c{i}\t1.0%\t1.0%\t1MiB / 8GiB\n" for i in range(400))
    assert len(container_stats.parse_container_stats(output)) == 300


def test_collect_runs_read_only_command():
    ssh = _SSH(_Result("web\t1.00%\t2.00%\t10MiB / 1GiB\n"))
    rows = container_stats.collect_container_stats(_host(), ssh)
    assert rows[0]["name"] == "web"
    assert ssh.commands and ssh.commands[0].startswith("docker stats --no-stream")
    assert "--no-stream" in container_stats.STATS_COMMAND


def test_collect_returns_empty_on_failure():
    ssh = _SSH(_Result("", exit_status=127))
    assert container_stats.collect_container_stats(_host(), ssh) == []


def test_stat_command_does_not_mutate_containers():
    command = container_stats.STATS_COMMAND
    for verb in ("start", "stop", "restart", "rm ", "kill", "prune", "exec", "run "):
        assert f"docker {verb}" not in command


def test_template_exposes_stats_button_and_columns():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="container-stats"' in html
    assert "刷新占用" in html
    assert 'id="container-stats-hint"' in html
    assert "<th>CPU</th><th>内存</th>" in html
    assert 'class="mono container-cpu"' in html
    assert 'class="mono container-mem"' in html


def test_script_wires_stats_request():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindContainerStats()" in js
    assert "/containers/stats" in js
    assert "bindContainerStats();" in js
    assert "读取中…" in js
    assert "占用为执行瞬间的单次采样" in js


def test_styles_for_container_stats():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.90 容器资源占用按需读取") :]
    assert ".container-stats-hint {" in tail
    assert ".container-stats-hint.is-error" in tail
    assert "#host-containers .container-cpu," in tail


# ---------------- 路由 ----------------
from servermanage.config import load_config_from_mapping  # noqa: E402
from servermanage.web import create_app  # noqa: E402
from servermanage.web import routes as routes_module  # noqa: E402


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
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


class _FakeSSH:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _client(tmp_path):
    app = create_app(config=_config(), db_path=tmp_path / "monitor.db")
    client = app.test_client()
    client.environ_base["HTTP_X_CSRF_TOKEN"] = session_token(client)
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def session_token(client) -> str:
    with client.session_transaction() as session:
        return session.get("csrf_token") or ""


def test_route_returns_stats_for_saved_host(tmp_path, monkeypatch):
    client = _client(tmp_path)
    monkeypatch.setattr(routes_module, "SSHClientWrapper", lambda **kwargs: _FakeSSH())
    monkeypatch.setattr(
        routes_module.container_stats_mod,
        "collect_container_stats",
        lambda host, ssh, timeout=30: [
            {"name": "web", "cpu_percent": 1.5, "memory_percent": 2.5, "memory_usage": "1GiB / 8GiB"}
        ],
    )
    response = client.post("/api/host/a100-zyc/containers/stats")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["containers"][0]["name"] == "web"
    assert payload["collected_at"]


def test_route_unknown_host_is_404(tmp_path):
    client = _client(tmp_path)
    assert client.post("/api/host/nope/containers/stats").status_code == 404


def test_route_reports_ssh_failure_without_raising(tmp_path, monkeypatch):
    client = _client(tmp_path)

    class _Boom:
        def __enter__(self):
            raise RuntimeError("ssh down")

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(routes_module, "SSHClientWrapper", lambda **kwargs: _Boom())
    response = client.post("/api/host/a100-zyc/containers/stats")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is False
    assert "ssh down" in payload["error"]
