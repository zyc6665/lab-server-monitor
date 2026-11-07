from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.settings import SettingsService
from servermanage.storage import init_storage


def _mapping() -> dict:
    return {
        "servers": [],
        "smtp": {
            "host": "smtp.example.com",
            "port": 465,
            "username": "monitor@example.com",
            "password_env": "SMTP_PASSWORD",
            "from_addr": "monitor@example.com",
            "to_addrs": ["ops@example.com"],
        },
        "report": {
            "daily_enabled": True,
            "weekly": {"enabled": True},
        },
    }


def test_placeholder_smtp_disables_reports(tmp_path: Path) -> None:
    db = tmp_path / "m.db"
    init_storage(db)
    base = load_config_from_mapping(
        _mapping(), allow_empty_servers=True, allow_missing_secrets=True
    )
    service = SettingsService(
        config_path=tmp_path / "config.yaml", db_path=db, base_config=base
    )
    effective = service.load()
    assert effective.smtp is not None
    assert effective.report.daily_enabled is False
    assert effective.report.weekly.enabled is False


def test_real_smtp_keeps_reports(tmp_path: Path) -> None:
    db = tmp_path / "m.db"
    init_storage(db)
    mapping = _mapping()
    mapping["smtp"]["host"] = "mail.lab.example.org"
    base = load_config_from_mapping(
        mapping, allow_empty_servers=True, allow_missing_secrets=True
    )
    service = SettingsService(
        config_path=tmp_path / "config.yaml", db_path=db, base_config=base
    )
    effective = service.load()
    assert effective.smtp is not None
    assert effective.report.daily_enabled is True
