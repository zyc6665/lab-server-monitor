"""Orchestration for read-only server user scans (Task 4).

``run_user_scan`` is the glue between the SSH collectors in
:mod:`servermanage.user_scan`, the persistence layer in
:mod:`servermanage.storage` and the alert state machine in
:mod:`servermanage.alerts`.

Design rules implemented here (see
``docs/plans/2026-11-09-server-user-monitoring-design.md`` §4–§6 and §8):

* hosts are scanned serially; one runner is opened and always closed per host;
* the expensive ``du`` pass only runs when the persisted ``last_usage_at`` is
  missing or older than ``usage_interval_seconds`` (or when forced);
* a host failure records ``last_error`` but keeps its snapshot, baseline and
  open alerts untouched;
* the first successful scan of a host only seeds the baseline/snapshot — no
  alerts are raised for pre-existing accounts;
* ``user-added`` is a transition alert, every other user alert is a state alert
  that must be regenerated each round and is resolved when it disappears.

The module deliberately performs no SSH work itself, which keeps it testable
with a fake ``scan`` callable.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from servermanage import storage
from servermanage.alerts import AlertEngine, evaluate_user_alerts
from servermanage.models import AppConfig, HostConfig, HostUserAccount
from servermanage.ssh_client import SSHClientWrapper
from servermanage.user_scan import collect_host_users

LOGGER = logging.getLogger(__name__)

_USER_ADDED_PREFIX = "user-added"
_USER_CATEGORY = "user"


def is_user_monitoring_enabled(host: HostConfig, config: AppConfig) -> bool:
    """Return the effective user-monitoring flag for *host*.

    A per-host ``user_monitoring`` override wins over the global switch;
    ``None`` (the default) inherits ``config.user_monitoring.enabled``.
    """
    if host.user_monitoring is not None:
        return bool(host.user_monitoring)
    return bool(config.user_monitoring.enabled)


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _parse_iso(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return _utc(datetime.fromisoformat(value))
    except (TypeError, ValueError):
        return None


def _usage_is_stale(
    now: datetime,
    last_usage: datetime | None,
    interval_seconds: int,
    usage_refreshed: bool,
    *,
    usage_due: bool = False,
) -> bool:
    """Return True when the displayed usage numbers are not trustworthy.

    A ``du`` that was due but failed (no sudo, timeout) marks the row stale even
    though older numbers are still shown; numbers older than 1.5 intervals are
    stale regardless.
    """
    if usage_refreshed:
        return False
    if last_usage is None:
        return True
    if usage_due:
        return True
    return (now - last_usage).total_seconds() > interval_seconds * 1.5


def _close_runner(runner: object) -> None:
    close = getattr(runner, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception:  # noqa: BLE001 - closing must not abort the scan round
        LOGGER.exception("Failed to close user-scan runner")


def _account_from_baseline(
    host_name: str, row: dict, now: datetime
) -> HostUserAccount:
    """Rebuild the last known account attributes for a missing baseline row."""
    return HostUserAccount(
        host_name=host_name,
        username=str(row["username"]),
        uid=int(row.get("uid") or 0),
        gid=int(row.get("gid") or 0),
        primary_group=row.get("primary_group"),
        home=str(row.get("home") or ""),
        shell=str(row.get("shell") or ""),
        groups=list(row.get("groups") or []),
        in_docker=bool(row.get("in_docker")),
        in_sudo=bool(row.get("in_sudo")),
        collected_at=now,
        state="missing",
    )


def _persist_failure(host_name: str, db_path: Path, message: str) -> None:
    """Record a failed scan without touching the stored snapshot or baseline."""
    try:
        storage.save_user_scan_state(
            host_name, db_path=db_path, last_error=message
        )
    except Exception:  # noqa: BLE001 - error reporting must not mask the error
        LOGGER.exception("Failed to record user-scan error for %s", host_name)


def _scan_host(
    host: HostConfig,
    config: AppConfig,
    db_path: Path,
    engine: AlertEngine,
    runner: object,
    scan: Callable[..., tuple],
    now: datetime,
    *,
    force_usage: bool,
) -> list[HostUserAccount]:
    """Scan one host, persist the result and reconcile its user alerts.

    Exceptions propagate to :func:`run_user_scan`, which records the host error
    and moves on without touching this host's stored data.
    """
    interval = int(config.user_monitoring.usage_interval_seconds)
    last_state = storage.get_user_scan_state(host.name, db_path)
    last_usage = _parse_iso(last_state.get("last_usage_at")) if last_state else None
    usage_due = (
        force_usage
        or last_usage is None
        or (now - last_usage).total_seconds() >= interval
    )

    accounts, usage_readable, usage_refreshed = scan(
        host,
        runner,
        now=now,
        usage_due=usage_due,
        command_timeout=config.user_monitoring.command_timeout,
        usage_timeout=config.user_monitoring.usage_timeout_seconds,
    )
    accounts = list(accounts)
    usage_refreshed = bool(usage_refreshed)

    previous_snapshot = storage.get_host_user_snapshot(host.name, db_path)
    previous_by_name = {row["username"]: row for row in previous_snapshot}
    baseline = storage.get_user_baseline(host.name, db_path)
    # The first *successful* scan seeds the baseline silently.  The stored scan
    # state is the marker: a host that failed earlier has a state row without
    # ``last_scan_at``, and a host whose first scan found zero accounts must not
    # be treated as "first scan" again on the next round.
    first_scan = last_state is None or not last_state.get("last_scan_at")

    stale = _usage_is_stale(
        now, last_usage, interval, usage_refreshed, usage_due=usage_due
    )


    normalized: list[HostUserAccount] = []
    for account in accounts:
        if not usage_refreshed:
            previous = previous_by_name.get(account.username)
            if previous is not None:
                account = replace(
                    account,
                    home_size_bytes=previous.get("home_size_bytes"),
                    data_size_bytes=previous.get("data_size_bytes"),
                )
            account = replace(account, usage_collected_at=last_usage)
        else:
            account = replace(account, usage_collected_at=now)
        account = replace(
            account,
            usage_readable=bool(usage_readable),
            usage_stale=stale,
        )
        normalized.append(account)

    if first_scan:
        # Establish the baseline silently: pre-existing accounts are not "new".
        storage.save_host_user_scan_result(
            host.name,
            [asdict(account) for account in normalized],
            db_path,
            now=now,
            usage_refreshed=usage_refreshed,
            seed_only=True,
        )
        return normalized

    # Snapshot + baseline + scan state commit atomically; the returned list is
    # the authoritative "newly discovered account" set for this round.
    inserted = storage.save_host_user_scan_result(
        host.name,
        [asdict(account) for account in normalized],
        db_path,
        now=now,
        usage_refreshed=usage_refreshed,
    )
    inserted_names = set(inserted)

    events = []
    for account in normalized:
        events.extend(
            evaluate_user_alerts(
                account,
                in_baseline=account.username not in inserted_names,
                missing=False,
            )
        )

    present_names = {account.username for account in normalized}
    for row in baseline:
        username = row["username"]
        if username in present_names:
            continue
        missing_account = _account_from_baseline(host.name, row, now)
        events.extend(
            evaluate_user_alerts(
                missing_account, in_baseline=True, missing=True
            )
        )

    # Only "state" alerts participate in resolution.  ``user-added`` is a
    # transition event and must stay active until acknowledged.
    active = {
        event.fingerprint
        for event in events
        if not event.fingerprint.startswith(_USER_ADDED_PREFIX)
    }

    engine.process(events)
    engine.resolve_missing(
        host.name,
        active,
        category=_USER_CATEGORY,
        skip_prefixes=(_USER_ADDED_PREFIX,),
    )
    return normalized


def run_user_scan(
    config: AppConfig,
    db_path: Path,
    engine: AlertEngine,
    *,
    build_runner: Callable[[HostConfig, int], object] | None = None,
    scan: Callable[..., tuple] = collect_host_users,
    now: datetime | None = None,
    force_usage: bool = False,
    progress: Callable[[dict], None] | None = None,
) -> dict:
    """Scan every user-monitored host once and return a summary.

    ``now`` is resolved once and shared by every host so the round is
    internally consistent; it also lets tests drive the usage cadence.  A
    failure on one host never aborts the round — the error is stored on that
    host's scan state and the next host is tried.
    """
    db_path = Path(db_path)
    moment = _utc(now) if now is not None else datetime.now(timezone.utc)
    started_at = moment

    hosts = [
        host for host in config.servers
        if is_user_monitoring_enabled(host, config)
    ]

    runner_factory = build_runner
    if runner_factory is None:
        def runner_factory(host: HostConfig, timeout: int) -> object:
            return SSHClientWrapper(host=host, connect_timeout=timeout)

    hosts_done = 0
    hosts_failed = 0
    accounts_total = 0
    errors: dict[str, str] = {}

    for host in hosts:
        runner: object | None = None
        try:
            runner = runner_factory(host, config.ssh.connect_timeout)
            scanned = _scan_host(
                host,
                config,
                db_path,
                engine,
                runner,
                scan,
                moment,
                force_usage=force_usage,
            )
        except Exception as exc:  # noqa: BLE001 - isolate per-host failures
            LOGGER.exception("User scan failed for host %s", host.name)
            hosts_failed += 1
            errors[host.name] = str(exc)
            _persist_failure(host.name, db_path, str(exc))
        else:
            hosts_done += 1
            accounts_total += len(scanned)
        finally:
            if runner is not None:
                _close_runner(runner)
            # 每台主机结束后回传一次进度，前端才能看到 1/N … N/N 而不是一直 0/N。
            if progress is not None:
                try:
                    progress(
                        {
                            "hosts_total": len(hosts),
                            "hosts_done": hosts_done,
                            "hosts_failed": hosts_failed,
                            "accounts": accounts_total,
                            "errors": dict(errors),
                        }
                    )
                except Exception:  # noqa: BLE001 - 进度上报不能影响采集
                    LOGGER.exception("User scan progress callback failed")

    finished_at = datetime.now(timezone.utc)

    return {
        "hosts_total": len(hosts),
        "hosts_done": hosts_done,
        "hosts_failed": hosts_failed,
        "accounts": accounts_total,
        "errors": errors,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
    }
