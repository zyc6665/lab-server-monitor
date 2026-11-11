"""v0.1.92：服务检查支持立即执行（只读）。"""

from __future__ import annotations

from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult, HostCheckConfig, HostCheckResult
from servermanage.web import create_app
from servermanage.web import routes as routes_module

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _config(checks=True):
    server = {
        "name": "a100-zyc",
        "host": "202.119.189.245",
        "username": "root",
        "auth": {"type": "key", "key_data": "PEM"},
    }
    if checks:
        server["checks"] = [
            {"name": "SSH 22", "type": "tcp", "target": "127.0.0.1:22"},
            {"name": "nginx", "type": "process", "target": "nginx"},
        ]
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [server],
        }
    )


def _client(tmp_path, checks=True):
    app = create_app(config=_config(checks=checks), db_path=tmp_path / "monitor.db")
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
        token = session.get("csrf_token")
    if not token:
        client.get("/login")
        with client.session_transaction() as session:
            token = session.get("csrf_token")
    client.environ_base["HTTP_X_CSRF_TOKEN"] = token or ""
    return client


class _FakeSSH:
    def __init__(self):
        self.commands: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def run(self, command, timeout=None):
        self.commands.append(command)
        return CommandResult(stdout="ok", stderr="", exit_status=0)


def test_route_runs_checks_and_persists(tmp_path, monkeypatch):
    client = _client(tmp_path)
    calls = {}

    def fake_checks(host, runner, checks, timeout):
        calls["count"] = len(checks)
        return [
            HostCheckResult(
                name=check.name,
                type=check.type,
                target=check.target,
                status="ok",
                message="reachable",
                latency_ms=3.5,
            )
            for check in checks
        ]

    monkeypatch.setattr(routes_module, "SSHClientWrapper", lambda **kwargs: _FakeSSH())
    monkeypatch.setattr(routes_module.availability, "run_host_checks", fake_checks)

    response = client.post("/api/host/a100-zyc/checks/run")
    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["checked_at"]
    assert [row["name"] for row in payload["checks"]] == ["SSH 22", "nginx"]
    assert payload["checks"][0]["latency_ms"] == 3.5
    assert calls["count"] == 2


def test_route_reports_no_checks_configured(tmp_path):
    client = _client(tmp_path, checks=False)
    response = client.post("/api/host/a100-zyc/checks/run")
    payload = response.get_json()
    assert payload["ok"] is False
    assert "还没有配置" in payload["error"]


def test_route_unknown_host_is_404(tmp_path):
    client = _client(tmp_path)
    assert client.post("/api/host/nope/checks/run").status_code == 404


def test_route_surfaces_ssh_error(tmp_path, monkeypatch):
    client = _client(tmp_path)

    class _Boom:
        def __enter__(self):
            raise RuntimeError("auth failed")

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(routes_module, "SSHClientWrapper", lambda **kwargs: _Boom())
    payload = client.post("/api/host/a100-zyc/checks/run").get_json()
    assert payload["ok"] is False
    assert "auth failed" in payload["error"]


def test_route_does_not_use_write_commands(tmp_path, monkeypatch):
    client = _client(tmp_path)
    ssh = _FakeSSH()
    monkeypatch.setattr(routes_module, "SSHClientWrapper", lambda **kwargs: ssh)
    client.post("/api/host/a100-zyc/checks/run")
    joined = " ".join(ssh.commands)
    for verb in ("systemctl start", "systemctl stop", "docker restart", "rm -rf", "kill "):
        assert verb not in joined


def test_template_has_checks_run_button():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert 'id="host-checks-run"' in html
    assert "立即检查" in html
    assert 'id="host-checks-hint"' in html


def test_script_wires_checks_run():
    js = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function bindChecksRun()" in js
    assert "/checks/run" in js
    assert "bindChecksRun();" in js
    assert "检查中…" in js


def test_styles_for_checks_run():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    tail = css[css.index("v0.1.92 服务检查立即执行") :]
    assert ".checks-actions" in tail
    assert ".checks-hint.is-warn" in tail
    assert ".checks-hint.is-error" in tail
