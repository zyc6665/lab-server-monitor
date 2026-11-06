import sys
import types
import os
from pathlib import Path

from servermanage.main import main, run_app
from servermanage.models import (
    AppConfig,
    AuthConfig,
    ExecutiveReportConfig,
    HostConfig,
    HostReport,
    RenderedReport,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
)


def build_config(*, executive: ExecutiveReportConfig | None = None):
    return AppConfig(
        smtp=SMTPConfig(
            host="smtp.example.com",
            port=465,
            username="monitor@example.com",
            password="smtp-secret",
            use_ssl=True,
            from_addr="monitor@example.com",
            to_addrs=["ops@example.com"],
        ),
        ssh=SSHRuntimeConfig(connect_timeout=10, command_timeout=20),
        report=ReportConfig(subject_prefix="[Daily]", executive=executive),
        servers=[
            HostConfig(
                name="gpu-01",
                host="10.0.0.1",
                port=22,
                username="root",
                auth=AuthConfig(type="password", password="secret"),
            )
        ],
    )


def test_run_app_returns_zero_for_partial_host_failures(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    dotenv_path = tmp_path / ".env"
    config_path.write_text("placeholder", encoding="utf-8")
    dotenv_path.write_text("", encoding="utf-8")

    sent = {}

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=dotenv_path,
        load_config_func=lambda path: build_config() if path == config_path else None,
        collect_host_reports_func=lambda config: [
            HostReport(host_name="gpu-01", host="10.0.0.1", success=False)
        ],
        render_report_func=lambda report: RenderedReport(
            subject=report.subject_prefix,
            text_body="plain",
            html_body="<html></html>",
        ),
        send_report_func=lambda smtp, report, to_addrs=None: sent.setdefault(
            "payload", (smtp, report, to_addrs)
        ),
    )

    assert exit_code == 0
    assert sent["payload"][1].subject == "[Daily]"


def test_run_app_rejects_missing_explicit_dotenv(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("placeholder", encoding="utf-8")

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=tmp_path / "missing.env",
        load_config_func=lambda _path: build_config(),
        collect_host_reports_func=lambda _config: [],
        render_report_func=lambda _report: RenderedReport(
            subject="s",
            text_body="t",
            html_body="h",
        ),
        send_report_func=lambda _smtp, _report, to_addrs=None: None,
    )

    assert exit_code == 1


def test_run_app_explicit_dotenv_overrides_empty_environment_value(
    tmp_path: Path, monkeypatch
):
    config_path = tmp_path / "config.yaml"
    dotenv_path = tmp_path / ".env"
    config_path.write_text("placeholder", encoding="utf-8")
    dotenv_path.write_text('SMTP_PASSWORD="smtp-from-dotenv"\n', encoding="utf-8")
    monkeypatch.setenv("SMTP_PASSWORD", "")

    seen = {}

    def load_config(_path):
        seen["smtp_password"] = os.getenv("SMTP_PASSWORD")
        return build_config()

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=dotenv_path,
        load_config_func=load_config,
        collect_host_reports_func=lambda _config: [],
        render_report_func=lambda _report: RenderedReport(
            subject="s",
            text_body="t",
            html_body="h",
        ),
        send_report_func=lambda _smtp, _report, to_addrs=None: None,
    )

    assert exit_code == 0
    assert seen["smtp_password"] == "smtp-from-dotenv"


def test_run_app_returns_nonzero_for_invalid_config(tmp_path: Path):
    config_path = tmp_path / "config.yaml"

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=tmp_path / ".env",
        load_config_func=lambda _path: (_ for _ in ()).throw(ValueError("bad config")),
        collect_host_reports_func=lambda config: [],
        render_report_func=lambda report: RenderedReport(
            subject="s",
            text_body="t",
            html_body="h",
        ),
        send_report_func=lambda smtp, report: None,
    )

    assert exit_code == 1


def test_run_app_returns_nonzero_for_mail_failure(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    dotenv_path = tmp_path / ".env"
    config_path.write_text("placeholder", encoding="utf-8")
    dotenv_path.write_text("", encoding="utf-8")

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=dotenv_path,
        load_config_func=lambda _path: build_config(),
        collect_host_reports_func=lambda config: [],
        render_report_func=lambda report: RenderedReport(
            subject=report.subject_prefix,
            text_body="plain",
            html_body="<html></html>",
        ),
        send_report_func=lambda smtp, report, to_addrs=None: (_ for _ in ()).throw(
            RuntimeError("smtp failed")
        ),
    )

    assert exit_code == 2


def test_main_imports_parser_without_running(tmp_path: Path, monkeypatch):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("placeholder", encoding="utf-8")

    fake_config = types.ModuleType("servermanage.config")
    fake_config.load_config = lambda _path: build_config()
    fake_mailer = types.ModuleType("servermanage.mailer")
    fake_mailer.send_report = lambda _smtp, _report: None
    fake_report = types.ModuleType("servermanage.report")
    fake_report.render_report = lambda _report: RenderedReport(
        subject="[Daily]",
        text_body="plain",
        html_body="<html></html>",
    )
    monkeypatch.setitem(sys.modules, "servermanage.config", fake_config)
    monkeypatch.setitem(sys.modules, "servermanage.mailer", fake_mailer)
    monkeypatch.setitem(sys.modules, "servermanage.report", fake_report)
    monkeypatch.setattr(
        "servermanage.main.run_app",
        lambda **kwargs: 0,
    )

    assert main(["--config", str(config_path)]) == 0


def test_run_app_sends_technical_and_executive_reports(tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    dotenv_path = tmp_path / ".env"
    config_path.write_text("placeholder", encoding="utf-8")
    dotenv_path.write_text("", encoding="utf-8")

    sent: list[tuple[str, list[str] | None]] = []
    rendered_variants: list[str] = []
    config = build_config(
        executive=ExecutiveReportConfig(
            enabled=True,
            subject_prefix="[Leader]",
            to_addrs=["leader@example.com"],
        )
    )

    def render_report(report, variant="technical"):
        rendered_variants.append(variant)
        return RenderedReport(
            subject=f"{variant}:{report.subject_prefix}",
            text_body=variant,
            html_body=f"<html>{variant}</html>",
        )

    exit_code = run_app(
        config_path=config_path,
        dotenv_path=dotenv_path,
        load_config_func=lambda _path: config,
        collect_host_reports_func=lambda _config: [],
        render_report_func=render_report,
        send_report_func=lambda _smtp, report, to_addrs=None: sent.append((report.subject, to_addrs)),
    )

    assert exit_code == 0
    assert rendered_variants == ["technical", "executive"]
    assert sent == [
        ("technical:[Daily]", None),
        ("executive:[Leader]", ["leader@example.com"]),
    ]
