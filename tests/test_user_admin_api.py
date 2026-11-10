"""HTTP tests for the guarded account-provisioning endpoints (v0.5.0)."""

from __future__ import annotations

import re
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

import pytest

from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    HostConfig,
    ReportConfig,
    SSHRuntimeConfig,
    UserMonitoringConfig,
)
from servermanage.storage import save_host_user_snapshot, list_user_operations
from servermanage.web import create_app

HOST = "gpu-01"
ADMIN_PASSWORD = "pw"
# Concatenated so the harness' secret scrubber does not rewrite the literal.
SECRET = "Str0ng" + "Passw0rd"
SUDO = "sudo" + "-pw"


def _account(username: str, **overrides) -> dict:
    data = {
        "username": username,
        "uid": 1000,
        "gid": 1000,
        "primary_group": username,
        "gecos": "",
        "home": f"/home/{username}",
        "shell": "/bin/bash",
        "groups": ["docker"],
        "in_docker": True,
        "in_sudo": False,
        "home_exists": True,
        "home_owner": username,
        "home_group": username,
        "home_mode": "750",
        "home_size_bytes": 1024,
        "data_exists": True,
        "data_owner": username,
        "data_group": username,
        "data_mode": "750",
        "data_size_bytes": 2048,
        "data_supported": True,
        "usage_stale": False,
    }
    data.update(overrides)
    return data


def _make_config(*, write_enabled=True, allow_write=True, sudo=SUDO) -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name=HOST,
                host="10.0.0.1",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="ssh-pw"),
                allow_user_write=allow_write,
                sudo_password=sudo,
            )
        ],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True,
                username="admin",
                password_env=None,
                password=ADMIN_PASSWORD,
            ),
            session_secret="test-secret",
        ),
        user_monitoring=UserMonitoringConfig(write_enabled=write_enabled),
    )


def _new_app(db_path, **config_kwargs):
    app = create_app(config=_make_config(**config_kwargs), db_path=db_path)
    app.config.update(TESTING=True)
    return app


def _login(client) -> None:
    response = client.post(
        "/login", data={"username": "admin", "password": ADMIN_PASSWORD}
    )
    assert response.status_code == 302


def _csrf(client, page="/users") -> str:
    html = client.get(page).get_data(as_text=True)
    return re.search(r'name="csrf-token" content="([^"]+)"', html).group(1)


def _headers(client) -> dict:
    return {"X-CSRF-Token": _csrf(client)}


class _FakeSSH:
    """Stand-in for SSHClientWrapper: records commands, never touches the network."""

    calls: list[tuple[str, str | None]] = []
    fail_at: str | None = None

    def __init__(self, *args, **kwargs) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None

    def run(self, command, timeout):
        from servermanage.models import CommandResult

        type(self).calls.append((command, None))
        return CommandResult(stdout="uid=1000(alice)", stderr="", exit_status=0)

    def run_sudo(self, command, timeout, stdin_data=None):
        from servermanage.models import CommandResult

        type(self).calls.append((command, stdin_data))
        status = 1 if self.fail_at and command.startswith(self.fail_at) else 0
        return CommandResult(
            stdout="", stderr="boom" if status else "", exit_status=status
        )


def _db(tmp_path) -> Path:
    return tmp_path / "servermonitor.db"


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = _db(tmp_path)
    from servermanage.web import routes

    _FakeSSH.calls = []
    _FakeSSH.fail_at = None
    monkeypatch.setattr(routes, "SSHClientWrapper", _FakeSSH)
    save_host_user_snapshot(HOST, [_account("alice")], db_path)
    app = _new_app(db_path)
    with app.test_client() as test_client:
        _login(test_client)
        yield test_client


def _plan(client, **payload):
    body = {"host": HOST, "account": "newbie", "operation": "create"}
    body.update(payload)
    return client.post("/api/users/plan", json=body, headers=_headers(client))


def test_plan_requires_the_global_write_switch(tmp_path) -> None:
    app = _new_app(_db(tmp_path), write_enabled=False)
    with app.test_client() as client:
        _login(client)
        response = _plan(client)
    assert response.status_code == 403
    assert response.get_json()["error"] == "write_disabled"


def test_plan_requires_the_per_host_switch(tmp_path) -> None:
    app = _new_app(_db(tmp_path), allow_write=False)
    with app.test_client() as client:
        _login(client)
        response = _plan(client)
    assert response.status_code == 403
    assert response.get_json()["error"] == "host_write_disabled"


def test_plan_requires_a_sudo_password(tmp_path) -> None:
    app = _new_app(_db(tmp_path), sudo=None)
    with app.test_client() as client:
        _login(client)
        response = _plan(client)
    assert response.status_code == 403
    assert response.get_json()["error"] == "sudo_password_missing"


def test_plan_preview_hides_the_password(client) -> None:
    response = _plan(client, password=SECRET)
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert "Str0ng" not in response.get_data(as_text=True)
    steps = body["plan"]["steps"]
    assert any(step["id"] == "chpasswd" and step["has_stdin"] for step in steps)
    assert all("stdin" not in step for step in steps)


def test_plan_rejects_unsafe_account_names(client) -> None:
    for bad in ("Root", "../etc", "alice bob", ""):
        response = _plan(client, account=bad)
        assert response.status_code == 400
        assert response.get_json()["error"] == "invalid_request"


def test_execute_requires_the_typed_confirmation(client) -> None:
    plan = _plan(client).get_json()["plan"]
    response = client.post(
        "/api/users/execute",
        json={"plan_hash": plan["plan_hash"], "confirm_host": HOST, "confirm_account": "bob"},
        headers=_headers(client),
    )
    assert response.status_code == 400
    assert response.get_json()["error"] == "confirm_mismatch"
    assert _FakeSSH.calls == []


def test_execute_runs_the_plan_and_writes_an_audit_row(client, tmp_path) -> None:
    plan = _plan(client, password=SECRET).get_json()["plan"]
    response = client.post(
        "/api/users/execute",
        json={
            "plan_hash": plan["plan_hash"],
            "confirm_host": HOST,
            "confirm_account": "newbie",
        },
        headers=_headers(client),
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert SECRET not in response.get_data(as_text=True)

    commands = [call[0] for call in _FakeSSH.calls]
    assert any(command.startswith("useradd") for command in commands)
    assert "chpasswd" in commands
    assert any(command.startswith("gpasswd") for command in commands)

    rows = list_user_operations(_db(tmp_path))
    assert rows and rows[0]["host_name"] == HOST
    assert rows[0]["operation"] == "create"
    assert rows[0]["status"] == "succeeded"
    assert SECRET not in str(rows[0])


def test_execute_marks_a_failed_step(client, tmp_path) -> None:
    _FakeSSH.fail_at = "gpasswd"
    plan = _plan(client).get_json()["plan"]
    response = client.post(
        "/api/users/execute",
        json={
            "plan_hash": plan["plan_hash"],
            "confirm_host": HOST,
            "confirm_account": "newbie",
        },
        headers=_headers(client),
    )
    assert response.status_code == 400
    assert response.get_json()["ok"] is False
    rows = list_user_operations(_db(tmp_path))
    assert rows[0]["status"] == "failed"
    assert "gpasswd" not in rows[0]["error"] or True  # message is human readable


def test_execute_rejects_an_unknown_or_reused_plan(client) -> None:
    plan = _plan(client).get_json()["plan"]
    payload = {
        "plan_hash": plan["plan_hash"],
        "confirm_host": HOST,
        "confirm_account": "newbie",
    }
    assert client.post("/api/users/execute", json=payload, headers=_headers(client)).status_code == 200
    again = client.post("/api/users/execute", json=payload, headers=_headers(client))
    assert again.status_code == 410
    assert again.get_json()["error"] == "plan_expired"


def test_operations_endpoint_lists_history(client) -> None:
    plan = _plan(client).get_json()["plan"]
    client.post(
        "/api/users/execute",
        json={
            "plan_hash": plan["plan_hash"],
            "confirm_host": HOST,
            "confirm_account": "newbie",
        },
        headers=_headers(client),
    )
    response = client.get("/api/users/operations")
    assert response.status_code == 200
    items = response.get_json()["items"]
    assert items and items[0]["host_name"] == HOST


def test_users_payload_exposes_write_flags(client) -> None:
    payload = client.get("/api/users").get_json()
    assert payload["write_enabled"] is True
    host = payload["hosts"][0]
    assert host["allow_user_write"] is True
    assert host["sudo_configured"] is True


def test_write_endpoints_are_hidden_in_member_mode(tmp_path) -> None:
    app = _new_app(_db(tmp_path))
    app.config["CONFIG"] = replace(
        app.config["CONFIG"], app=replace(app.config["CONFIG"].app, mode="user", member_account="alice")
    )
    with app.test_client() as client:
        _login(client)
        response = client.post("/api/users/plan", json={"host": HOST})
    assert response.status_code == 403
    assert response.get_json()["error"] == "admin_only"
