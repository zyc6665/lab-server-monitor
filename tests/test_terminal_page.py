from __future__ import annotations

from pathlib import Path

from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    DashboardAuthConfig,
    DashboardConfig,
    HostConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.storage import init_storage
from servermanage.web import create_app


def _make_config() -> AppConfig:
    return AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[
            HostConfig(
                name="gpu-01",
                host="10.0.0.1",
                port=22,
                username="monitor",
                auth=AuthConfig(type="password", password="pw"),
            )
        ],
        app=AppRuntimeConfig(poll_interval_seconds=600),
        dashboard=DashboardConfig(
            auth=DashboardAuthConfig(
                enabled=True, username="admin", password_env=None, password="pw"
            ),
            session_secret="test-secret",
        ),
    )


def test_terminal_page_renders_hosts_and_xterm(tmp_path: Path) -> None:
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    app = create_app(config=_make_config(), db_path=db_path)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "admin"
    response = client.get("/terminal")
    assert response.status_code == 200
    body = response.get_data(as_text=True)
    assert "SSH 终端" in body
    assert 'value="gpu-01"' in body
    assert "vendor/xterm/xterm.js" in body
    assert "terminal.js" in body
    assert "terminal-tabs" in body


def test_terminal_assets_exist() -> None:
    root = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
    assert (root / "terminal.js").is_file()
    assert (root / "terminal.css").is_file()
    assert (root / "vendor" / "xterm" / "xterm.js").is_file()
    assert (root / "vendor" / "xterm" / "addon-fit.js").is_file()
