from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable


def prune_log_files(
    log_dir: Path,
    *,
    retention_hours: int = 24,
    now: datetime | None = None,
    protected_names: Iterable[str] = (),
) -> dict[str, int]:
    """Delete log files older than ``retention_hours``.

    ``protected_names`` are files that may still be held open by a process and
    must never be removed (for example ``servermonitor.log`` or ``desktop.log``).
    Returns the number of files removed and the freed bytes.
    """
    directory = Path(log_dir)
    if not directory.is_dir():
        return {"deleted": 0, "bytes": 0}

    current = now or datetime.now(timezone.utc)
    cutoff = (current - timedelta(hours=retention_hours)).timestamp()
    protected = {str(name) for name in protected_names}
    deleted = 0
    freed = 0

    for path in directory.iterdir():
        if not path.is_file() or path.name in protected:
            continue
        if not path.name.endswith(".log") and ".log." not in path.name:
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_mtime >= cutoff:
            continue
        try:
            path.unlink()
        except OSError:
            continue
        deleted += 1
        freed += stat.st_size

    return {"deleted": deleted, "bytes": freed}
