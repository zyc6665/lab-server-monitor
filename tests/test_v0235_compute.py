"""v0.1.135：算力概览页（只读汇总）。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from servermanage.compute import build_compute_summary, spec_for
from servermanage.config import load_config_from_mapping
from servermanage.web import create_app

TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"
STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _snapshot(name: str, gpus: list[tuple[str, float, float, float | None]]) -> dict:
    return {
        "host_name": name,
        "collected_at": "2026-11-12T04:49:00+00:00",
        "success": True,
        "metrics": {
            "gpu_summary": [
                {
                    "index": index,
                    "name": model,
                    "memory_total_mb": total,
                    "memory_used_mb": used,
                    "utilization_percent": util,
                }
                for index, (model, total, used, util) in enumerate(gpus)
            ]
        },
    }


def test_spec_matching_covers_known_and_unknown_models():
    assert spec_for("NVIDIA A100 80GB PCIe").key == "a100"
    assert spec_for("NVIDIA H100 PCIe").key == "h100"
    assert spec_for("NVIDIA GeForce RTX 4090").key == "4090"
    assert spec_for("Tesla V100-PCIE-32GB").key == "v100"
    assert spec_for("Tesla K80").key == "k80"
    assert spec_for("Mystery Accelerator").key == "unknown"
    assert spec_for(None).tflops == 0.0


def test_summary_aggregates_capacity_and_usage():
    snapshots = [
        _snapshot("a100-zyc", [("NVIDIA A100 80GB PCIe", 81920, 77981, 100.0),
                               ("NVIDIA A100 80GB PCIe", 81920, 77959, 8.0)]),
        _snapshot("v100-zyc", [("Tesla V100-PCIE-32GB", 32768, 0, 0.0),
                               ("Tesla V100-PCIE-32GB", 32768, 0, 0.0)]),
    ]

    summary = build_compute_summary(snapshots)

    assert summary["totals"]["cards"] == 4
    assert summary["totals"]["vram_gb"] == 224.0
    assert summary["totals"]["tflops"] == 874.0
    assert summary["totals"]["pf16"] == 0.87
    assert [model["key"] for model in summary["models"]] == ["a100", "v100"]
    a100 = summary["models"][0]
    assert a100["cards"] == 2 and a100["vram_gb"] == 160.0 and a100["tier"] == "training"

    by_name = {host["name"]: host for host in summary["hosts"]}
    assert by_name["a100-zyc"]["util_avg"] == 54.0
    assert by_name["a100-zyc"]["vram_pct"] == 95.2
    assert by_name["a100-zyc"]["idle"] is False
    assert by_name["v100-zyc"]["idle"] is True
    assert [host["name"] for host in summary["idle_hosts"]] == ["v100-zyc"]


def _seed(db_path: Path) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.execute(
        "CREATE TABLE host_latest_snapshot (host_name TEXT PRIMARY KEY, collected_at TEXT,"
        " success INTEGER, raw_json TEXT)"
    )
    for name, gpus in (
        ("a100-zyc", [("NVIDIA A100 80GB PCIe", 81920, 40000, 90.0)]),
        ("k80-zyc", [("Tesla K80", 11441, 7, 0.0)]),
    ):
        snap = _snapshot(name, gpus)
        con.execute(
            "INSERT INTO host_latest_snapshot VALUES (?, ?, 1, ?)",
            (name, snap["collected_at"], json.dumps({"metrics": snap["metrics"]})),
        )
    con.commit()
    con.close()


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed(db_path)
    config = load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "group": "GPU 节点",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
                {
                    "name": "k80-zyc",
                    "host": "202.119.189.234",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                },
            ],
        }
    )
    app = create_app(config=config, db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "zyc"
    return client


def test_compute_page_lists_models_and_hosts(tmp_path):
    html = _client(tmp_path).get("/compute").get_data(as_text=True)

    assert "算力概览" in html
    assert 'data-compute-model="a100"' in html
    assert 'data-compute-model="k80"' in html
    assert 'data-compute-host="a100-zyc"' in html
    assert "GPU 节点" in html
    assert "训练主力" in html
    assert "老旧/仅推理" in html


def test_compute_api_returns_totals(tmp_path):
    payload = _client(tmp_path).get("/api/compute").get_json()

    assert payload["totals"]["cards"] == 2
    assert round(payload["totals"]["vram_gb"], 1) == 91.2
    assert payload["hosts"][0]["name"] == "a100-zyc"
    assert any("理论峰值" in note for note in payload["notes"])


def test_nav_and_style_are_wired():
    base = (TEMPLATES / "base.html").read_text(encoding="utf-8")
    assert "compute_page" in base and "算力概览" in base

    style = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".vram-bar {" in style
    assert ".tier-badge.tier-training" in style
