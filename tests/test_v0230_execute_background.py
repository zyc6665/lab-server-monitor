"""v0.1.230：账号操作改为后台任务执行。

此前 ``POST /api/users/execute`` 在请求线程里同步跑完整计划（最多 6 步 sudo
SSH）：慢主机会把浏览器拖到超时；超时后重试还可能重复执行（计划缓存直到
执行完才丢弃）。现在提交即入队、返回 ``job_id``，由后台线程执行并写审计，
前端轮询 ``GET /api/users/execute/status``（只含脱敏步骤，按 actor 隔离）。
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest

from servermanage.storage import list_user_operations
from servermanage.web import routes
from servermanage.web import create_app

import test_user_admin_api as base

HOST = base.HOST
SECRET = base.SECRET


class _BlockingSSH(base._FakeSSH):
    """Optional blocking fake: only blocks when ``block`` is switched on."""

    gate: threading.Event = threading.Event()
    entered: threading.Event = threading.Event()
    block = False

    def run_sudo(self, command, timeout, stdin_data=None):
        type(self).calls.append((command, stdin_data))
        if type(self).block:
            type(self).entered.set()
            type(self).gate.wait(timeout=5)
        from servermanage.models import CommandResult

        return CommandResult(stdout="", stderr="", exit_status=0)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_path = base._db(tmp_path)
    _BlockingSSH.calls = []
    _BlockingSSH.fail_at = None
    monkeypatch.setattr(routes, "SSHClientWrapper", _BlockingSSH)
    base.save_host_user_snapshot(HOST, [base._account("alice")], db_path)
    app = create_app(config=base._make_config(), db_path=db_path)
    app.config.update(TESTING=True)
    with app.test_client() as test_client:
        base._login(test_client)
        yield test_client


def _plan(client):
    return base._plan(client).get_json()["plan"]


def _submit(client):
    plan = _plan(client)
    return client.post(
        "/api/users/execute",
        json={
            "plan_hash": plan["plan_hash"],
            "confirm_host": HOST,
            "confirm_account": "newbie",
        },
        headers=base._headers(client),
    )


def _wait_job_done(client, job_id, timeout: float = 5.0) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.get(f"/api/users/execute/status?job_id={job_id}")
        assert response.status_code == 200
        payload = response.get_json()
        if payload["state"] != "running":
            return payload
        time.sleep(0.02)
    raise AssertionError("job did not finish in time")


def test_submit_returns_job_id_and_status_polls(tmp_path, client):
    response = _submit(client)
    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["job_id"]

    status = client.get(f"/api/users/execute/status?job_id={body['job_id']}")
    assert status.status_code == 200
    payload = status.get_json()
    assert payload["state"] in ("running", "done")
    assert payload["host"] == HOST
    assert payload["account"] == "newbie"

    job = _wait_job_done(client, body["job_id"])
    assert job["state"] == "done"
    assert job["ok"] is True
    # 步骤已带执行结果
    assert any(step.get("status") == "ok" for step in job["steps"] if step.get("id"))


def test_status_payload_never_contains_secrets(tmp_path, client):
    plan = base._plan(client, password=SECRET).get_json()["plan"]
    response = client.post(
        "/api/users/execute",
        json={
            "plan_hash": plan["plan_hash"],
            "confirm_host": HOST,
            "confirm_account": "newbie",
        },
        headers=base._headers(client),
    )
    job_id = response.get_json()["job_id"]
    status = client.get(f"/api/users/execute/status?job_id={job_id}")
    text = status.get_data(as_text=True)
    # 计划里的 chpasswd 步骤带明文密码（stdin），状态接口只允许脱敏字段。
    assert SECRET not in text
    assert '"stdin"' not in text
    _wait_job_done(client, job_id)


def test_plan_is_invalidated_at_enqueue_time(client):
    # 慢执行期间再次提交同一计划：计划已在入队时作废 → 410，不会重复执行。
    plan = _plan(client)
    payload = {
        "plan_hash": plan["plan_hash"],
        "confirm_host": HOST,
        "confirm_account": "newbie",
    }
    _BlockingSSH.block = True
    first = client.post("/api/users/execute", json=payload, headers=base._headers(client))
    assert first.status_code == 200

    again = client.post("/api/users/execute", json=payload, headers=base._headers(client))
    assert again.status_code == 410
    assert again.get_json()["error"] == "plan_expired"

    assert _BlockingSSH.entered.wait(timeout=2)
    _BlockingSSH.gate.set()
    _wait_job_done(client, first.get_json()["job_id"])
    chpasswd_runs = [c for c in _BlockingSSH.calls if c[0].startswith("chpasswd")]
    assert len(chpasswd_runs) == 1


def test_status_endpoint_validates_job_id(client):
    assert client.get("/api/users/execute/status").status_code == 400
    assert client.get("/api/users/execute/status?job_id=nope").status_code == 404


def test_audit_row_written_by_worker(client, tmp_path):
    submitted = _submit(client)
    _wait_job_done(client, submitted.get_json()["job_id"])
    rows = list_user_operations(base._db(tmp_path))
    assert rows and rows[0]["operation"] == "create"
    assert rows[0]["status"] == "succeeded"


def test_frontend_polls_execute_status():
    js = (Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static" / "users.js").read_text(
        encoding="utf-8"
    )
    assert "function pollExecuteStatus(jobId, attempt)" in js
    assert "'/api/users/execute/status?job_id='" in js
    assert "function adminGet(url)" in js
    # 提交成功后必须进入轮询，而不是把轮次留在请求线程里。
    assert "pollExecuteStatus(result.data.job_id, 0)" in js
