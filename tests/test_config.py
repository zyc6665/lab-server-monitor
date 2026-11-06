from pathlib import Path

import pytest

from servermanage.config import ConfigError, load_config


def test_load_config_with_password_auth(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    config = load_config(config_file)

    assert config.smtp.host == "smtp.example.com"
    assert config.servers[0].auth.type == "password"
    assert config.servers[0].auth.password == "ssh-secret"


def test_load_config_rejects_missing_key_path(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "key"
      key_path: "/no/such/key"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")

    with pytest.raises(ConfigError, match="SSH key path does not exist"):
        load_config(config_file)


def test_load_config_rejects_missing_required_smtp_field(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    with pytest.raises(ConfigError, match="smtp.host is required"):
        load_config(config_file)


def test_load_config_with_executive_report(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
  executive:
    enabled: true
    subject_prefix: "[Leader Summary]"
    to_addrs: ["leader@example.com"]
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    config = load_config(config_file)

    assert config.report.executive is not None
    assert config.report.executive.enabled is True
    assert config.report.executive.subject_prefix == "[Leader Summary]"
    assert config.report.executive.to_addrs == ["leader@example.com"]


def test_load_config_rejects_enabled_executive_without_recipients(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
  executive:
    enabled: true
    subject_prefix: "[Leader Summary]"
    to_addrs: []
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    with pytest.raises(ConfigError, match="report.executive.to_addrs must not be empty"):
        load_config(config_file)


def test_load_config_with_key_passphrase_env(tmp_path: Path, monkeypatch):
    key_file = tmp_path / "id_rsa"
    key_file.write_text("dummy-key", encoding="utf-8")
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        f"""
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "key"
      key_path: "{key_file.as_posix()}"
      passphrase_env: "GPU01_KEY_PASSPHRASE"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_KEY_PASSPHRASE", "key-passphrase")

    config = load_config(config_file)

    assert config.servers[0].auth.type == "key"
    assert config.servers[0].auth.passphrase_env == "GPU01_KEY_PASSPHRASE"
    assert config.servers[0].auth.passphrase == "key-passphrase"


def test_load_config_with_storage_and_weekly_defaults(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    config = load_config(config_file)

    assert config.storage.enabled is True
    assert config.storage.db_path == Path("data/servermanage.db")
    assert config.report.weekly.enabled is True
    assert config.report.weekly.subject_prefix == "[Server Weekly Report]"
    assert config.report.weekly.busy_threshold == 70.0
    assert config.report.weekly.idle_threshold == 20.0


def test_load_config_with_storage_and_weekly_explicit_values(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
storage:
  enabled: false
  db_path: "/tmp/servermanage.db"
report:
  subject_prefix: "[Server Daily Report]"
  weekly:
    enabled: true
    subject_prefix: "[Weekly Summary]"
    busy_threshold: 80.0
    idle_threshold: 10.0
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    config = load_config(config_file)

    assert config.storage.enabled is False
    assert config.storage.db_path == Path("/tmp/servermanage.db")
    assert config.report.weekly.subject_prefix == "[Weekly Summary]"
    assert config.report.weekly.busy_threshold == 80.0
    assert config.report.weekly.idle_threshold == 10.0


def test_load_config_rejects_missing_key_passphrase_env(tmp_path: Path, monkeypatch):
    key_file = tmp_path / "id_rsa"
    key_file.write_text("dummy-key", encoding="utf-8")
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        f"""
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "key"
      key_path: "{key_file.as_posix()}"
      passphrase_env: "GPU01_KEY_PASSPHRASE"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.delenv("GPU01_KEY_PASSPHRASE", raising=False)

    with pytest.raises(ConfigError, match="Missing required environment variable: GPU01_KEY_PASSPHRASE"):
        load_config(config_file)
