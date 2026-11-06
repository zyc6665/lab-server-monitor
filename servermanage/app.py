"""Service entrypoint and orchestration for the server polling monitor.

This module ties the collectors, storage, alert engine, report mailer and the
scheduler together into a long-running service.  It is intentionally split into
small, independently schedulable jobs (``run_status_once``, ``run_disk_once``,
``run_daily_report``, ``run_weekly_report``, ``run_purge``) so the scheduler can
run them on their own cadence and tests can drive each one in isolation.
"""

from __future__ import annotations

import argparse
import logging
from dataclasses import replace
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Sequence

from dotenv import load_dotenv

from servermanage.alerts import (
    AlertEngine,
    Notifier,
    evaluate_disk_alerts,
    evaluate_system_alerts,
    offline_alert,
)
from servermanage.collectors import collect_all_hosts
from servermanage.config import load_config
from servermanage.disk_health import collect_disk_health
from servermanage.mailer import send_report as _send_report
from servermanage.models import AppConfig, DailyReport
from servermanage.report import render_report as _render_report
from servermanage.scheduler import (
    ScheduledTask,
    Scheduler,
    compute_daily_fire,
    compute_weekly_fire,
)
from servermanage.ssh_client import SSHClientWrapper
from servermanage.storage import (
    init_storage,
    persist_host_reports,
    purge_old_data,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.timeutil import resolve_timezone
from servermanage.weekly import generate_weekly_report as _generate_weekly_report

LOGGER = logging.getLogger(__name__)

_LOGGING_CONFIGURED = False


# ---------------------------------------------------------------------------
# Process bootstrap helpers
# ---------------------------------------------------------------------------


def configure_logging(log_dir: Path = Path("logs")) -> None:
    """Configure console + rotating-file logging under *log_dir*.

    Idempotent: a second call (for example from an embedded test) does not
    attach duplicate handlers.
    """
    global _LOGGING_CONFIGURED
    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    if _LOGGING_CONFIGURED:
        return

    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    file_handler = RotatingFileHandler(
        log_dir / "servermonitor.log",
        maxBytes=5 * 1024 * 1024,
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setFormatter(formatter)

    stream_handler = logging.StreamHandler()
    stream_handler.setFormatter(formatter)

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file_handler)
    root.addHandler(stream_handler)
    _LOGGING_CONFIGURED = True


def load_runtime(
    config_path: Path, dotenv_path: Path | None = None
) -> tuple[AppConfig, Path]:
    """Load dotenv → config → return ``(config, db_path)`` after init_storage."""
    if dotenv_path is not None:
        dotenv_path = Path(dotenv_path)
        if not dotenv_path.exists():
            raise FileNotFoundError(f"Dotenv file does not exist: {dotenv_path}")
        load_dotenv(dotenv_path, override=True)

    config = load_config(Path(config_path))
    db_path = Path(config.storage.db_path)
    init_storage(db_path)
    return config, db_path


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class MonitorService:
    """Owns the polling/report jobs and the scheduler that drives them."""

    def __init__(
        self,
        config: AppConfig,
        *,
        db_path: Path,
        collect_status: Callable[[AppConfig], list] = collect_all_hosts,
        collect_disk: Callable[..., object] = collect_disk_health,
        notifier: object | None = None,
        clock: Callable[[], datetime] | None = None,
        render_report: Callable[..., object] | None = None,
        send_report: Callable[..., object] | None = None,
        generate_weekly_report: Callable[..., object] | None = None,
        scheduler_factory: Callable[..., object] | None = None,
    ) -> None:
        self.config = config
        self.db_path = Path(db_path)
        self.collect_status = collect_status
        self.collect_disk = collect_disk
        self.render_report = render_report or _render_report
        self.send_report = send_report or _send_report
        self.generate_weekly_report = generate_weekly_report or _generate_weekly_report
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._notifier = notifier if notifier is not None else Notifier(smtp=config.smtp)
        self.engine = AlertEngine(
            self.db_path, config.alerts, self._notifier, clock=self._clock
        )
        self._scheduler_factory = scheduler_factory or Scheduler
        self._scheduler = None
        self._tz = resolve_timezone(config.app.timezone)
        # Consecutive failed status collections per host (for the offline message).
        self._failure_counts: dict[str, int] = {}

    # -- polling jobs ------------------------------------------------------

    def run_once(self) -> dict:
        """Run one status cycle immediately followed by one disk cycle."""
        status_result = self.run_status_once()
        disk_result = self.run_disk_once()
        return {
            "hosts": status_result["hosts"],
            "disk_reports": disk_result["disk_reports"],
            "alerts": status_result["alerts"] + disk_result["alerts"],
        }

    def run_status_once(self) -> dict:
        """Poll every host's system metrics and reconcile system/offline alerts."""
        reports = list(self.collect_status(self.config))
        storage_enabled = bool(getattr(self.config.storage, "enabled", True))
        events: list = []
        # Every configured host must be reconciled each cycle, even if this
        # round produced no report for it.
        active: dict[str, set[str]] = {
            host.name: set() for host in self.config.servers
        }
        success_reports = []

        for report in reports:
            host_name = report.host_name
            active.setdefault(host_name, set())
            if report.success:
                self._failure_counts[host_name] = 0
                if storage_enabled:
                    save_host_snapshot(report, self.db_path)
                success_reports.append(report)
                # A recovered host should clear any stale offline alert.
                self.engine.resolve(host_name, "offline")
                for event in evaluate_system_alerts(
                    host_name, report.metrics, self.config.alerts.thresholds
                ):
                    events.append(event)
                    active[host_name].add(event.fingerprint)
            else:
                failures = self._failure_counts.get(host_name, 0) + 1
                self._failure_counts[host_name] = failures
                event = offline_alert(host_name, failures)
                events.append(event)
                active[host_name].add(event.fingerprint)

        if storage_enabled and success_reports:
            persist_host_reports(
                DailyReport(
                    generated_at=datetime.now(timezone.utc),
                    reports=success_reports,
                    subject_prefix=self.config.report.subject_prefix,
                ),
                self.db_path,
            )

        notified = self.engine.process(events)

        for host_name, fingerprints in active.items():
            self.engine.resolve_missing(
                host_name, fingerprints, category="system"
            )

        return {"hosts": len(reports), "alerts": len(notified)}

    def run_disk_once(self) -> dict:
        """Poll disk health on every host and reconcile disk alerts."""
        storage_enabled = bool(getattr(self.config.storage, "enabled", True))
        events: list = []
        active: dict[str, set[str]] = {
            host.name: set() for host in self.config.servers
        }
        disk_reports = []

        for host in self.config.servers:
            runner = SSHClientWrapper(
                host=host, connect_timeout=self.config.ssh.connect_timeout
            )
            try:
                report = self.collect_disk(
                    host,
                    runner,
                    config=self.config.disk_health,
                    command_timeout=self.config.ssh.command_timeout,
                    override=host.disk_health,
                )
            except Exception:  # pragma: no cover - network path
                LOGGER.exception("Disk health collection failed for %s", host.name)
                continue
            finally:
                runner.close()

            disk_reports.append(report)
            if storage_enabled:
                save_disk_health(report, self.db_path)
            active.setdefault(host.name, set())
            for event in evaluate_disk_alerts(report):
                events.append(event)
                active[host.name].add(event.fingerprint)

        notified = self.engine.process(events)

        for host_name, fingerprints in active.items():
            self.engine.resolve_missing(host_name, fingerprints, category="disk")

        return {"disk_reports": len(disk_reports), "alerts": len(notified)}

    # -- report jobs -------------------------------------------------------

    def run_daily_report(self) -> None:
        """Collect a fresh snapshot and email the daily report."""
        reports = list(self.collect_status(self.config))
        report = DailyReport(
            generated_at=datetime.now(timezone.utc),
            reports=reports,
            subject_prefix=self.config.report.subject_prefix,
        )
        if bool(getattr(self.config.storage, "enabled", True)):
            persist_host_reports(report, self.db_path)

        if self.config.smtp is None:
            LOGGER.warning("SMTP is not configured; skipping daily report send")
            return

        rendered = self.render_report(report)
        self.send_report(self.config.smtp, rendered)

        executive = self.config.report.executive
        if executive is not None and executive.enabled:
            executive_report = replace(
                report, subject_prefix=executive.subject_prefix
            )
            executive_rendered = self.render_report(
                executive_report, variant="executive"
            )
            self.send_report(
                self.config.smtp,
                executive_rendered,
                to_addrs=executive.to_addrs,
            )

    def run_weekly_report(self) -> None:
        """Generate and email the weekly summary."""
        weekly_report = self.generate_weekly_report(
            self.db_path,
            config=self.config.report.weekly,
            tz=self._tz,
        )
        rendered = self.render_report(weekly_report, variant="weekly")

        if self.config.smtp is None:
            LOGGER.warning("SMTP is not configured; skipping weekly report send")
            return

        self.send_report(self.config.smtp, rendered)

    def run_purge(self) -> dict:
        """Delete data older than the configured retention window."""
        counts = purge_old_data(
            self.db_path, self.config.app.retention_days
        )
        LOGGER.info("Purged old data: %s", counts)
        return counts

    # -- lifecycle ---------------------------------------------------------

    def _build_tasks(self) -> list[ScheduledTask]:
        tasks = [
            ScheduledTask(
                "status_poll",
                self.config.app.poll_interval_seconds,
                self.run_status_once,
            ),
            ScheduledTask(
                "disk_poll",
                self.config.app.disk_poll_interval_seconds,
                self.run_disk_once,
            ),
        ]
        if self.config.report.daily_enabled:
            tasks.append(
                ScheduledTask(
                    "daily_report",
                    0,
                    self.run_daily_report,
                    target_time=lambda now: compute_daily_fire(
                        now, self.config.report.daily_time
                    ),
                )
            )
        if self.config.report.weekly.enabled:
            tasks.append(
                ScheduledTask(
                    "weekly_report",
                    0,
                    self.run_weekly_report,
                    target_time=lambda now: compute_weekly_fire(
                        now, 4, self.config.report.weekly.time
                    ),
                )
            )
        tasks.append(ScheduledTask("purge", 86400, self.run_purge))
        return tasks

    def start(self) -> None:
        """Build the scheduler, register all jobs and start its thread."""
        self._tz = resolve_timezone(self.config.app.timezone)
        self._scheduler = self._scheduler_factory(
            self._build_tasks(),
            db_path=self.db_path,
            tz=self._tz,
            clock=self._clock,
        )
        self._scheduler.start()

    def stop(self) -> None:
        """Stop the scheduler thread if it was started."""
        if self._scheduler is not None:
            self._scheduler.stop()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the server polling monitor service."
    )
    parser.add_argument("--config", required=True, help="Path to config.yaml")
    parser.add_argument(
        "--dotenv",
        default=None,
        help="Optional dotenv path loaded before config parsing.",
    )
    return parser


def main(
    argv: Sequence[str] | None = None, *, log_dir: Path | None = None
) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse raises for --help / usage errors
        return int(exc.code) if isinstance(exc.code, int) else 0

    configure_logging(Path(log_dir) if log_dir is not None else Path("logs"))

    try:
        config, db_path = load_runtime(
            Path(args.config),
            Path(args.dotenv) if args.dotenv else None,
        )
    except Exception as exc:  # pragma: no cover - integration path
        LOGGER.exception("Failed to load runtime configuration: %s", exc)
        return 1

    service = MonitorService(config, db_path=db_path)
    service.start()
    try:
        # Imported lazily so importing this module (e.g. in tests) stays cheap.
        from waitress import serve

        from servermanage.web import create_app

        serve(
            create_app(config=config, db_path=db_path),
            host=config.dashboard.host,
            port=config.dashboard.port,
        )
    except KeyboardInterrupt:  # pragma: no cover - interactive path
        LOGGER.info("Interrupted; shutting down monitor service")
    finally:
        service.stop()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
