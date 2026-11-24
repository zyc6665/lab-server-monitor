from pathlib import Path
import subprocess

from servermanage.models import (
    AppConfig,
    DashboardAuthConfig,
    DashboardConfig,
    ReportConfig,
    SSHRuntimeConfig,
)
from servermanage.web import create_app


ROOT = Path(__file__).resolve().parents[1]


def test_frontend_core_modules():
    result = subprocess.run(
        [
            "node",
            "--experimental-default-type=module",
            "--test",
            str(ROOT / "tests" / "frontend" / "core-modules.test.mjs"),
            str(ROOT / "tests" / "frontend" / "overview-trends.test.mjs"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def _make_app(tmp_path):
    config = AppConfig(
        smtp=None,
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Test]"),
        servers=[],
        dashboard=DashboardConfig(auth=DashboardAuthConfig(enabled=False)),
    )
    return create_app(config=config, db_path=tmp_path / "frontend.db")


def test_static_files_revalidate_for_esm_dependencies(tmp_path):
    app = _make_app(tmp_path)
    assert app.config["SEND_FILE_MAX_AGE_DEFAULT"] == 0


def test_app_entry_loads_as_es_module(tmp_path):
    client = _make_app(tmp_path).test_client()
    response = client.get("/")
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert '<script type="module" src="/static/app.js?' in html
