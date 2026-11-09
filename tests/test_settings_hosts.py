"""Task 4 tests: host metadata, import, copy, groups and alert silences."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from servermanage import security, storage
from servermanage.disk_health import AlertEvent
from servermanage.models import AuthConfig, HostCheckResult, HostConfig
from servermanage.serialization import dump_json, to_jsonable
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


def host_payload(name: str = "h", **overrides):
    """Host payload helper: explicit keys only, plus baseline identity fields."""
    payload = {
        "name": name,
        "host": "1.2.3.4",
        "port": 22,
        "username": "u",
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


def test_import_hosts_skips_existing_key_path_only_host(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "kp",
        {
            "host": "10.0.0.8",
            "port": 22,
            "username": "u",
            "auth_type": "key",
            "key_path": "~/.ssh/id_rsa",
        },
    )
    result = svc.import_hosts(
        [
            {
                "name": "kp",
                "host": "10.0.0.9",
                "port": 22,
                "username": "u",
                "auth_type": "key",
            }
        ]
    )
    assert result["skipped"] == ["kp"]
    assert result["failed"] == []
    assert svc.load().servers[0].host == "10.0.0.8"
    assert str(svc.load().servers[0].auth.key_path).endswith("id_rsa")


def test_import_hosts_captures_write_time_failure(tmp_path, monkeypatch):
    svc = _service(tmp_path)
    original = svc.upsert_host

    def flaky(name, payload, **kwargs):
        if name == "b":
            raise SettingsError("write boom")
        return original(name, payload, **kwargs)

    monkeypatch.setattr(svc, "upsert_host", flaky)
    result = svc.import_hosts(
        [
            {"name": "a", "host": "10.0.0.1", "port": 22, "username": "u",
             "auth_type": "password", "password": "pw"},
            {"name": "b", "host": "10.0.0.2", "port": 22, "username": "u",
             "auth_type": "password", "password": "pw"},
        ]
    )
    assert result["created"] == ["a"]
    assert [item["name"] for item in result["failed"]] == ["b"]
    assert result["failed"][0]["error"] == "write boom"
    assert [host.name for host in svc.load().servers] == ["a"]


def test_import_hosts_requires_auth_type(tmp_path):
    svc = _service(tmp_path)
    result = svc.import_hosts(
        [{"name": "noauth", "host": "10.0.0.1", "port": 22, "username": "u",
          "password": "pw"}]
    )
    assert result["created"] == []
    assert [item["name"] for item in result["failed"]] == ["noauth"]
    assert "auth_type" in result["failed"][0]["error"]
    assert svc.load().servers == []


def test_import_hosts_duplicate_batch_names_not_created_and_updated(tmp_path):
    svc = _service(tmp_path)
    candidate = {
        "name": "dup",
        "host": "10.0.0.1",
        "port": 22,
        "username": "u",
        "auth_type": "password",
        "password": "pw",
    }
    result = svc.import_hosts([candidate, dict(candidate, host="10.0.0.2")])
    assert result["created"] == ["dup"]
    assert result["updated"] == []
    assert result["skipped"] == ["dup"]
    assert [host.name for host in svc.load().servers] == ["dup"]


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


# ---------------------------------------------------------------------------
# Task 1: availability checks, alert rules and sudo password
# ---------------------------------------------------------------------------

_CHECKS = [
    {
        "name": "训练 API",
        "type": "http",
        "target": "http://127.0.0.1:8000/health",
        "timeout_seconds": 5,
        "expected": "200-299",
    },
    {"name": "SSH 端口", "type": "tcp", "target": "22"},
]


def test_upsert_host_persists_checks_and_preserves_them_when_editing_notes(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "gpu",
        host_payload(
            "gpu",
            auth_type="password",
            password="pw",
            checks=_CHECKS,
            alert_rules={"cpu_percent": 95, "consecutive_periods": 3},
        ),
    )
    host = svc.load().servers[0]
    assert [check.name for check in host.checks] == ["训练 API", "SSH 端口"]
    assert host.checks[0].type == "http"
    assert host.checks[0].expected == "200-299"
    assert host.alert_rules is not None
    assert host.alert_rules.cpu_percent == 95
    assert host.alert_rules.consecutive_periods == 3

    entry = svc.get_host("gpu")
    assert [check["name"] for check in entry["checks"]] == ["训练 API", "SSH 端口"]
    assert entry["alert_rules"]["cpu_percent"] == 95

    # Editing an unrelated field omits checks/alert_rules: they must survive.
    svc.upsert_host("gpu", host_payload("gpu", auth_type="password", notes="edited"))
    host = svc.load().servers[0]
    assert [check.name for check in host.checks] == ["训练 API", "SSH 端口"]
    assert host.alert_rules.cpu_percent == 95

    # Explicit values (including empty) overwrite what was stored.
    svc.upsert_host(
        "gpu", host_payload("gpu", auth_type="password", checks=[], alert_rules=None)
    )
    host = svc.load().servers[0]
    assert host.checks == []
    assert host.alert_rules is None


def test_sudo_password_is_write_only_and_clearable(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "gpu",
        host_payload(
            "gpu", auth_type="password", password="pw", sudo_password="sudo-secret"
        ),
    )
    assert svc.load().servers[0].sudo_password == "sudo-secret"
    entry = svc.get_host("gpu")
    assert entry["sudo_configured"] is True
    assert "sudo_password" not in entry
    # The raw persisted entry never carries the password or the computed flag.
    raw = svc._read_host_entries()[0]
    assert "sudo_password" not in raw
    assert "sudo_configured" not in raw
    assert storage.get_secret("host:gpu:sudo_password", svc.db_path) is not None

    with pytest.raises(SettingsError):
        svc.upsert_host(
            "gpu", host_payload("gpu", auth_type="password", sudo_password="a\nb")
        )
    with pytest.raises(SettingsError):
        svc.upsert_host(
            "gpu", host_payload("gpu", auth_type="password", sudo_password="x" * 257)
        )

    # Editing other fields leaves the write-only password untouched.
    svc.upsert_host("gpu", host_payload("gpu", auth_type="password", notes="n"))
    assert svc.load().servers[0].sudo_password == "sudo-secret"

    svc.upsert_host(
        "gpu", host_payload("gpu", auth_type="password", clear_secrets=["sudo_password"])
    )
    assert svc.load().servers[0].sudo_password is None
    assert svc.get_host("gpu")["sudo_configured"] is False
    assert storage.get_secret("host:gpu:sudo_password", svc.db_path) is None


def test_host_config_sudo_password_not_serialized():
    host = HostConfig(
        name="gpu",
        host="1.2.3.4",
        port=22,
        username="u",
        auth=AuthConfig(type="password", password="pw"),
        sudo_password="super-secret",
    )
    payload = to_jsonable(host)
    assert "sudo_password" not in payload
    assert "super-secret" not in dump_json(host)


@pytest.mark.parametrize(
    "payload",
    [
        {"checks": [{"name": "a", "type": "bogus", "target": "22"}]},
        {"checks": [{"name": "a", "type": "tcp", "target": ""}]},
        {"checks": [{"name": "a", "type": "tcp", "target": "22", "timeout_seconds": 0}]},
        {"checks": [{"name": "a", "type": "tcp", "target": "22", "expected": "bad"}]},
        {"checks": [{"name": "Same", "type": "tcp", "target": "22"},
                    {"name": "same", "type": "tcp", "target": "23"}]},
        {"checks": "not-a-list"},
        {"alert_rules": {"cpu_percent": 101}},
        {"alert_rules": {"disk_temperature_c": 121}},
        {"alert_rules": {"consecutive_periods": 0}},
    ],
)
def test_upsert_host_rejects_invalid_checks_and_alert_rules(tmp_path, payload):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.upsert_host(
            "bad",
            host_payload("bad", auth_type="password", password="pw", **payload),
        )
    assert svc.load().servers == []


def test_copy_host_copies_checks_alert_rules_and_sudo_secret(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "src",
        host_payload(
            "src",
            auth_type="password",
            password="pw",
            checks=_CHECKS,
            alert_rules={"cpu_percent": 90},
            sudo_password="sudo-src",
        ),
    )
    svc.copy_host("src", "dst")
    target = [h for h in svc.load().servers if h.name == "dst"][0]
    assert [check.name for check in target.checks] == ["训练 API", "SSH 端口"]
    assert target.alert_rules is not None
    assert target.alert_rules.cpu_percent == 90
    assert target.sudo_password == "sudo-src"
    assert storage.get_secret("host:dst:sudo_password", svc.db_path) is not None


def test_machine_reset_clears_sudo_secret_but_keeps_host(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host(
        "gpu",
        host_payload(
            "gpu", auth_type="password", password="pw", sudo_password="sudo-secret"
        ),
    )
    storage.save_app_settings("security", {"machine_id": "other-machine"}, svc.db_path)
    svc2 = SettingsService(config_path=svc.config_path, db_path=svc.db_path)
    assert svc2.setup_required() is True
    assert storage.get_secret("host:gpu:sudo_password", svc.db_path) is None
    # Non-sensitive host inventory survives the secret wipe.
    assert [host.name for host in svc2.load().servers] == ["gpu"]


def test_public_settings_includes_alerts_consecutive_periods(tmp_path):
    svc = _service(tmp_path)
    assert svc.public_settings()["alerts"]["consecutive_periods"] == 2
    svc.save_section("alerts", {"consecutive_periods": 4})
    assert svc.public_settings()["alerts"]["consecutive_periods"] == 4
    assert svc.load().alerts.consecutive_periods == 4


@pytest.mark.parametrize("bad_value", [0, 11, True, "4"])
def test_save_alerts_rejects_invalid_consecutive_periods(tmp_path, bad_value):
    svc = _service(tmp_path)
    with pytest.raises(SettingsError):
        svc.save_section("alerts", {"consecutive_periods": bad_value})
    assert svc.load().alerts.consecutive_periods == 2


def test_yaml_sudo_password_is_migrated_and_survives_restart(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "pw")
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        """servers:
  - name: "gpu"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    sudo_password: "yaml-sudo"
""",
        encoding="utf-8",
    )
    db = tmp_path / "monitor.db"
    svc = SettingsService(config_path=cfg, db_path=db)
    assert svc.load().servers[0].sudo_password == "yaml-sudo"
    assert storage.get_secret("host:gpu:sudo_password", db) is not None

    svc2 = SettingsService(config_path=cfg, db_path=db)
    assert svc2.load().servers[0].sudo_password == "yaml-sudo"
    assert svc2.get_host("gpu")["sudo_configured"] is True


def test_yaml_sudo_password_env_survives_restart_after_legacy_migration(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("GPU01_PASSWORD", "pw")
    cfg = tmp_path / "config.yaml"
    # First start with no hosts marks the legacy-secret migration complete.
    cfg.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "monitor.db"
    old = SettingsService(config_path=cfg, db_path=db)
    # Simulate a database created by a pre-sudo release: its host inventory and
    # old migration marker exist, but the new sudo migration marker does not.
    storage.save_app_settings(
        "hosts",
        {
            "hosts": [
                {
                    "name": "gpu",
                    "host": "10.0.0.1",
                    "port": 22,
                    "username": "u",
                    "auth_type": "password",
                    "key_path": None,
                    "disk_mounts": ["/"],
                    "tags": [],
                }
            ]
        },
        db,
    )
    security = storage.load_app_settings(db)["security"]
    security.pop("sudo_migrated_at", None)
    storage.save_app_settings("security", security, db)

    monkeypatch.setenv("GPU01_SUDO_PASSWORD", "env-sudo")
    cfg.write_text(
        """servers:
  - name: "gpu"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    sudo_password_env: "GPU01_SUDO_PASSWORD"
""",
        encoding="utf-8",
    )
    svc = SettingsService(config_path=cfg, db_path=db)
    assert svc.load().servers[0].sudo_password == "env-sudo"

    svc2 = SettingsService(config_path=cfg, db_path=db)
    assert svc2.load().servers[0].sudo_password == "env-sudo"


def test_read_only_public_hosts_reports_yaml_sudo_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("GPU01_PASSWORD", "pw")
    cfg = tmp_path / "config.yaml"
    cfg.write_text(
        """servers:
  - name: "gpu"
    host: "10.0.0.1"
    username: "u"
    auth: {type: "password", password_env: "GPU01_PASSWORD"}
    sudo_password: "yaml-sudo"
""",
        encoding="utf-8",
    )
    svc = SettingsService(config_path=cfg, db_path=tmp_path / "monitor.db")
    storage.delete_secret("host:gpu:sudo_password", svc.db_path)
    monkeypatch.setattr(svc, "is_writable", lambda: False)
    assert svc._public_hosts()[0]["sudo_configured"] is True


def test_old_host_entries_without_new_fields_still_load(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("legacy", _password_host("legacy"))
    entries = svc._read_host_entries()
    entries[0].pop("checks", None)
    entries[0].pop("alert_rules", None)
    svc._save_host_entries(entries)
    host = svc.load().servers[0]
    assert host.checks == []
    assert host.alert_rules is None
    assert host.sudo_password is None


def test_delete_host_removes_check_snapshot_rows(tmp_path):
    svc = _service(tmp_path)
    svc.upsert_host("gpu-01", _password_host("gpu-01"))
    storage.save_host_check_results(
        "gpu-01",
        [
            HostCheckResult(
                name="API",
                type="http",
                target="http://127.0.0.1:8000/health",
                status="ok",
                message="",
                latency_ms=4.2,
                checked_at=datetime(2026, 11, 9, 4, 0, tzinfo=timezone.utc),
            )
        ],
        svc.db_path,
    )
    assert storage.get_host_check_results("gpu-01", svc.db_path)

    svc.delete_host("gpu-01")

    assert storage.get_host_check_results("gpu-01", svc.db_path) == []
