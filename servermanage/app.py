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
import os
import sys
import threading
from dataclasses import replace
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Sequence

from dotenv import load_dotenv

from servermanage.alerts import (
    AlertEngine,
    Notifier,
    SilenceRegistry,
    evaluate_disk_alerts,
    evaluate_system_alerts,
    offline_alert,
)
from servermanage.collectors import collect_all_hosts
from servermanage.config import load_config
from servermanage.disk_capacity import mount_statuses
from servermanage.disk_health import (
    DiskHealthReport,
    collect_disk_health,
    disk_report_from_snapshot,
)
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
    _extract_disk_used_percent,
    backfill_daily_summary,
    get_disk_health,
    init_storage,
    persist_host_reports,
    prune_alert_history,
    prune_alert_silences,
    prune_daily_summary,
    prune_disk_health,
    prune_host_metrics,
    prune_retention,
    prune_ssh_audit,
    purge_old_data,
    save_disk_health,
    save_host_snapshot,
)
from servermanage.timeutil import resolve_timezone
from servermanage.runtime import (
    acquire_single_instance,
    find_available_port,
    open_browser,
    read_runtime_state,
    write_runtime_state,
)
from servermanage.tray import start_tray
from servermanage.weekly import generate_weekly_report as _generate_weekly_report

LOGGER = logging.getLogger(__name__)

_LOGGING_CONFIGURED = False

# Desktop startup: the single-instance mutex and the runtime-state file always
# live in ``data/`` (design §3.7/§5.7).  They are resolved at call time so tests
# and a relocated working directory behave predictably.
_LOCK_PATH = Path("data") / "servermonitor.lock"
_RUNTIME_STATE_PATH = Path("data") / "runtime.json"


def _previous_disk_report(host_name: str, db_path: Path) -> DiskHealthReport | None:
    """Load the last persisted disk batch as an ``error_increase`` baseline.

    Returns ``None`` when there is no snapshot, when the previous batch was not
    a clean ``ok`` collection (e.g. ``permission_denied`` / ``error``), or when
    it reported zero physical drives — in those cases there is nothing
    trustworthy to compare against.
    """
    snapshot = get_disk_health(host_name, db_path)
    if snapshot is None or snapshot.get("status") != "ok":
        return None
    report = disk_report_from_snapshot(snapshot)
    if not report.physical_drives:
        return None
    return report


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

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(file_handler)
    # A windowed (PyInstaller ``--noconsole``) build has ``sys.stderr is None``;
    # attaching a StreamHandler to it would surface as "NoneType has no attribute
    # write" the first time anything logs.  Only add the console handler when a
    # real stderr stream exists.
    if sys.stderr is not None:
        stream_handler = logging.StreamHandler()
        stream_handler.setFormatter(formatter)
        root.addHandler(stream_handler)
    _LOGGING_CONFIGURED = True


def default_config_path() -> Path:
    """Return the ``config.yaml`` to use when ``--config`` is omitted.

    In a frozen (PyInstaller) build the executable tree is searched so a packaged
    desktop install finds its shipped ``config/config.yaml``; a source checkout
    falls back to the repo-level ``config/config.yaml``.  When no frozen
    candidate exists the first (exe-dir) candidate is returned so the subsequent
    load error names a sensible location.
    """
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable)
        candidates = [
            exe.parent / "config" / "config.yaml",
            exe.parents[2] / "config" / "config.yaml",
            Path.cwd() / "config" / "config.yaml",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        return candidates[0]
    return Path(__file__).resolve().parents[1] / "config" / "config.yaml"


def watch_parent_stdin(on_eof: Callable[[], None], stream=None) -> None:
    """Block reading *stream* until EOF, then invoke ``on_eof`` once.

    The desktop shell spawns the backend with ``--parent-stdin`` and keeps the
    child's stdin pipe open.  When the Electron parent exits the pipe closes and
    this watcher fires ``on_eof`` (usually ``server.close``) to shut the sidecar
    down.  It reads one byte at a time so it never buffers protocol data, and is
    meant to run on a daemon thread.
    """
    if stream is None:
        stream = getattr(sys, "stdin", None)
    if stream is None:
        # No stdin pipe (e.g. a windowed build): nothing to watch.
        LOGGER.warning("Parent-stdin watchdog has no stdin stream to watch")
        return
    try:
        while True:
            chunk = stream.read(1)
            if not chunk:
                break
    except (OSError, ValueError, EOFError):  # A closed/invalid stdin means EOF.
        pass
    LOGGER.info("Parent stdin closed; shutting down headless service")
    on_eof()


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
    init_storage(db_path, daily_summary_tz=config.app.timezone)
    return config, db_path


def load_runtime_with_settings(
    config_path: Path, dotenv_path: Path | None = None
) -> tuple[AppConfig, Path, "SettingsService"]:
    """Load the runtime configuration through the settings store.

    YAML/.env is treated as a *seed*: the SQLite ``app_settings``/``app_secrets``
    rows saved from the browser take precedence.  The YAML loader therefore runs
    in permissive mode so a fresh install can start before the first-run setup.
    """
    if dotenv_path is not None:
        dotenv_path = Path(dotenv_path)
        if not dotenv_path.exists():
            raise FileNotFoundError(f"Dotenv file does not exist: {dotenv_path}")
        load_dotenv(dotenv_path, override=True)

    from servermanage.settings import SettingsService

    base = load_config(
        Path(config_path),
        allow_empty_servers=True,
        allow_missing_secrets=True,
    )
    db_path = Path(base.storage.db_path)
    init_storage(db_path, daily_summary_tz=None)
    settings = SettingsService(
        config_path=Path(config_path), db_path=db_path, base_config=base
    )
    effective = settings.load()
    init_storage(db_path, daily_summary_tz=effective.app.timezone)
    return effective, db_path, settings


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
            self.db_path,
            config.alerts,
            self._notifier,
            clock=self._clock,
            silence_checker=SilenceRegistry(self.db_path, clock=self._clock),
            host_groups={h.name: [h.group] for h in config.servers},
        )
        self._scheduler_factory = scheduler_factory or Scheduler
        self._scheduler = None
        self._tz = resolve_timezone(config.app.timezone)
        # Consecutive failed status collections per host (for the offline message).
        self._failure_counts: dict[str, int] = {}
        self._collection_states: dict[str, dict] = {}
        self._collection_lock = threading.Lock()
        self._running = False

    def apply_config(self, new_config: AppConfig) -> None:
        """Hot-apply a freshly saved configuration.

        The scheduler is rebuilt from the new cadences, and the notifier/alert
        engine are recreated so channel enable flags and thresholds take effect
        without restarting the process.  ``dashboard.host``/``port`` are bound by
        waitress at startup and still require a restart (the settings API reports
        ``restart_required`` for that section).
        """
        was_running = self._running
        if self._scheduler is not None:
            self._scheduler.stop()
            self._scheduler = None
            self._running = False
        self.config = new_config
        self._tz = resolve_timezone(new_config.app.timezone)
        self._notifier = Notifier(smtp=new_config.smtp)
        self.engine = AlertEngine(
            self.db_path,
            new_config.alerts,
            self._notifier,
            clock=self._clock,
            silence_checker=SilenceRegistry(self.db_path, clock=self._clock),
            host_groups={h.name: [h.group] for h in new_config.servers},
        )
        if was_running:
            self.start()

    # -- polling jobs ------------------------------------------------------

    def _config_for_hosts(self, host_names: set[str] | None) -> AppConfig:
        if not host_names:
            return self.config
        selected = [host for host in self.config.servers if host.name in host_names]
        return replace(self.config, servers=selected)

    def run_once(self) -> dict:
        """Run one status cycle immediately followed by one disk cycle."""
        status_result = self.run_status_once()
        disk_result = self.run_disk_once()
        return {
            "hosts": status_result["hosts"],
            "disk_reports": disk_result["disk_reports"],
            "alerts": status_result["alerts"] + disk_result["alerts"],
        }

    def run_status_once(self, host_names: set[str] | None = None) -> dict:
        """Poll every host's system metrics and reconcile system/offline alerts.

        When *host_names* is given only those configured hosts are polled (used
        by the import auto-collection task).  Returns
        ``{"hosts": <reports>, "alerts": <notification count>}``.
        """
        config = self._config_for_hosts(host_names)
        reports = list(self.collect_status(config))
        storage_enabled = bool(getattr(config.storage, "enabled", True))
        offline_threshold = max(1, int(config.alerts.offline_failures))
        events: list = []
        recovery_count = 0
        notifications_on = bool(config.alerts.enabled) and bool(
            getattr(config.alerts, "notify_on_recovery", True)
        )
        # Only hosts that produced a successful report this cycle may have stale
        # system alerts resolved from them (see the reconciliation loop below).
        successful_hosts: set[str] = set()
        # Track every configured host so a host that drops out of this round's
        # reports is still known here. Reconciliation is limited to hosts that
        # reported successfully (see successful_hosts), so a host going dark
        # never closes its own system alerts.
        active: dict[str, set[str]] = {
            host.name: set() for host in config.servers
        }
        success_reports = []
        host_mounts = {host.name: host.disk_mounts for host in config.servers}

        for report in reports:
            host_name = report.host_name
            active.setdefault(host_name, set())
            if report.success:
                self._failure_counts[host_name] = 0
                if storage_enabled:
                    save_host_snapshot(report, self.db_path)
                success_reports.append(report)
                successful_hosts.add(host_name)
                # A recovered host should clear any stale offline alert and, when
                # configured, announce the recovery through the normal pipeline.
                recovered = self.engine.resolve(host_name, "offline", notify=True)
                if recovered and notifications_on:
                    recovery_count += len(recovered)
                mounts = host_mounts.get(host_name)
                disk_statuses = (
                    mount_statuses(report.metrics.disk_usage, mounts)
                    if mounts is not None
                    else None
                )
                disk_percent = _extract_disk_used_percent(report, mounts)
                for event in evaluate_system_alerts(
                    host_name,
                    report.metrics,
                    config.alerts.thresholds,
                    disk_percent=disk_percent,
                    disk_mounts=disk_statuses,
                ):
                    events.append(event)
                    active[host_name].add(event.fingerprint)
            else:
                failures = self._failure_counts.get(host_name, 0) + 1
                self._failure_counts[host_name] = failures
                # Debounce: only declare the host offline after the configured
                # number of consecutive failed collections.
                if failures >= offline_threshold:
                    event = offline_alert(host_name, failures)
                    events.append(event)
                    active[host_name].add(event.fingerprint)

        if storage_enabled and success_reports:
            persist_host_reports(
                DailyReport(
                    generated_at=datetime.now(timezone.utc),
                    reports=success_reports,
                    subject_prefix=config.report.subject_prefix,
                ),
                self.db_path,
                disk_mounts=host_mounts,
                tz=self._tz,
            )
            try:
                prune_host_metrics(
                    self.db_path, config.app.host_metrics_max_points
                )
            except Exception:  # pragma: no cover - pruning must not break polling
                LOGGER.exception("Failed to prune host metrics history")

        notified = self.engine.process(events)

        for host_name, fingerprints in active.items():
            # A failed or missing host has no fresh metrics this cycle, so its
            # open CPU/memory/disk alerts must stay open; closing them would
            # dispatch a bogus "system recovered" notice exactly when the host
            # went dark (and possibly before the offline threshold fires).
            if host_name not in successful_hosts:
                continue
            recovered_system = self.engine.resolve_missing(
                host_name, fingerprints, category="system", notify=True
            )
            if recovered_system and notifications_on:
                recovery_count += len(recovered_system)

        return {"hosts": len(reports), "alerts": len(notified) + recovery_count}

    def run_disk_once(self, host_names: set[str] | None = None) -> dict:
        """Poll disk health on every enabled host and reconcile disk alerts.

        ``alerts`` counts newly dispatched disk alert notifications plus disk
        recovery notices generated while reconciling polled hosts.
        """
        config = self._config_for_hosts(host_names)
        if not bool(getattr(config.disk_health, "enabled", True)):
            # Globally disabled: no SSH attempts at all.
            return {"disk_reports": 0, "alerts": 0}

        storage_enabled = bool(getattr(config.storage, "enabled", True))
        temperature_threshold_c = float(
            config.alerts.thresholds.disk_temperature_c
        )
        notifications_on = bool(config.alerts.enabled) and bool(
            getattr(config.alerts, "notify_on_recovery", True)
        )
        disk_recovery_count = 0
        events: list = []
        # Only hosts actually polled this cycle take part in alert resolution;
        # a skipped/failed host must not have its existing disk alerts closed.
        active: dict[str, set[str]] = {}
        disk_reports = []

        for host in config.servers:
            override = host.disk_health
            if (
                override is not None
                and override.enabled is not None
                and not override.enabled
            ):
                continue

            previous = (
                _previous_disk_report(host.name, self.db_path)
                if storage_enabled
                else None
            )

            runner = SSHClientWrapper(
                host=host, connect_timeout=config.ssh.connect_timeout
            )
            try:
                report = self.collect_disk(
                    host,
                    runner,
                    config=config.disk_health,
                    command_timeout=config.ssh.command_timeout,
                    previous=previous,
                    override=host.disk_health,
                    temperature_threshold_c=temperature_threshold_c,
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

        if storage_enabled and disk_reports:
            try:
                prune_disk_health(
                    self.db_path,
                    config.app.disk_health_retention_days,
                    config.app.disk_health_max_batches,
                )
            except Exception:  # pragma: no cover - pruning must not break polling
                LOGGER.exception("Failed to prune disk health history")

        notified = self.engine.process(events)

        for host_name, fingerprints in active.items():
            recovered_disk = self.engine.resolve_missing(
                host_name, fingerprints, category="disk", notify=True
            )
            if recovered_disk and notifications_on:
                disk_recovery_count += len(recovered_disk)

        return {
            "disk_reports": len(disk_reports),
            "alerts": len(notified) + disk_recovery_count,
        }

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
        """Legacy entry point; now applies the full v1.6 retention matrix."""
        counts = prune_retention(self.db_path, self.config)
        LOGGER.info("Applied retention policy: %s", counts)
        return counts

    def run_retention_cleanup(self) -> dict:
        """Hourly lightweight cleanup for low-volume history tables."""
        counts: dict[str, int] = {}
        try:
            counts["alert_history"] = prune_alert_history(
                self.db_path, self.config.app.alert_history_retention_days
            )
            counts["ssh_audit"] = prune_ssh_audit(
                self.db_path, self.config.app.ssh_audit_retention_days
            )
            counts["daily_summary"] = prune_daily_summary(
                self.db_path, self.config.app.host_daily_summary_retention_days
            )
            counts["alert_silences"] = prune_alert_silences(self.db_path)
        except Exception:  # pragma: no cover - cleanup must never kill the scheduler
            LOGGER.exception("Retention cleanup failed")
        LOGGER.info("Retention cleanup: %s", counts)
        return counts

    # -- import auto-collection -------------------------------------------

    def schedule_host_collection(
        self, names: list[str] | set[str], *, include_disk: bool = True
    ) -> None:
        """Collect status (and optionally disk) for *names* on a daemon thread."""
        selected = [str(name) for name in names if str(name)]
        if not selected:
            return
        with self._collection_lock:
            for name in selected:
                self._collection_states[name] = {
                    "state": "pending",
                    "started_at": None,
                    "finished_at": None,
                    "error": None,
                }

        def worker() -> None:
            with self._collection_lock:
                for name in selected:
                    self._collection_states[name] = {
                        "state": "running",
                        "started_at": datetime.now(timezone.utc).isoformat(),
                        "finished_at": None,
                        "error": None,
                    }
            try:
                self.run_status_once(set(selected))
                if include_disk:
                    self.run_disk_once(set(selected))
                with self._collection_lock:
                    for name in selected:
                        state = dict(self._collection_states.get(name, {}))
                        state.update(
                            {
                                "state": "done",
                                "finished_at": datetime.now(timezone.utc).isoformat(),
                                "error": None,
                            }
                        )
                        self._collection_states[name] = state
            except Exception as exc:  # pragma: no cover - worker isolation
                LOGGER.exception("Import auto-collection failed")
                with self._collection_lock:
                    for name in selected:
                        state = dict(self._collection_states.get(name, {}))
                        state.update(
                            {
                                "state": "error",
                                "finished_at": datetime.now(timezone.utc).isoformat(),
                                "error": str(exc),
                            }
                        )
                        self._collection_states[name] = state

        threading.Thread(
            target=worker, name="host-import-collection", daemon=True
        ).start()

    def collection_status(self, names: list[str] | None = None) -> dict[str, dict]:
        with self._collection_lock:
            if names:
                return {
                    name: dict(
                        self._collection_states.get(
                            name, {"state": "unknown"}
                        )
                    )
                    for name in names
                }
            return {name: dict(state) for name, state in self._collection_states.items()}

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
                        now,
                        self.config.report.weekly.weekday,
                        self.config.report.weekly.time,
                    ),
                )
            )
        tasks.append(
            ScheduledTask("retention_cleanup", 3600, self.run_retention_cleanup)
        )
        return tasks

    def start(self) -> None:
        """Build the scheduler, register all jobs and start its thread."""
        self._tz = resolve_timezone(self.config.app.timezone)
        try:
            init_storage(self.db_path, daily_summary_tz=self.config.app.timezone)
            backfilled = backfill_daily_summary(self.db_path, self._tz)
            if backfilled:
                LOGGER.info("Backfilled %s daily summary rows", backfilled)
            LOGGER.info(
                "Startup retention: %s",
                prune_retention(self.db_path, self.config),
            )
        except Exception:  # pragma: no cover - startup cleanup is best effort
            LOGGER.exception("Startup retention/backfill failed")
        self._scheduler = self._scheduler_factory(
            self._build_tasks(),
            db_path=self.db_path,
            tz=self._tz,
            clock=self._clock,
        )
        self._scheduler.start()
        self._running = True

    def stop(self) -> None:
        """Stop the scheduler thread if it was started."""
        self._running = False
        if self._scheduler is not None:
            self._scheduler.stop()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the server polling monitor service."
    )
    parser.add_argument(
        "--config",
        default=None,
        help="Path to config.yaml (defaults to the bundled repo/exe-tree config).",
    )
    parser.add_argument(
        "--dotenv",
        default=None,
        help="Optional dotenv path loaded before config parsing.",
    )
    parser.add_argument(
        "--headless",
        action="store_true",
        default=False,
        help="Run without the system tray or browser (desktop sidecar mode).",
    )
    parser.add_argument(
        "--parent-stdin",
        action="store_true",
        default=False,
        help="Shut the service down when the parent process closes stdin.",
    )
    parser.add_argument(
        "--start-hidden",
        action="store_true",
        default=False,
        help="Accepted for desktop parity; no effect in the Python service.",
    )
    return parser


def choose_port(
    host: str, preferred: int, auto_port_fallback: bool = True, span: int = 20
) -> int:
    """Return the port to bind.

    With ``auto_port_fallback`` the first free port in ``[preferred,
    preferred+span)`` is probed; otherwise the configured port is used verbatim
    and a conflict surfaces later when waitress binds the socket.
    """
    if auto_port_fallback:
        return find_available_port(host, preferred, span)
    return preferred


def _dashboard_url(host: str, port: int) -> str:
    """Build the browser URL, normalising wildcard bind addresses to loopback."""
    display = host or ""
    if display in {"", "0.0.0.0", "::", "::0"}:
        display = "127.0.0.1"
    elif ":" in display and not display.startswith("["):
        # Bare IPv6 address needs brackets in a URL.
        display = f"[{display}]"
    return f"http://{display}:{port}"


def _focus_running_instance() -> None:
    """Open the dashboard of the already-running instance, if known."""
    try:
        state = read_runtime_state(_RUNTIME_STATE_PATH)
        url = state.get("url") if isinstance(state, dict) else None
        if url:
            open_browser(url)
        else:
            LOGGER.info(
                "Another servermonitor instance is running but no runtime state "
                "was found; leaving it in the foreground."
            )
    except Exception:  # noqa: BLE001 - focusing the other instance is best-effort
        LOGGER.exception("Failed to focus the running servermonitor instance")


def _build_server(*, config, db_path, settings, service, host: str, port: int):
    """Create the waitress server (imported lazily to keep module import cheap)."""
    from waitress import create_server

    from servermanage.web import create_app

    app_obj = create_app(
        config=config,
        db_path=db_path,
        settings_service=settings,
        on_config_changed=service.apply_config,
        session_cookie_suffix=str(port),
        on_hosts_imported=getattr(service, "schedule_host_collection", None),
        collection_status_provider=getattr(service, "collection_status", None),
    )
    from servermanage.web.routes import get_ssh_terminal_manager

    terminal_manager = get_ssh_terminal_manager(app_obj)
    server = create_server(
        app_obj,
        host=host,
        port=port,
        threads=32,
        channel_timeout=3600,
    )

    original_close = server.close

    def close_server() -> None:
        try:
            terminal_manager.shutdown()
        finally:
            original_close()

    server.close = close_server
    return server


def main(
    argv: Sequence[str] | None = None, *, log_dir: Path | None = None
) -> int:
    parser = build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:  # argparse raises for --help / usage errors
        return int(exc.code) if isinstance(exc.code, int) else 0

    configured_log_dir = Path(log_dir) if log_dir is not None else Path("logs")
    configure_logging(configured_log_dir)

    # Desktop mode is signalled by Electron via ``SERVERMONITOR_DESKTOP=1``.
    # It implies headless (no tray/browser) *and* restricts the dashboard to
    # loopback; a plain ``--headless`` CLI service keeps the LAN-bind ability
    # (ruling R1), so host validation is gated on the desktop env only.
    # Computed before the single-instance branch so a headless sidecar that loses
    # the lock never opens a browser to "focus" the other instance.
    desktop = os.environ.get("SERVERMONITOR_DESKTOP") == "1"
    headless = bool(args.headless) or desktop

    # 1) Single-instance guard first: the config (and thus the real data dir) is
    #    not loaded yet, so the bootstrap lock path lives in ``data/`` (§3.7/R3).
    lock = acquire_single_instance(_LOCK_PATH)
    if not lock.acquired:
        # Another copy owns the lock.  A GUI instance surfaces the existing
        # dashboard; a headless/desktop sidecar must never spawn a browser.
        if headless:
            LOGGER.info(
                "Another instance is already running; headless service exiting "
                "without opening a browser"
            )
        else:
            _focus_running_instance()
        lock.release()
        return 0

    service = None
    server = None
    tray_handle = None
    try:
        try:
            config_path = (
                Path(args.config) if args.config else default_config_path()
            )
            config, db_path, settings = load_runtime_with_settings(
                config_path,
                Path(args.dotenv) if args.dotenv else None,
            )
        except Exception as exc:  # pragma: no cover - integration path
            LOGGER.exception("Failed to load runtime configuration: %s", exc)
            return 1

        host = str(config.dashboard.host)
        if desktop:
            # v1.4 is a single-machine desktop client: never bind a routable
            # interface, even if an upgraded config.yaml still says 0.0.0.0.
            if host not in {"", "127.0.0.1", "localhost", "::1"}:
                LOGGER.warning(
                    "Desktop mode is single-machine only; overriding dashboard "
                    "host %r with 127.0.0.1",
                    host,
                )
            host = "127.0.0.1"

        preferred_port = int(config.dashboard.port)
        port = choose_port(
            host,
            preferred_port,
            bool(getattr(config.app, "auto_port_fallback", True)),
        )
        url = _dashboard_url(host, port)

        service = MonitorService(config, db_path=db_path)
        service.start()

        # ``create_server`` (rather than ``serve``) keeps a handle so the tray's
        # "退出" item can stop the blocking ``server.run()`` loop.
        server = _build_server(
            config=config,
            db_path=db_path,
            settings=settings,
            service=service,
            host=host,
            port=port,
        )
        write_runtime_state(
            _RUNTIME_STATE_PATH, url=url, port=port, pid=os.getpid()
        )

        if not headless and bool(
            getattr(config.app, "open_browser_on_start", True)
        ):
            threading.Timer(0.8, open_browser, [url]).start()

        if not headless and bool(getattr(config.app, "tray_enabled", True)):
            tray_handle = start_tray(
                url=url,
                log_dir=configured_log_dir,
                on_exit=server.close,
                enabled=True,
            )

        # Desktop sidecar lifecycle: when the Electron parent dies its stdin pipe
        # closes and the watcher stops this blocking server loop.
        if args.parent_stdin:
            threading.Thread(
                target=watch_parent_stdin,
                args=(server.close,),
                daemon=True,
            ).start()

        server.run()
    except KeyboardInterrupt:  # pragma: no cover - interactive path
        LOGGER.info("Interrupted; shutting down monitor service")
    except Exception as exc:  # noqa: BLE001 - keep the console usable on failure
        LOGGER.exception("Server startup failed: %s", exc)
        return 1
    finally:
        if tray_handle is not None:
            try:
                tray_handle.stop()
            except Exception:  # noqa: BLE001
                LOGGER.exception("Failed to stop system tray")
        if server is not None:
            try:
                server.close()
            except Exception:  # noqa: BLE001
                LOGGER.exception("Failed to close the dashboard server")
        if service is not None:
            service.stop()
        lock.release()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
