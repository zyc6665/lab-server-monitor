from servermanage import disk_capacity

ROWS = [
    {"filesystem": "/dev/sda1", "mountpoint": "/", "size": "100G", "used": "95G", "available": "5G", "percent": "95%"},
    {"filesystem": "/dev/sdb1", "mountpoint": "/data", "size": "10T", "used": "2T", "available": "8T", "percent": "20%"},
    {"filesystem": "tmpfs", "mountpoint": "/run", "size": "1G", "used": "0", "available": "1G", "percent": "0%"},
]


def test_mount_statuses_only_configured_and_present():
    statuses = disk_capacity.mount_statuses(ROWS, ["/", "/data", "/scratch"])
    assert [s["mountpoint"] for s in statuses] == ["/", "/data", "/scratch"]
    assert statuses[0]["percent"] == 95
    assert statuses[2]["present"] is False


def test_max_percent_ignores_unconfigured_mounts():
    assert disk_capacity.max_percent(ROWS, ["/data"]) == 20.0


def test_default_mounts():
    assert disk_capacity.normalize_mounts(None) == ["/", "/data"]


def test_missing_mount_does_not_alert_but_root_does():
    from servermanage.alerts import evaluate_system_alerts
    from servermanage.models import AlertThresholds, HostMetrics
    metrics = HostMetrics(hostname="h", collected_at=None)
    events = evaluate_system_alerts(
        "h", metrics, AlertThresholds(disk_percent=90),
        disk_mounts=[{"mountpoint": "/", "present": True, "percent": 95},
                     {"mountpoint": "/data", "present": False, "percent": None}],
    )
    assert [e.fingerprint for e in events] == ["system:h:disk:/"]
