from datetime import datetime, timezone

from servermanage.availability import build_check_command
from servermanage.collectors import collect_all_hosts, collect_host_report
from servermanage.commands import (
    DOCKER_CONTAINERS_STAGE,
    GPU_PROCESSES_STAGE,
    GPU_SUMMARY_STAGE,
    PID_CONTAINER_STAGE,
    build_command_map,
)
from servermanage.models import (
    AppConfig,
    AuthConfig,
    CommandResult,
    HostCheckConfig,
    HostConfig,
    HostMetrics,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
)


class FakeSSH:
    def __init__(self, results=None, error=None):
        self.results = results or {}
        self.error = error
        self.commands = []
        self.closed = False

    def run(self, command, timeout):
        self.commands.append((command, timeout))
        if self.error is not None:
            raise self.error
        return self.results[command]

    def close(self):
        self.closed = True


def test_collect_host_report_marks_partial_gpu_failure():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    runner = FakeSSH(
        results={
            "hostname": CommandResult(stdout="gpu-01", stderr="", exit_status=0),
            "gpu": CommandResult(stdout="", stderr="nvidia-smi missing", exit_status=127),
        }
    )

    report = collect_host_report(
        host,
        runner,
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname", "gpu": "gpu"},
        parse_results=lambda results, _: HostMetrics(
            hostname=results["host"].stdout.strip(),
            collected_at=datetime.now(timezone.utc),
        ),
    )

    assert report.host_name == host.name
    assert report.success is True
    assert report.metrics.hostname == "gpu-01"
    assert report.errors[0].stage == "gpu"


def test_collect_host_report_marks_ssh_failure():
    host = HostConfig(
        name="gpu-02",
        host="10.0.0.2",
        port=22,
        username="root",
        auth=AuthConfig(type="key"),
    )

    report = collect_host_report(
        host,
        FakeSSH(error=RuntimeError("ssh timeout")),
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname"},
        parse_results=lambda _results, _host: HostMetrics(),
    )

    assert report.success is False
    assert report.errors[0].stage == "ssh"


def test_collect_all_hosts_uses_runner_factory():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    config = AppConfig(
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
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[host],
    )

    report = HostMetrics(hostname="gpu-01", collected_at=datetime.now(timezone.utc))

    reports = collect_all_hosts(
        config,
        build_runner=lambda host, timeout: FakeSSH({"cmd": CommandResult("ok", "", 0)}),
        build_command_map=lambda: {"host": "cmd"},
        parse_results=lambda _results, _host: report,
    )

    assert len(reports) == 1
    assert reports[0].metrics.hostname == "gpu-01"


def test_collect_host_report_marks_parse_failure_without_crashing():
    host = HostConfig(
        name="gpu-03",
        host="10.0.0.3",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )

    report = collect_host_report(
        host,
        FakeSSH(results={"hostname": CommandResult(stdout="gpu-03", stderr="", exit_status=0)}),
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname"},
        parse_results=lambda _results, _host: (_ for _ in ()).throw(ValueError("bad parser output")),
    )

    assert report.success is False
    assert report.errors[0].stage == "parse"


def test_collect_all_hosts_closes_runner_after_collection():
    host = HostConfig(
        name="gpu-04",
        host="10.0.0.4",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    config = AppConfig(
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
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[host],
    )
    runner = FakeSSH(results={"cmd": CommandResult("ok", "", 0)})

    reports = collect_all_hosts(
        config,
        build_runner=lambda _host, _timeout: runner,
        build_command_map=lambda: {"host": "cmd"},
        parse_results=lambda _results, _host: HostMetrics(
            hostname="gpu-04",
            collected_at=datetime.now(timezone.utc),
        ),
    )

    assert len(reports) == 1
    assert runner.closed is True


def test_collect_all_hosts_default_pipeline_parses_command_outputs():
    host = HostConfig(
        name="gpu-01",
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    config = AppConfig(
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
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[host],
    )
    command_map = build_command_map()
    runner_results = {
        command_map["hostname"]: CommandResult("gpu-01\n", "", 0),
        command_map["os_release"]: CommandResult("Ubuntu 22.04\n", "", 0),
        command_map["kernel"]: CommandResult("5.15.0\n", "", 0),
        command_map["uptime"]: CommandResult(
            " 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76",
            "",
            0,
        ),
        command_map["cpu_cores"]: CommandResult("16\n", "", 0),
        command_map["cpu_usage"]: CommandResult("9.0\n", "", 0),
        command_map["memory"]: CommandResult(
            "              total        used        free      shared  buff/cache   available\n"
            "Mem:          64000       41000        3000         120       20000       22000\n"
            "Swap:          8192         512        7680",
            "",
            0,
        ),
        command_map["disk"]: CommandResult(
            "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 300G 120G 180G 40% /",
            "",
            0,
        ),
        command_map["who"]: CommandResult(
            "root pts/0 2026-03-25 09:00 (10.0.0.2)",
            "",
            0,
        ),
        command_map["total_processes"]: CommandResult("123\n", "", 0),
        command_map["process_counts"]: CommandResult("82 root\n46 trainuser\n", "", 0),
        command_map["top_cpu"]: CommandResult(
            "root 12345 311.2 12.4 18:20:11 python train.py\n",
            "",
            0,
        ),
        command_map["top_memory"]: CommandResult(
            "root 12345 311.2 12.4 18:20:11 python train.py\n",
            "",
            0,
        ),
        command_map["pid_user_map"]: CommandResult("12345 root python train.py\n", "", 0),
        command_map[DOCKER_CONTAINERS_STAGE]: CommandResult(
            "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train\n",
            "",
            0,
        ),
        command_map[PID_CONTAINER_STAGE]: CommandResult(
            "12345\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n",
            "",
            0,
        ),
        command_map["gpu_summary"]: CommandResult(
            "0, NVIDIA RTX 4090, 91, 67, 18200, 24564, GPU-UUID-0\n",
            "",
            0,
        ),
        command_map["gpu_processes"]: CommandResult(
            "GPU-UUID-0, 12345, 16000, python train.py\n",
            "",
            0,
        ),
    }

    reports = collect_all_hosts(
        config,
        build_runner=lambda _host, _timeout: FakeSSH(runner_results),
    )

    assert len(reports) == 1
    metrics = reports[0].metrics
    assert metrics.cpu_core_count == 16
    assert metrics.cpu_usage_percent == 9.0
    assert metrics.logged_in_users[0].username == "root"
    assert metrics.process_counts_by_user[0].username == "root"
    assert metrics.process_counts_by_user[0].container_name == "zhangz-train"
    assert metrics.top_cpu_processes[0].command == "python train.py"
    assert metrics.top_cpu_processes[0].container_name == "zhangz-train"
    assert metrics.gpu_summary[0].name == "NVIDIA RTX 4090"
    assert metrics.gpu_processes[0].username == "root"


def _host_with_checks(name: str, checks: list[HostCheckConfig]) -> HostConfig:
    return HostConfig(
        name=name,
        host="10.0.0.9",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
        checks=checks,
    )


def _parse_hostname(results, _host) -> HostMetrics:
    return HostMetrics(
        hostname=results["host"].stdout.strip(),
        collected_at=datetime.now(timezone.utc),
    )


def test_collect_host_report_includes_check_results():
    check = HostCheckConfig(name="API", type="tcp", target="8000", timeout_seconds=3)
    host = _host_with_checks("gpu-05", [check])
    runner = FakeSSH(
        results={
            "hostname": CommandResult(stdout="gpu-05", stderr="", exit_status=0),
            build_check_command(check): CommandResult(stdout="", stderr="", exit_status=0),
        }
    )

    report = collect_host_report(
        host,
        runner,
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname"},
        parse_results=_parse_hostname,
    )

    assert report.success is True
    assert [item.name for item in report.checks] == ["API"]
    assert report.checks[0].type == "tcp"
    assert report.checks[0].status == "ok"


def test_check_failure_does_not_fail_host_report():
    check = HostCheckConfig(name="API", type="tcp", target="8000", timeout_seconds=3)
    host = _host_with_checks("gpu-06", [check])
    check_command = build_check_command(check)

    class RaiseOnCheckSSH(FakeSSH):
        def run(self, command, timeout):
            self.commands.append((command, timeout))
            if command == check_command:
                raise RuntimeError("ssh channel broke during check")
            return self.results[command]

    runner = RaiseOnCheckSSH(
        results={"hostname": CommandResult(stdout="gpu-06", stderr="", exit_status=0)}
    )

    report = collect_host_report(
        host,
        runner,
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname"},
        parse_results=_parse_hostname,
    )

    assert report.success is True
    assert report.metrics.hostname == "gpu-06"
    assert report.checks[0].status == "error"


def test_check_runner_crash_does_not_fail_host_report(monkeypatch):
    host = _host_with_checks(
        "gpu-07", [HostCheckConfig(name="API", type="tcp", target="8000")]
    )

    def boom(*_args, **_kwargs):
        raise RuntimeError("checks exploded")

    monkeypatch.setattr("servermanage.collectors.run_host_checks", boom)
    runner = FakeSSH(
        results={"hostname": CommandResult(stdout="gpu-07", stderr="", exit_status=0)}
    )

    report = collect_host_report(
        host,
        runner,
        connect_timeout=10,
        command_timeout=20,
        build_command_map=lambda: {"host": "hostname"},
        parse_results=_parse_hostname,
    )

    assert report.success is True
    assert report.metrics.hostname == "gpu-07"
    assert report.checks == []


def test_build_command_map_includes_docker_container_stages():
    command_map = build_command_map()

    assert DOCKER_CONTAINERS_STAGE in command_map
    assert PID_CONTAINER_STAGE in command_map


def test_collect_all_hosts_marks_real_gpu_stage_failures_as_partial():
    host = HostConfig(
        name="gpu-02",
        host="10.0.0.2",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )
    config = AppConfig(
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
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=[host],
    )
    command_map = build_command_map()
    runner_results = {
        command_map["hostname"]: CommandResult("gpu-02\n", "", 0),
        command_map["os_release"]: CommandResult("Ubuntu 22.04\n", "", 0),
        command_map["kernel"]: CommandResult("5.15.0\n", "", 0),
        command_map["uptime"]: CommandResult(" 09:00:00 up 2 days,  1 user,  load average: 1.0, 0.8, 0.7", "", 0),
        command_map["cpu_cores"]: CommandResult("8\n", "", 0),
        command_map["cpu_usage"]: CommandResult("12.5\n", "", 0),
        command_map["memory"]: CommandResult(
            "              total        used        free      shared  buff/cache   available\n"
            "Mem:          32000       12000        5000         120       15000       18000\n"
            "Swap:          4096           0        4096",
            "",
            0,
        ),
        command_map["disk"]: CommandResult(
            "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 300G 120G 180G 40% /",
            "",
            0,
        ),
        command_map["who"]: CommandResult("root pts/0 Mar 25 09:00 (10.0.0.2)", "", 0),
        command_map["total_processes"]: CommandResult("99\n", "", 0),
        command_map["process_counts"]: CommandResult("60 root\n39 trainuser\n", "", 0),
        command_map["top_cpu"]: CommandResult("root 1 5.0 0.1 00:10:00 python monitor.py\n", "", 0),
        command_map["top_memory"]: CommandResult("root 1 5.0 0.1 00:10:00 python monitor.py\n", "", 0),
        command_map["pid_user_map"]: CommandResult("1 root python monitor.py\n", "", 0),
        command_map[DOCKER_CONTAINERS_STAGE]: CommandResult("", "docker missing", 127),
        command_map[PID_CONTAINER_STAGE]: CommandResult("", "proc scan unavailable", 1),
        command_map["gpu_summary"]: CommandResult("", "nvidia-smi missing", 127),
        command_map["gpu_processes"]: CommandResult("", "nvidia-smi missing", 127),
    }

    reports = collect_all_hosts(
        config,
        build_runner=lambda _host, _timeout: FakeSSH(runner_results),
    )

    assert len(reports) == 1
    assert reports[0].success is True
    assert {error.stage for error in reports[0].errors} == {
        DOCKER_CONTAINERS_STAGE,
        PID_CONTAINER_STAGE,
        GPU_SUMMARY_STAGE,
        GPU_PROCESSES_STAGE,
    }
    assert reports[0].metrics.gpu_summary == []
    assert reports[0].metrics.gpu_processes == []
    assert reports[0].metrics.top_cpu_processes[0].container_name is None
