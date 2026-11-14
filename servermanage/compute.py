"""Fleet-level compute summary derived from the collected GPU snapshots.

Everything here is read-only: it only reshapes data that the regular polling
round already stored, so no extra SSH command is issued.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

GB = 1024.0  # snapshots report MiB


@dataclass(frozen=True)
class GpuSpec:
    """Vendor-published dense FP16/BF16 figures for one accelerator family."""

    key: str
    match: tuple[str, ...]
    label: str
    tflops: float
    bandwidth_gbs: float
    tier: str


# Dense (non-sparse) FP16/BF16 tensor throughput and memory bandwidth, as
# published by the vendor.  Numbers are theoretical peaks for reference only.
GPU_SPECS: tuple[GpuSpec, ...] = (
    GpuSpec("h200", ("h200",), "NVIDIA H200", 989.0, 4800.0, "training"),
    GpuSpec("h100", ("h100",), "NVIDIA H100", 756.0, 2039.0, "training"),
    GpuSpec("a100", ("a100",), "NVIDIA A100", 312.0, 1935.0, "training"),
    GpuSpec("a800", ("a800",), "NVIDIA A800", 312.0, 2000.0, "training"),
    GpuSpec("l40s", ("l40s",), "NVIDIA L40S", 362.0, 864.0, "universal"),
    GpuSpec("l40", ("l40 ", "l40-"), "NVIDIA L40", 181.0, 864.0, "universal"),
    GpuSpec("rtx6000ada", ("rtx 6000 ada", "rtx6000ada"), "RTX 6000 Ada", 362.0, 960.0, "universal"),
    GpuSpec("a6000", ("a6000", "rtx a6000"), "RTX A6000", 154.8, 768.0, "universal"),
    GpuSpec("4090", ("4090",), "GeForce RTX 4090", 165.2, 1008.0, "universal"),
    GpuSpec("4080", ("4080",), "GeForce RTX 4080", 97.5, 717.0, "universal"),
    GpuSpec("3090", ("3090",), "GeForce RTX 3090", 71.0, 936.0, "universal"),
    GpuSpec("v100", ("v100",), "Tesla V100", 125.0, 900.0, "universal"),
    GpuSpec("t4", ("t4",), "Tesla T4", 65.0, 320.0, "legacy"),
    GpuSpec("p100", ("p100",), "Tesla P100", 18.7, 732.0, "legacy"),
    GpuSpec("k80", ("k80",), "Tesla K80", 8.7, 480.0, "legacy"),
)

UNKNOWN_SPEC = GpuSpec("unknown", (), "未知型号", 0.0, 0.0, "unknown")

TIER_LABELS = {
    "training": "训练主力",
    "universal": "通用加速",
    "legacy": "老旧/仅推理",
    "unknown": "未识别",
}


def spec_for(name: str | None) -> GpuSpec:
    """Return the spec whose pattern appears in *name* (case-insensitive)."""
    haystack = (name or "").strip().lower()
    if not haystack:
        return UNKNOWN_SPEC
    for spec in GPU_SPECS:
        if any(pattern in haystack for pattern in spec.match):
            return spec
    return UNKNOWN_SPEC


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _gpu_rows(metrics: dict[str, Any]) -> list[dict[str, Any]]:
    rows = metrics.get("gpu_summary") or []
    return [row for row in rows if isinstance(row, dict)]


def build_compute_summary(
    snapshots: Iterable[dict[str, Any]],
    *,
    servers: Iterable[Any] = (),
) -> dict[str, Any]:
    """Aggregate GPU capacity and current load across the whole fleet.

    ``snapshots`` are the dicts returned by ``storage.get_all_host_snapshots``;
    ``servers`` (``HostConfig`` objects) are used only for address/group labels.
    """
    labels: dict[str, dict[str, str]] = {}
    for server in servers:
        labels[server.name] = {
            "address": server.host or "",
            "group": getattr(server, "group", None) or "未分组",
        }

    hosts: list[dict[str, Any]] = []
    models: dict[str, dict[str, Any]] = {}
    users: dict[str, dict[str, Any]] = {}

    for snapshot in snapshots:
        name = snapshot.get("host_name") or ""
        metrics = snapshot.get("metrics") or {}
        gpus = _gpu_rows(metrics)
        if not gpus:
            continue

        cards = 0
        vram_mb = 0.0
        used_mb = 0.0
        util: list[float] = []
        tflops = 0.0
        per_model: dict[str, dict[str, Any]] = {}

        for gpu in gpus:
            spec = spec_for(gpu.get("name"))
            total = _number(gpu.get("memory_total_mb")) or 0.0
            used = _number(gpu.get("memory_used_mb")) or 0.0
            percent = _number(gpu.get("utilization_percent"))

            cards += 1
            vram_mb += total
            used_mb += used
            tflops += spec.tflops
            if percent is not None:
                util.append(percent)

            bucket = per_model.setdefault(
                spec.key,
                {"label": spec.label, "tier": spec.tier, "cards": 0, "vram_mb": 0.0, "used_mb": 0.0},
            )
            bucket["cards"] += 1
            bucket["vram_mb"] += total
            bucket["used_mb"] += used

            fleet_bucket = models.setdefault(
                spec.key,
                {
                    "key": spec.key,
                    "label": spec.label,
                    "tier": spec.tier,
                    "tier_label": TIER_LABELS.get(spec.tier, spec.tier),
                    "cards": 0,
                    "vram_mb": 0.0,
                    "used_mb": 0.0,
                    "tflops": 0.0,
                    "bandwidth_gbs": 0.0,
                    "hosts": [],
                },
            )
            fleet_bucket["cards"] += 1
            fleet_bucket["vram_mb"] += total
            fleet_bucket["used_mb"] += used
            fleet_bucket["tflops"] += spec.tflops
            fleet_bucket["bandwidth_gbs"] += spec.bandwidth_gbs
            if name not in fleet_bucket["hosts"]:
                fleet_bucket["hosts"].append(name)

        for proc in metrics.get("gpu_processes") or []:
            if not isinstance(proc, dict):
                continue
            who = str(proc.get("username") or "").strip() or "unknown"
            mem = _number(proc.get("memory_used_mb")) or 0.0
            bucket = users.setdefault(
                who,
                {
                    "user": who,
                    "memory_mb": 0.0,
                    "processes": 0,
                    "cards": set(),
                    "hosts": [],
                    "command": "",
                    "peak_mb": 0.0,
                },
            )
            bucket["memory_mb"] += mem
            bucket["processes"] += 1
            bucket["cards"].add((name, proc.get("index")))
            if name not in bucket["hosts"]:
                bucket["hosts"].append(name)
            if mem > bucket["peak_mb"]:
                bucket["peak_mb"] = mem
                bucket["command"] = str(proc.get("command") or "")

        util_avg = round(sum(util) / len(util), 1) if util else 0.0
        vram_pct = round(used_mb / vram_mb * 100, 1) if vram_mb else 0.0
        info = labels.get(name, {})

        hosts.append(
            {
                "name": name,
                "address": info.get("address", ""),
                "group": info.get("group", "未分组"),
                "cards": cards,
                "vram_gb": round(vram_mb / GB, 1),
                "used_gb": round(used_mb / GB, 1),
                "vram_pct": vram_pct,
                "util_avg": util_avg,
                "tflops": round(tflops, 1),
                "collected_at": snapshot.get("collected_at") or "",
                "models": sorted(per_model.values(), key=lambda item: -item["cards"]),
                "idle": util_avg <= 5.0 and vram_pct < 10.0,
            }
        )

    hosts.sort(key=lambda item: (-item["tflops"], item["name"]))

    totals = {
        "cards": sum(item["cards"] for item in hosts),
        "vram_gb": round(sum(item["vram_gb"] for item in hosts), 1),
        "used_gb": round(sum(item["used_gb"] for item in hosts), 1),
        "tflops": round(sum(item["tflops"] for item in hosts), 1),
    }
    totals["free_gb"] = round(totals["vram_gb"] - totals["used_gb"], 1)
    totals["vram_pct"] = (
        round(totals["used_gb"] / totals["vram_gb"] * 100, 1) if totals["vram_gb"] else 0.0
    )
    totals["pf16"] = round(totals["tflops"] / 1000, 2)
    totals["bandwidth_gbs"] = sum(item["bandwidth_gbs"] for item in models.values())

    used_total = sum(item["memory_mb"] for item in users.values())
    user_rows = []
    for item in users.values():
        row = dict(item)
        row["cards"] = len(item["cards"])
        row["memory_gb"] = round(row.pop("memory_mb") / GB, 1)
        row["peak_gb"] = round(row.pop("peak_mb") / GB, 1)
        row["share"] = (
            round(item["memory_mb"] / used_total * 100, 1) if used_total else 0.0
        )
        user_rows.append(row)
    user_rows.sort(key=lambda item: (-item["memory_gb"], item["user"]))

    model_rows = []
    for item in models.values():
        item = dict(item)
        item["vram_gb"] = round(item.pop("vram_mb") / GB, 1)
        item["used_gb"] = round(item.pop("used_mb") / GB, 1)
        item["tflops"] = round(item["tflops"], 1)
        item["share"] = (
            round(item["vram_gb"] / totals["vram_gb"] * 100, 1) if totals["vram_gb"] else 0.0
        )
        model_rows.append(item)
    model_rows.sort(key=lambda item: (-item["tflops"], -item["cards"]))

    idle = [item for item in hosts if item["idle"]]
    return {
        "totals": totals,
        "models": model_rows,
        "hosts": hosts,
        "users": user_rows,
        "idle_hosts": idle,
        "notes": [
            "算力为厂商公布的 FP16/BF16 密集（非稀疏）理论峰值，实际利用率通常 35%–55%。",
            "显存与利用率取自最近一次轮询快照，不是实时读数。",
            "K80/P100/T4 等无 Tensor Core 或老架构卡不建议计入训练算力。",
        ],
    }
