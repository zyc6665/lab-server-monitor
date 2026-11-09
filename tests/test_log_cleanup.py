from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.log_cleanup import prune_log_files


def _touch(path: Path, when: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x", encoding="utf-8")
    stamp = when.timestamp()
    os.utime(path, (stamp, stamp))


def test_prune_log_files_removes_only_expired_files(tmp_path: Path) -> None:
    now = datetime(2026, 11, 9, 10, 0, tzinfo=timezone.utc)
    old = tmp_path / "servermonitor.log.1"
    recent = tmp_path / "desktop.log"
    active = tmp_path / "servermonitor.log"
    _touch(old, now - timedelta(hours=30))
    _touch(recent, now - timedelta(hours=2))
    _touch(active, now - timedelta(hours=40))

    result = prune_log_files(
        tmp_path,
        retention_hours=24,
        now=now,
        protected_names=("servermonitor.log",),
    )

    assert result["deleted"] == 1
    assert not old.exists()
    assert recent.exists()
    assert active.exists()
    assert result["bytes"] > 0


def test_prune_log_files_ignores_missing_directory(tmp_path: Path) -> None:
    result = prune_log_files(tmp_path / "missing", now=datetime.now(timezone.utc))
    assert result["deleted"] == 0
    assert result["bytes"] == 0
