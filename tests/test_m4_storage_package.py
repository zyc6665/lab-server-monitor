"""M4: storage.py split into per-domain modules.

``storage.py`` was a single 4 585-line module with ~126 top-level functions.
It is now a package; the facade re-exports every historical name so
``from servermanage import storage; storage.fn(...)`` keeps working, including
the private helpers other modules import (``_extract_disk_used_percent``) and
the module objects tests patch (``storage.sqlite3`` / ``storage._time``).
"""

from __future__ import annotations

from pathlib import Path

from servermanage import storage

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "servermanage" / "storage"

DOMAINS = {
    "base.py": ["def init_storage", "def _connect", "def maintain_database"],
    "hosts.py": ["def save_host_snapshot", "def get_all_host_snapshots",
                 "def persist_host_reports"],
    "metrics.py": ["def fetch_host_history", "def fetch_weekly_metrics"],
    "alerts.py": ["def insert_alert", "def list_alerts"],
    "disk.py": ["def save_disk_health", "def get_all_disk_health"],
    "users.py": ["def save_host_user_scan_result", "def get_all_user_usage_deltas"],
    "runtime.py": ["def database_integrity", "def backup_database"],
}


def test_package_layout():
    assert PACKAGE.is_dir(), "storage must be a package after M4"
    assert not (ROOT / "servermanage" / "storage.py").exists(), "old module must be gone"
    for name, markers in DOMAINS.items():
        source = (PACKAGE / name).read_text(encoding="utf-8")
        for marker in markers:
            assert marker in source, f"{name} missing {marker}"


def test_facade_reexports_every_historical_name():
    # 抽样覆盖各域 + 私有 helper（app.py 直接 import）
    for name in (
        "init_storage", "save_host_snapshot", "get_all_host_snapshots",
        "persist_host_reports", "fetch_host_history", "insert_alert",
        "list_alerts", "save_disk_health", "get_all_disk_health",
        "save_host_user_scan_result", "get_all_user_usage_deltas",
        "database_integrity", "backup_database", "restore_database",
        "_extract_disk_used_percent", "_connect", "_to_iso_utc",
    ):
        assert hasattr(storage, name), f"storage.{name} missing"


def test_module_objects_stay_patchable():
    # 测试用 storage.sqlite3.connect 计数、storage._time.monotonic 快进缓存
    assert hasattr(storage, "sqlite3")
    assert hasattr(storage, "_time")


def test_no_oversized_module():
    for path in PACKAGE.glob("*.py"):
        lines = len(path.read_text(encoding="utf-8").splitlines())
        assert lines < 1400, f"{path.name} is {lines} lines (split further)"
