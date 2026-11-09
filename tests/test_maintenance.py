from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage import storage
from servermanage.maintenance import (
    cleanup_electron_cache,
    cleanup_updates,
    directory_size,
    storage_usage,
)


def _touch(path: Path, size: int, when: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)
    os.utime(path, (when.timestamp(), when.timestamp()))


def test_cleanup_updates_only_removes_expired_zips(tmp_path: Path) -> None:
    now = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
    old = tmp_path / "download" / "old.zip"
    recent = tmp_path / "download" / "recent.zip"
    _touch(old, 100, now - timedelta(hours=30))
    _touch(recent, 50, now - timedelta(hours=1))

    result = cleanup_updates(tmp_path, retention_hours=24, now=now)

    assert result == {"deleted": 1, "bytes": 100}
    assert not old.exists()
    assert recent.exists()


def test_cleanup_updates_zero_hours_removes_all(tmp_path: Path) -> None:
    now = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
    first = tmp_path / "a.zip"
    second = tmp_path / "b.zip"
    _touch(first, 10, now)
    _touch(second, 20, now)

    result = cleanup_updates(tmp_path, retention_hours=0, now=now)

    assert result == {"deleted": 2, "bytes": 30}


def test_cleanup_electron_cache_removes_known_directories(tmp_path: Path) -> None:
    cache = tmp_path / "Cache"
    cache.mkdir()
    (cache / "data").write_bytes(b"x" * 40)
    (tmp_path / "Local Storage").mkdir()
    (tmp_path / "Local Storage" / "state").write_bytes(b"keep")

    result = cleanup_electron_cache(tmp_path, cache_dirs=("Cache",))

    assert result == {"deleted": 1, "bytes": 40}
    assert not cache.exists()
    assert (tmp_path / "Local Storage" / "state").read_bytes() == b"keep"


def test_storage_usage_reports_app_directories(tmp_path: Path) -> None:
    app_dir = tmp_path / "app"
    data_dir = app_dir / "data"
    (data_dir / "updates").mkdir(parents=True)
    (data_dir / "electron").mkdir(parents=True)
    (app_dir / "logs").mkdir(parents=True)
    db = data_dir / "servermonitor.db"
    _touch(db, 12, datetime.now(timezone.utc))
    _touch(data_dir / "updates" / "x.zip", 20, datetime.now(timezone.utc))
    _touch(data_dir / "electron" / "CacheFile", 30, datetime.now(timezone.utc))
    _touch(app_dir / "logs" / "x.log", 40, datetime.now(timezone.utc))

    usage = storage_usage(db)

    assert usage["database"] == 12
    assert usage["updates"] == 20
    assert usage["electron"] == 30
    assert usage["logs"] == 40
    assert usage["total"] == 102


def test_database_integrity_cache_reuses_result(tmp_path: Path, monkeypatch) -> None:
    db = tmp_path / "monitor.db"
    storage.init_storage(db)
    calls = {"count": 0}
    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        calls["count"] += 1
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(storage.sqlite3, "connect", counting_connect)

    first = storage.database_integrity(db, cache_seconds=60)
    second = storage.database_integrity(db, cache_seconds=60)

    assert first == (True, "完整性检查通过")
    assert second == first
    assert calls["count"] == 1


def test_maintain_database_compacts_existing_database(tmp_path: Path) -> None:
    db = tmp_path / "legacy.db"
    conn = sqlite3.connect(db)
    try:
        conn.execute("PRAGMA auto_vacuum = NONE")
        conn.execute("CREATE TABLE payload(value TEXT)")
        conn.executemany(
            "INSERT INTO payload(value) VALUES (?)",
            [("x" * 500,) for _ in range(500)],
        )
        conn.execute("DELETE FROM payload")
        conn.commit()
    finally:
        conn.close()

    result = storage.maintain_database(db, force=True)

    assert result["vacuumed"] is True
    with sqlite3.connect(db) as conn:
        assert conn.execute("PRAGMA auto_vacuum").fetchone()[0] == 2
        assert conn.execute("PRAGMA freelist_count").fetchone()[0] == 0


