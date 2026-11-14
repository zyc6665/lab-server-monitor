"""v0.1.148：算力概览里的「按用户占用」排行（只读聚合）。"""

from __future__ import annotations

from pathlib import Path

from servermanage.compute import build_compute_summary

ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _snapshot(name: str, processes, *, used_mb=40000):
    return {
        "host_name": name,
        "collected_at": "2026-11-14T02:00:00+00:00",
        "metrics": {
            "gpu_summary": [
                {
                    "index": 0,
                    "name": "NVIDIA A100",
                    "memory_total_mb": 81920,
                    "memory_used_mb": used_mb,
                    "utilization_percent": 50.0,
                }
            ],
            "gpu_processes": processes,
        },
    }


def test_users_are_aggregated_across_hosts():
    summary = build_compute_summary(
        [
            _snapshot(
                "a100-zyc",
                [
                    {"index": 0, "pid": 1, "username": "alice", "memory_used_mb": 30000, "command": "python train.py"},
                    {"index": 1, "pid": 2, "username": "alice", "memory_used_mb": 20000, "command": "python eval.py"},
                    {"index": 1, "pid": 3, "username": "bob", "memory_used_mb": 10000, "command": "python small.py"},
                ],
            ),
            _snapshot(
                "h100-zyc",
                [
                    {"index": 0, "pid": 9, "username": "alice", "memory_used_mb": 40000, "command": "python big.py"},
                ],
            ),
        ]
    )

    users = summary["users"]
    assert [row["user"] for row in users] == ["alice", "bob"]
    alice = users[0]
    assert alice["memory_gb"] == 87.9  # (30000 + 20000 + 40000) / 1024
    assert alice["processes"] == 3
    assert alice["cards"] == 3  # (a100, 0)、(a100, 1)、(h100, 0)
    assert alice["hosts"] == ["a100-zyc", "h100-zyc"]
    assert alice["command"] == "python big.py"  # 占显存最多的那条命令
    assert round(alice["share"] + users[1]["share"], 1) == 100.0


def test_hosts_without_processes_produce_no_rows():
    summary = build_compute_summary([_snapshot("idle-zyc", [])])
    assert summary["users"] == []
    assert summary["totals"]["cards"] == 1


def test_page_lists_users_and_style_truncates_commands():
    html = (TEMPLATES / "compute.html").read_text(encoding="utf-8")
    assert 'id="compute"' in html or "compute.html" not in html
    assert "按用户占用" in html
    assert 'data-compute-user="{{ user.user }}"' in html
    assert "{{ '%.1f'|format(user.share) }}%" in html
    assert "{{ user.hosts|join('、') }}" in html

    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "/* -- v0.1.148 算力概览按用户占用 -- */" in css
    assert ".compute-users td.compute-cmd {" in css
    assert "text-overflow: ellipsis;" in css
