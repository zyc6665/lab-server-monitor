from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from typing import Callable

from servermanage.models import (
    AppConfig,
    CommandResult,
    HostCollectionError,
    HostConfig,
    HostMetrics,
    HostReport,
    SSHRunner,
)


def _result_failed(result: CommandResult) -> bool:
    return result.exit_status != 0


def _record_error(errors: list[HostCollectionError], stage: str, message: str) -> None:
    errors.append(HostCollectionError(stage=stage, message=message))


def collect_host_report(
    host: HostConfig,
    ssh_runner: SSHRunner,
    *,
    connect_timeout: int,
    command_timeout: int,
    build_command_map: Callable[[], dict[str, str]],
    parse_results: Callable[[dict[str, CommandResult], HostConfig], HostMetrics],
) -> HostReport:
    del connect_timeout  # reserved for future explicit connect lifecycle control

    command_map = build_command_map()
    results: dict[str, CommandResult] = {}
    errors: list[HostCollectionError] = []

    try:
        for stage, command in command_map.items():
            result = ssh_runner.run(command, timeout=command_timeout)
            results[stage] = result
            if _result_failed(result):
                _record_error(errors, stage, result.stderr or f"command exited {result.exit_status}")
    except Exception as exc:
        _record_error(errors, "ssh", str(exc))
        return HostReport(
            host_name=host.name,
            host=host.host,
            success=False,
            errors=errors,
        )

    try:
        metrics = parse_results(results, host)
    except Exception as exc:
        _record_error(errors, "parse", str(exc))
        return HostReport(
            host_name=host.name,
            host=host.host,
            success=False,
            errors=errors,
        )

    if metrics.collected_at is None:
        metrics = replace(metrics, collected_at=datetime.now(timezone.utc))

    return HostReport(
        host_name=host.name,
        host=host.host,
        success=not any(error.stage == "ssh" for error in errors),
        metrics=metrics,
        errors=errors,
    )


def collect_all_hosts(
    config: AppConfig,
    *,
    build_runner: Callable[[HostConfig, int], SSHRunner] | None = None,
    build_command_map: Callable[[], dict[str, str]] | None = None,
    parse_results: Callable[[dict[str, CommandResult], HostConfig], HostMetrics] | None = None,
) -> list[HostReport]:
    if build_command_map is None:
        from servermanage.commands import build_command_map as default_build_command_map

        command_builder = default_build_command_map
    else:
        command_builder = build_command_map

    if parse_results is None:
        from servermanage.parsers import parse_host_metrics as default_parse_results

        parser = default_parse_results
    else:
        parser = parse_results

    if build_runner is None:
        from servermanage.ssh_client import SSHClientWrapper

        runner_factory = lambda host, timeout: SSHClientWrapper(host=host, connect_timeout=timeout)
    else:
        runner_factory = build_runner

    reports: list[HostReport] = []
    for host in config.servers:
        runner = runner_factory(host, config.ssh.connect_timeout)
        try:
            reports.append(
                collect_host_report(
                    host,
                    runner,
                    connect_timeout=config.ssh.connect_timeout,
                    command_timeout=config.ssh.command_timeout,
                    build_command_map=command_builder,
                    parse_results=parser,
                )
            )
        finally:
            close = getattr(runner, "close", None)
            if callable(close):
                close()
    return reports
