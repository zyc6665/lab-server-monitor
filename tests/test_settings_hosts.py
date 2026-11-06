"""Task 4 tests: host metadata, import, copy, groups and alert silences."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from servermanage import security, storage
from servermanage.disk_health import AlertEvent
from servermanage.settings import SettingsError, SettingsService


def _service(tmp_path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\nreport:\n  subject_prefix: '[D]'\n", encoding="utf-8")
    return SettingsService(config_path=cfg, db_path=tmp_path / "monitor.db")


def _password_host(name: str, **overrides):
    payload = {
        "host": "1.2.3.4",
        "port": 22,
        "username": "u",
        "auth_type": "password",
        "password": "pw-" + name,
    }
    payload.update(overrides)
    return payload


def _insert_alert(db_path, host_name: str, *, status: str = "active") -> int:
    alert_id = storage.insert_alert(
        AlertEvent(
            host_name=host_name,
            category="cpu",
            severity="warning",
            title=f"{host_name} cpu",
            message="high",
            fingerprint=f"{host_name}:cpu",
        ),
        db_path,
    )
    if status != "active":
        storage.update_alert(alert_id, db_path, status=status)
    return alert_id


# ---------------------------------------------------------------------------
# Host metadata
# ---------------------------------------------------------------------------


def test_upsert_host_metadata_roundtrip(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.upsert_host(
        "meta",
        _password_host(
            "meta",
            group="GPU 集群",
            owner="张三",
            location="机房 A",
            notes="训练节点",
        ),
    )
    host = cfg.servers[0]
    assert host.group == "GPU 集群"
    assert host.owner == "张三"
    assert host.location == "机房 A"
    assert host.notes == "训练节点"

    entry = svc.get_host("meta")
    assert entry["group"] == "GPU 集群"
    assert entry["owner"] == "张三"
    assert entry["location"] == "机房 A"
    assert entry["notes"] == "训练节点"


def test_upsert_host_defaults_group_when_missing(tmp_path):
    svc = _service(tmp_path)
    cfg = svc.upsert_host("plain", _password_host("plain"))
    assert cfg.servers[0].group == "未分组"
    assert cfg.servers[0].owner == ""
    assert cfg.servers[0].location == ""
    assert cfg.servers[0].notes == ""
    assert svc.get_host("plain")["group"] == "未分组"

    svc.upsert_host("blank", _password_host("blank", group="   "), )
    assert svc.get_host("blank")["group"] == "未分组"


def test_host_groups_distinct_sorted_and_includes_default(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("a", _password_host("a", group="B 区"))
    svc.upsert_host("b", _password_host("b", group="A 区"))
    svc.upsert_host("c", _password_host("c", group="A 区"))
    svc.upsert_host("d", _password_host("d"))
    groups = svc.host_groups()
    assert groups == sorted(set(groups))
    assert "A 区" in groups and "B 区" in groups and "未分组" in groups
    assert groups.count("A 区") == 1


def test_host_groups_with_no_hosts_still_returns_default(tmp_path):
    svc = _service(tmp_path)
    assert svc.host_groups() == ["未分组"]


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------


def test_import_hosts_creates_and_reports(tmp_path):
    svc = _service(tmp_path)
    result = svc.import_hosts(
        [
            {
                "name": "a",
                "host": "10.0.0.1",
                "port": 22,
                "username": "u",
                "auth_type": "password",
                "password": "pw-a",
                "group": "G1",
            },
            {
                "name": "b",
                "host": "10.0.0.2",
                "port": "2222",
                "username": "u",
                "auth_type": "key",
                "key_path": "~/id_rsa",
                "owner": "李四",
            },
        ]
    )
    assert set(result) == {"created", "updated", "skipped", "failed"}
    assert result["created"] == ["a", "b"]
    assert result["updated"] == []
    assert result["skipped"] == []
    assert result["failed"] == []
    names = [h.name for h in svc.load().servers]
    assert names == ["a", "b"]
    assert svc.get_host("a")["group"] == "G1"
    assert svc.get_host("b")["port"] == 2222
    assert svc.get_host("b")["owner"] == "李四"


def test_import_hosts_skips_existing_without_overwrite(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("a", _password_host("a", host="1.1.1.1"))
    result = svc.import_hosts(
        [
            {
                "name": "a",
                "host": "2.2.2.2",
                "port": 22,
                "username": "u",
                "auth_type": "password",
                "password": "new",
            }
        ]
    )
    assert result["skipped"] == ["a"]
    assert result["created"] == [] and result["updated"] == []
    assert svc.load().servers[0].host == "1.1.1.1"


def test_import_hosts_overwrites_existing_when_requested(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("a", _password_host("a", host="1.1.1.1"))
    result = svc.import_hosts(
        [
            {
                "name": "a",
                "host": "2.2.2.2",
                "port": 22,
                "username": "u",
                "auth_type": "password",
                "password": "new",
            }
        ],
        overwrite=True,
    )
    assert result["updated"] == ["a"]
    assert svc.load().servers[0].host == "2.2.2.2"
    assert svc.load().servers[0].auth.password == "new"


def test_import_hosts_invalid_candidate_is_reported_not_written(tmp_path):
    svc = _service(tmp_path)
    result = svc.import_hosts(
        [
            {
                "name": "good",
                "host": "10.0.0.1",
                "port": 22,
                "username": "u",
                "auth_type": "password",
                "password": "pw",
            },
            {"name": "nohost", "host": "", "port": 22, "username": "u",
             "auth_type": "password", "password": "pw"},
            {"name": "badport", "host": "10.0.0.3", "port": "abc", "username": "u",
             "auth_type": "password", "password": "pw"},
            {"name": "badauth", "host": "10.0.0.4", "port": 22, "username": "u",
             "auth_type": "telnet"},
        ]
    )
    assert result["created"] == ["good"]
    failed_names = {item["name"] for item in result["failed"]}
    assert failed_names == {"nohost", "badport", "badauth"}
    assert all(item["error"] for item in result["failed"])
    names = [h.name for h in svc.load().servers]
    assert names == ["good"]


def test_import_hosts_zero_writes_when_all_invalid(tmp_path):
    svc = _service(tmp_path)
    result = svc.import_hosts([{"name": "", "host": "", "auth_type": "nope"}])
    assert result == {"created": [], "updated": [], "skipped": [], "failed": result["failed"]}
    assert len(result["failed"]) == 1
    assert svc.load().servers == []


# ---------------------------------------------------------------------------
# Copy
# ---------------------------------------------------------------------------


def test_copy_host_copies_connection_metadata_and_secret(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "src",
        _password_host(
            "src",
            host="10.0.0.9",
            port=2200,
            group="G",
            owner="o",
            location="loc",
            notes="n",
            tags=["gpu", "a100"],
            disk_mounts=["/", "/data", "/scratch"],
            disk_health={"enabled": True, "storcli_path": "/opt/storcli", "use_sudo": False},
        ),
    )
    cfg = svc.copy_host("src", "dst")
    names = [h.name for h in cfg.servers]
    assert names == ["src", "dst"]
    source = cfg.servers[0]
    target = cfg.servers[1]
    assert target.host == source.host == "10.0.0.9"
    assert target.port == 2200
    assert target.username == "u"
    assert target.auth.type == "password"
    assert target.auth.password == "pw-src"
    assert target.group == "G"
    assert target.owner == "o"
    assert target.location == "loc"
    assert target.notes == "n"
    assert target.tags == ["gpu", "a100"]
    assert target.disk_mounts == ["/", "/data", "/scratch"]
    assert target.disk_health is not None
    assert target.disk_health.enabled is True
    assert target.disk_health.storcli_path == "/opt/storcli"
    assert target.disk_health.use_sudo is False
    # New prefix owns an encrypted copy; the source secret is untouched.
    assert storage.get_secret("host:dst:ssh_password", svc.db_path) is not None
    assert storage.get_secret("host:src:ssh_password", svc.db_path) is not None


def test_copy_host_copies_key_and_passphrase_secrets(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "keyed",
        {
            "host": "10.0.0.5",
            "port": 22,
            "username": "u",
            "auth_type": "key",
            "private_key": "KEYDATA",
            "passphrase": "pp",
        },
    )
    svc.copy_host("keyed", "keyed-copy")
    assert storage.get_secret("host:keyed-copy:ssh_key", svc.db_path) is not None
    assert storage.get_secret("host:keyed-copy:ssh_passphrase", svc.db_path) is not None
    target = [h for h in svc.load().servers if h.name == "keyed-copy"][0]
    assert target.auth.key_data == "KEYDATA"
    assert target.auth.passphrase == "pp"


def test_copy_host_rejects_missing_source_and_existing_target(tmp_path):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.copy_host("missing", "new")
    svc.upsert_host("src", _password_host("src"))
    with pytest.raises(SettingsError):
        svc.copy_host("src", "src")
    with pytest.raises(SettingsError):
        svc.copy_host("src", "   ")


# ---------------------------------------------------------------------------
# Silences
# ---------------------------------------------------------------------------


def _window(hours: int = 1):
    start = datetime.now(timezone.utc) + timedelta(minutes=1)
    return start, start + timedelta(hours=hours)


def test_add_list_delete_silence_roundtrip(tmp_path):
    svc = _service(tmp_path)
    start, end = _window()
    silence_id = svc.add_silence("host", "h1", "维护", start, end, created_by="admin")
    rows = svc.list_silences(active_only=False)
    assert [row["id"] for row in rows] == [silence_id]
    assert rows[0]["scope_type"] == "host"
    assert rows[0]["scope"] == "h1"
    assert rows[0]["reason"] == "维护"
    assert rows[0]["created_by"] == "admin"
    # The window starts in the future, so it is not active yet.
    assert svc.list_silences(active_only=True) == []
    assert svc.delete_silence(silence_id) is True
    assert svc.list_silences(active_only=False) == []
    assert svc.delete_silence(silence_id) is False


def test_add_silence_allows_iso_strings_and_active_window(tmp_path):
    svc = _service(tmp_path)
    now = datetime.now(timezone.utc)
    silence_id = svc.add_silence(
        "all",
        None,
        "全局维护",
        (now - timedelta(minutes=1)).isoformat(),
        (now + timedelta(hours=1)).isoformat(),
    )
    active = svc.list_silences(active_only=True)
    assert [row["id"] for row in active] == [silence_id]
    assert active[0]["scope"] is None


@pytest.mark.parametrize(
    "scope_type,scope",
    [
        ("bogus", "x"),
        ("host", ""),
        ("host", None),
        ("group", "  "),
        ("all", "h1"),
    ],
)
def test_add_silence_rejects_bad_scope(tmp_path, scope_type, scope):
    svc = _service(tmp_path)
    start, end = _window()
    with pytest.raises(SettingsError):
        svc.add_silence(scope_type, scope, "r", start, end)


def test_add_silence_rejects_bad_window(tmp_path):
    svc = _service(tmp_path)
    start, _ = _window()
    with pytest.raises(SettingsError):
        svc.add_silence("host", "h1", "r", start, start)
    with pytest.raises(SettingsError):
        svc.add_silence(
            "host", "h1", "r", start, start + timedelta(days=30, seconds=1)
        )
    # Exactly 30 days is allowed.
    svc.add_silence("host", "h1", "r", start, start + timedelta(days=30))


def test_add_silence_resolves_open_alerts_in_scope_only(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h1", _password_host("h1", group="G1"))
    svc.upsert_host("h2", _password_host("h2", group="G1"))
    svc.upsert_host("h3", _password_host("h3", group="G2"))
    h1_active = _insert_alert(svc.db_path, "h1", status="active")
    h2_ack = _insert_alert(svc.db_path, "h2", status="acknowledged")
    h3_active = _insert_alert(svc.db_path, "h3", status="active")

    start, end = _window()
    svc.add_silence("group", "G1", "maintenance", start, end)

    statuses = {row["id"]: row["status"] for row in storage.list_alerts(svc.db_path)}
    assert statuses[h1_active] == "resolved"
    assert statuses[h2_ack] == "resolved"
    assert statuses[h3_active] == "active"


def test_add_host_silence_resolves_only_that_host(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h1", _password_host("h1"))
    svc.upsert_host("h2", _password_host("h2"))
    a = _insert_alert(svc.db_path, "h1")
    b = _insert_alert(svc.db_path, "h2")
    start, end = _window()
    svc.add_silence("host", "h1", "r", start, end)
    statuses = {row["id"]: row["status"] for row in storage.list_alerts(svc.db_path)}
    assert statuses[a] == "resolved"
    assert statuses[b] == "active"


def test_add_all_silence_resolves_every_open_alert(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("h1", _password_host("h1"))
    svc.upsert_host("h2", _password_host("h2"))
    a = _insert_alert(svc.db_path, "h1")
    b = _insert_alert(svc.db_path, "h2", status="acknowledged")
    start, end = _window()
    svc.add_silence("all", None, "r", start, end)
    statuses = {row["id"]: row["status"] for row in storage.list_alerts(svc.db_path)}
    assert statuses[a] == "resolved"
    assert statuses[b] == "resolved"
