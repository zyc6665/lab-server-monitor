from __future__ import annotations

import argparse
import logging
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from dotenv import load_dotenv

from servermanage.collectors import collect_all_hosts
from servermanage.models import DailyReport
from servermanage.storage import persist_host_reports
from servermanage.weekly import generate_weekly_report

LOGGER = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run server daily or weekly monitor report.")
    parser.add_argument("--config", required=True, help="Path to config.yaml")
    parser.add_argument(
        "--dotenv",
        default=None,
        help="Optional dotenv path loaded before config parsing.",
    )
    parser.add_argument(
        "--weekly",
        action="store_true",
        default=False,
        help="Generate and send the weekly summary instead of the daily report.",
    )
    return parser


def configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )


def run_app(
    *,
    config_path: Path,
    dotenv_path: Path | None,
    load_config_func,
    render_report_func,
    send_report_func,
    collect_host_reports_func=collect_all_hosts,
    persist_func=persist_host_reports,
    generate_weekly_report_func=generate_weekly_report,
    weekly: bool = False,
) -> int:
    if dotenv_path is not None:
        if not dotenv_path.exists():
            LOGGER.error("Dotenv file does not exist: %s", dotenv_path)
            return 1
        load_dotenv(dotenv_path, override=True)

    try:
        config = load_config_func(config_path)
    except Exception as exc:  # pragma: no cover - integration path
        LOGGER.exception("Failed to load config: %s", exc)
        return 1

    if weekly:
        return _run_weekly(
            config=config,
            render_report_func=render_report_func,
            send_report_func=send_report_func,
            generate_weekly_report_func=generate_weekly_report_func,
        )

    return _run_daily(
        config=config,
        render_report_func=render_report_func,
        send_report_func=send_report_func,
        collect_host_reports_func=collect_host_reports_func,
        persist_func=persist_func,
    )


def _run_daily(
    *,
    config,
    render_report_func,
    send_report_func,
    collect_host_reports_func,
    persist_func,
) -> int:
    reports = collect_host_reports_func(config)
    technical_report = DailyReport(
        generated_at=datetime.now(timezone.utc),
        reports=reports,
        subject_prefix=config.report.subject_prefix,
    )

    if config.storage.enabled:
        persist_func(technical_report, config.storage.db_path)

    rendered_report = render_report_func(technical_report)

    try:
        send_report_func(config.smtp, rendered_report)
        if config.report.executive is not None and config.report.executive.enabled:
            executive_report = replace(
                technical_report,
                subject_prefix=config.report.executive.subject_prefix,
            )
            executive_rendered = render_report_func(executive_report, variant="executive")
            send_report_func(
                config.smtp,
                executive_rendered,
                to_addrs=config.report.executive.to_addrs,
            )
    except Exception as exc:  # pragma: no cover - integration path
        LOGGER.exception("Failed to send report: %s", exc)
        return 2

    LOGGER.info("Report sent for %s hosts", len(reports))
    return 0


def _run_weekly(
    *,
    config,
    render_report_func,
    send_report_func,
    generate_weekly_report_func,
) -> int:
    try:
        weekly_report = generate_weekly_report_func(
            config.storage.db_path,
            config=config.report.weekly,
        )
        rendered_report = render_report_func(weekly_report, variant="weekly")
        send_report_func(config.smtp, rendered_report)
    except Exception as exc:  # pragma: no cover - integration path
        LOGGER.exception("Failed to generate or send weekly report: %s", exc)
        return 2

    LOGGER.info("Weekly report sent for %s hosts", len(weekly_report.summaries))
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    configure_logging()
    parser = build_parser()
    args = parser.parse_args(argv)

    from servermanage.config import load_config
    from servermanage.mailer import send_report
    from servermanage.report import render_report

    return run_app(
        config_path=Path(args.config),
        dotenv_path=Path(args.dotenv) if args.dotenv else None,
        load_config_func=load_config,
        render_report_func=render_report,
        send_report_func=send_report,
        weekly=args.weekly,
    )


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
