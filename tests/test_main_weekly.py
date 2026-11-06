from datetime import date, datetime, timezone
from pathlib import Path

from servermanage.main import main, run_app
from servermanage.models import (
    AppConfig,
    AuthConfig,
    HostConfig,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
    StorageConfig,
    WeeklyHostSummary,
    WeeklyReport,
    WeeklyReportConfig,
)


def _make_config(tmp_path: Path) -> AppConfig:
    return AppConfig(
        smtp=SMTPConfig(
            host="smtp.example.com",
            port=465,
            username="user",
            password="secret",
            use_ssl=True,
            from_addr="from@example.com",
            to_addrs=["to@example.com"],
        ),
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(
            subject_prefix="[Server Daily Report]",
            include_failed_hosts=True,
            weekly=WeeklyReportConfig(subject_prefix="[Server Weekly Report]"),
        ),
        servers=[
            HostConfig(
                name="test",
                host="10.0.0.1",
                port=22,
                username="root",
                auth=AuthConfig(type="password", password="secret"),
            )
        ],
        storage=StorageConfig(enabled=True, db_path=tmp_path / "servermanage.db"),
    )


def test_main_parses_weekly_flag(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        "smtp:\n"
        "  host: smtp.example.com\n"
        "  port: 465\n"
        "  username: user\n"
        "  password_env: SMTP_PASSWORD\n"
        "  use_ssl: true\n"
        "  from_addr: from@example.com\n"
        "  to_addrs:\n"
        "    - to@example.com\n"
        "ssh:\n"
        "  connect_timeout: 10\n"
        "  command_timeout: 20\n"
        "report:\n"
        "  subject_prefix: '[Server Daily Report]'\n"
        "servers:\n"
        "  - name: test\n"
        "    host: 10.0.0.1\n"
        "    username: root\n"
        "    auth:\n"
        "      type: password\n"
        "      password_env: SSH_PASSWORD\n"
    )

    calls = []

    def fake_load_config(path):
        return _make_config(tmp_path)

    def fake_generate_weekly(db_path, *, config=None):
        calls.append(("generate", db_path))
        return WeeklyReport(
            generated_at=datetime.now(timezone.utc),
            week_start=date(2026, 7, 6),
            week_end=date(2026, 7, 12),
            summaries=[],
            busy_hosts=[],
            idle_hosts=[],
            subject_prefix="[Server Weekly Report]",
        )

    def fake_render(report, variant="technical"):
        calls.append(("render", variant))
        from servermanage.models import RenderedReport
        return RenderedReport(subject="weekly", text_body="text", html_body="html")

    def fake_send(smtp, report, to_addrs=None):
        calls.append(("send", report.subject))

    result = run_app(
        config_path=config_path,
        dotenv_path=None,
        load_config_func=fake_load_config,
        render_report_func=fake_render,
        send_report_func=fake_send,
        generate_weekly_report_func=fake_generate_weekly,
        weekly=True,
    )

    assert result == 0
    assert ("generate", tmp_path / "servermanage.db") in calls
    assert ("render", "weekly") in calls
    assert ("send", "weekly") in calls


def test_run_app_daily_persists_when_storage_enabled(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config = _make_config(tmp_path)

    def fake_load_config(path):
        return config

    persisted = []

    def fake_persist(report, db_path):
        persisted.append(db_path)

    def fake_collect(config):
        return []

    def fake_render(report, variant="technical"):
        from servermanage.models import RenderedReport
        return RenderedReport(subject="daily", text_body="text", html_body="html")

    def fake_send(smtp, report, to_addrs=None):
        pass

    result = run_app(
        config_path=config_path,
        dotenv_path=None,
        load_config_func=fake_load_config,
        render_report_func=fake_render,
        send_report_func=fake_send,
        collect_host_reports_func=fake_collect,
        persist_func=fake_persist,
    )

    assert result == 0
    assert persisted == [tmp_path / "servermanage.db"]
