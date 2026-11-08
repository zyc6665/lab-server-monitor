"""Tests for OpenSSH-config import defaults and lenient host import."""

from __future__ import annotations

from pathlib import Path

from servermanage.host_import import (
    apply_import_defaults,
    parse_ssh_config,
)
from servermanage.settings import SettingsService


def _write_key(home: Path, name: str = "id_ed25519") -> Path:
    ssh_dir = home / ".ssh"
    ssh_dir.mkdir(parents=True, exist_ok=True)
    path = ssh_dir / name
    path.write_text("-----BEGIN OPENSSH PRIVATE KEY-----\n", encoding="utf-8")
    return path


def test_parse_ssh_config_keeps_missing_credentials_candidate(tmp_path: Path):
    text = "Host alpha\n  HostName 1.2.3.4\n"
    result = parse_ssh_config(text, home=tmp_path)
    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.name == "alpha"
    assert candidate.host == "1.2.3.4"
    assert candidate.username == ""
    assert candidate.key_path is None
    assert candidate.auth_type == "key"
    assert candidate.port == 22
    assert candidate.port_explicit is False


def test_apply_import_defaults_uses_host_star_values(tmp_path: Path):
    key = _write_key(tmp_path)
    text = (
        "Host *\n"
        "  User common\n"
        "  Port 2200\n"
        "  IdentityFile ~/.ssh/id_ed25519\n"
        "Host alpha\n"
        "  HostName 1.2.3.4\n"
    )
    parsed = parse_ssh_config(text, home=tmp_path)
    result = apply_import_defaults(parsed, text, home=tmp_path)
    candidate = result.candidates[0]
    assert candidate.username == "common"
    assert candidate.port == 2200
    assert candidate.key_path == str(key)
    assert candidate.valid


def test_apply_import_defaults_uses_existing_default_key(tmp_path: Path):
    key = _write_key(tmp_path, "id_rsa")
    text = "Host beta\n  HostName 5.6.7.8\n"
    parsed = parse_ssh_config(text, home=tmp_path)
    result = apply_import_defaults(parsed, text, home=tmp_path, default_username="zhouyc")
    candidate = result.candidates[0]
    assert candidate.username == "zhouyc"
    assert candidate.key_path == str(key)


def test_apply_import_defaults_keeps_proxy_candidate_invalid(tmp_path: Path):
    text = "Host blocked\n  HostName 9.9.9.9\n  ProxyJump jump\n"
    parsed = parse_ssh_config(text, home=tmp_path)
    result = apply_import_defaults(parsed, text, home=tmp_path)
    candidate = result.candidates[0]
    assert candidate.valid is False
    assert candidate.error


def test_import_hosts_allows_missing_credentials_only_when_opted_in(tmp_path: Path):
    cfg = tmp_path / "config.yaml"
    cfg.write_text("servers: []\n", encoding="utf-8")
    service = SettingsService(config_path=cfg, db_path=tmp_path / "monitor.db")
    candidate = {
        "name": "alpha",
        "host": "1.2.3.4",
        "port": 22,
        "username": "zhouyc",
        "auth_type": "key",
        "key_path": None,
    }

    strict = service.import_hosts([candidate])
    assert strict["created"] == []
    assert strict["failed"][0]["name"] == "alpha"

    lenient = service.import_hosts([candidate], allow_missing_credentials=True)
    assert lenient["created"] == ["alpha"]
    host = service.get_host("alpha")
    assert host is not None
    assert host["key_path"] is None
    assert host["auth_type"] == "key"
