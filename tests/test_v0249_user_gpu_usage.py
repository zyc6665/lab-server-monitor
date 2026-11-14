"""v0.1.149：服务器用户页显示每个账号的 GPU 显存占用（只读聚合）。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from servermanage.storage import init_storage
from servermanage.web.routes import _gpu_usage_by_user, _host_user_counts

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def _seed_snapshot(db_path: Path, host: str, processes) -> None:
    init_storage(db_path)
    payload = {
        "host_name": host,
        "host": "10.0.0.1",
        "collected_at": "2026-11-14T04:00:00+00:00",
        "success": True,
        "metrics": {"gpu_processes": processes},
    }
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT OR REPLACE INTO host_latest_snapshot"
            " (host_name, collected_at, success, raw_json) VALUES (?, ?, 1, ?)",
            (host, payload["collected_at"], json.dumps(payload)),
        )
        conn.commit()


def test_gpu_usage_is_summed_per_account(tmp_path: Path):
    db_path = tmp_path / "servermonitor.db"
    _seed_snapshot(
        db_path,
        "a100-zyc",
        [
            {"index": 0, "pid": 1, "username": "zhangt", "memory_used_mb": 30000},
            {"index": 1, "pid": 2, "username": "zhangt", "memory_used_mb": 20000},
            {"index": 0, "pid": 3, "username": "hehy", "memory_used_mb": 8000},
            {"index": 1, "pid": 4, "username": "", "memory_used_mb": 4000},
            {"index": 1, "pid": 5, "username": "ghost", "memory_used_mb": 0},
        ],
    )

    usage = _gpu_usage_by_user("a100-zyc", db_path)
    assert usage["zhangt"] == {"mb": 50000.0, "procs": 2}
    assert usage["hehy"] == {"mb": 8000.0, "procs": 1}
    assert usage["ghost"]["mb"] == 0.0
    assert "" not in usage  # 空用户名不归属任何账号

    assert _gpu_usage_by_user("missing-host", db_path) == {}


def test_host_counts_roll_up_gpu_memory():
    rows = [
        {"state": "present", "gpu_memory_mb": 50000.0, "gpu_process_count": 2},
        {"state": "present", "gpu_memory_mb": 8000.0, "gpu_process_count": 1},
        {"state": "missing", "gpu_memory_mb": None, "gpu_process_count": 0},
    ]
    counts = _host_user_counts(rows)
    assert counts["gpu_memory_mb"] == 58000.0
    assert counts["gpu_processes"] == 3


def test_frontend_renders_gpu_chip():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function gpuChip(memoryMb, procs)" in js
    assert "chip.className = 'usage-gpu';" in js
    assert "显存 " in js and " 进程" in js
    assert js.count("gpuChip(row.gpu_memory_mb, row.gpu_process_count)") == 1
    assert "host.gpu_memory_mb" in js

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.149 用户页显示 GPU 显存占用 -- */" in css
    assert ".usage-gpu {" in css
    assert '[data-theme="dark"] .usage-gpu {' in css
