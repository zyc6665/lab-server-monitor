"""v0.1.229：备份下载流式传输 + 采集统一队列。

- ``GET /api/system/backup`` 此前 ``read_bytes`` 把整个数据库读进内存
  （历史表会一直增长，点一次备份就顶一次 RAM，还占住一个 waitress 工作线程）；
  现在按 1 MB 分块流式输出，发送完即删除临时文件。
- 导入自动采集此前每次 API 调用起一条裸线程：两次请求可能同时轮询同一台
  主机（SSH 负载翻倍、告警重复评估）。现在由单一工作线程消费队列，
  同一台主机在途期间不会再次入队。
"""

from __future__ import annotations

import glob
import sqlite3
import tempfile
import threading
import time
from pathlib import Path

from servermanage import storage
from servermanage.app import MonitorService
from servermanage.models import (
    AppConfig,
    AuthConfig,
    HostConfig,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
)
from servermanage.settings import SettingsService
from servermanage.web import create_app

ADMIN_PASSWORD = "AdminPass!23"


# ---------------------------------------------------------------------------
# 备份流式下载
# ---------------------------------------------------------------------------


def _client(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = storage and __import__("servermanage.config", fromlist=["load_config_from_mapping"]).load_config_from_mapping(
        {}, allow_empty_servers=True
    )
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=svc.load(), db_path=db, settings_service=svc)
    client = app.test_client()
    page = client.get("/setup").get_data(as_text=True)
    client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": __import__("re").search(
                r'name="csrf_token" value="([^"]+)"', page
            ).group(1),
        },
    )
    client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD})
    return client


def test_backup_streams_sqlite_and_cleans_temp(tmp_path: Path):
    import re

    db = tmp_path / "m.db"
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE marker(value TEXT)")
        conn.execute("INSERT INTO marker VALUES ('payload')")
        conn.commit()

    tempdir = tempfile.gettempdir()
    before = set(glob.glob(str(Path(tempdir) / "servermonitor-backup-*.db")))

    client = _client(tmp_path)
    response = client.get("/api/system/backup")

    assert response.status_code == 200
    assert response.mimetype == "application/octet-stream"
    assert "attachment" in response.headers.get("Content-Disposition", "")
    # 流式响应被完整消费：内容是合法 SQLite 文件且包含数据。
    body = response.data
    assert body.startswith(b"SQLite format 3\x00")
    assert b"payload" in body
    # 发送完成后临时文件必须清理干净。
    time.sleep(0.05)
    after = set(glob.glob(str(Path(tempdir) / "servermonitor-backup-*.db")))
    assert len(after - before) == 0, f"leftover temp files: {after - before}"


def test_backup_content_restores_into_a_working_database(tmp_path: Path):
    db = tmp_path / "m.db"
    storage.init_storage(db)
    with sqlite3.connect(db) as conn:
        conn.execute("CREATE TABLE marker(value TEXT)")
        conn.execute("INSERT INTO marker VALUES ('payload')")
        conn.commit()

    client = _client(tmp_path)
    body = client.get("/api/system/backup").data

    restored = tmp_path / "restored.db"
    restored.write_bytes(body)
    conn = sqlite3.connect(restored)
    try:
        value = conn.execute("SELECT value FROM marker").fetchone()[0]
    finally:
        conn.close()
    assert value == "payload"


# ---------------------------------------------------------------------------
# 采集统一队列
# ---------------------------------------------------------------------------


def _service(tmp_path: Path, collect_status) -> MonitorService:
    hosts = [
        HostConfig(
            name=name,
            host=f"10.0.0.{index}",
            port=22,
            username="root",
            auth=AuthConfig(type="password", password="pw"),
        )
        for index, name in enumerate(("gpu-01", "nas-01"), start=1)
    ]
    return MonitorService(
        AppConfig(
            smtp=None,
            ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
            report=ReportConfig(subject_prefix="[Daily]"),
            servers=hosts,
        ),
        db_path=tmp_path / "monitor.db",
        collect_status=collect_status,
    )


def _wait(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


def test_collection_queue_runs_batches_serially(tmp_path: Path):
    storage.init_storage(tmp_path / "monitor.db")
    release = threading.Event()
    started_first = threading.Event()
    seen_batches: list[set[str]] = []
    threads_seen: set[int] = set()
    lock = threading.Lock()
    active = {"count": 0, "max": 0}

    def collect(config):
        names = {server.name for server in config.servers}
        with lock:
            seen_batches.append(set(names))
            threads_seen.add(threading.get_ident())
            active["count"] += 1
            active["max"] = max(active["max"], active["count"])
        if len(seen_batches) == 1:
            started_first.set()
            release.wait(timeout=5)
        with lock:
            active["count"] -= 1
        return []

    service = _service(tmp_path, collect)

    service.schedule_host_collection({"gpu-01"}, include_disk=False)
    assert started_first.wait(timeout=5), "first batch never started"
    # 第一批还在执行时，提交带重叠主机的第二批。
    service.schedule_host_collection({"gpu-01", "nas-01"}, include_disk=False)
    release.set()  # 放行第一批

    assert _wait(
        lambda: service.collection_status(["gpu-01", "nas-01"])
        and all(
            service.collection_status([n])[n]["state"] in ("done", "error")
            for n in ("gpu-01", "nas-01")
        ),
        timeout=5,
    )

    # 重叠的主机不重复采集；批次串行执行（无并发）。
    assert seen_batches == [{"gpu-01"}, {"nas-01"}], seen_batches
    assert len(threads_seen) == 1, "collection must use a single worker thread"
    assert active["max"] == 1


def test_duplicate_request_while_in_flight_is_dropped(tmp_path: Path):
    storage.init_storage(tmp_path / "monitor.db")
    release = threading.Event()
    started = threading.Event()
    calls: list[set[str]] = []

    def collect(config):
        calls.append({server.name for server in config.servers})
        started.set()
        release.wait(timeout=5)
        return []

    service = _service(tmp_path, collect)
    service.schedule_host_collection({"gpu-01"}, include_disk=False)
    assert started.wait(timeout=5)
    service.schedule_host_collection({"gpu-01"}, include_disk=False)  # 在途期间重复请求
    assert not _wait(
        lambda: len(calls) > 1, timeout=0.3
    ), "duplicate request must not start a second round"
    release.set()
    assert _wait(
        lambda: service.collection_status(["gpu-01"])["gpu-01"]["state"] == "done",
        timeout=5,
    )
    assert calls == [{"gpu-01"}]
