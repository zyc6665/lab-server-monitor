from __future__ import annotations

import os
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

from servermanage.log_cleanup import prune_log_files

CACHE_DIRS = (
    "Cache",
    "Code Cache",
    "GPUCache",
    "GrShaderCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "ShaderCache",
)


def directory_size(path: Path) -> int:
    root = Path(path)
    if not root.exists():
        return 0
    if root.is_file():
        try:
            return root.stat().st_size
        except OSError:
            return 0
    total = 0
    for current, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += (Path(current) / name).stat().st_size
            except OSError:
                continue
    return total


def storage_usage(db_path: Path) -> dict[str, int]:
    db_path = Path(db_path)
    app_dir = db_path.parent.parent
    return {
        "database": directory_size(db_path),
        "logs": directory_size(app_dir / "logs"),
        "updates": directory_size(app_dir / "data" / "updates"),
        "electron": directory_size(app_dir / "data" / "electron"),
        "total": directory_size(app_dir),
    }


def cleanup_logs(
    log_dir: Path,
    *,
    retention_hours: int = 24,
    now: datetime | None = None,
) -> dict[str, int]:
    return prune_log_files(
        Path(log_dir),
        retention_hours=retention_hours,
        now=now,
        protected_names=("servermonitor.log", "desktop.log"),
    )


def cleanup_updates(
    updates_dir: Path,
    *,
    retention_hours: int = 24,
    now: datetime | None = None,
) -> dict[str, int]:
    root = Path(updates_dir)
    if not root.is_dir():
        return {"deleted": 0, "bytes": 0}
    current = now or datetime.now(timezone.utc)
    cutoff = (current - timedelta(hours=retention_hours)).timestamp()
    deleted = 0
    freed = 0
    for path in root.rglob("*.zip"):
        if not path.is_file():
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if retention_hours > 0 and stat.st_mtime >= cutoff:
            continue
        try:
            path.unlink()
        except OSError:
            continue
        deleted += 1
        freed += stat.st_size
    return {"deleted": deleted, "bytes": freed}


def cleanup_electron_cache(
    user_data_dir: Path,
    *,
    cache_dirs: tuple[str, ...] = CACHE_DIRS,
) -> dict[str, int]:
    root = Path(user_data_dir)
    deleted = 0
    freed = 0
    for name in cache_dirs:
        target = root / name
        if not target.exists():
            continue
        size = directory_size(target)
        try:
            shutil.rmtree(target)
        except OSError:
            continue
        deleted += 1
        freed += size
    return {"deleted": deleted, "bytes": freed}
