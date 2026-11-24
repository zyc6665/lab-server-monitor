"""v0.1.224：并行主机采集 + 服务器用户页导出/确认。

- ``collect_all_hosts`` 此前逐台串行：每台 21 条 SSH 命令，一台掉线主机
  吃满 connect_timeout（默认 10 秒）就会拖住整个轮询周期；现在按设置页
  的“并发数”（config.app.concurrency）并行采集，结果仍保持配置顺序。
- “从基线移除”是破坏性操作，此前点击立即执行且无法撤销，现在先弹确认框。
- 服务器用户页新增“导出 CSV”（跟随当前筛选，带 BOM）。
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path

from servermanage.collectors import collect_all_hosts
from servermanage.models import (
    AppConfig,
    AppRuntimeConfig,
    AuthConfig,
    CommandResult,
    HostConfig,
    HostMetrics,
    ReportConfig,
    SMTPConfig,
    SSHRuntimeConfig,
)

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _config(servers: list[HostConfig], concurrency: int = 8) -> AppConfig:
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
        report=ReportConfig(subject_prefix="[Daily]"),
        servers=servers,
        app=AppRuntimeConfig(concurrency=concurrency),
    )


def _host(name: str) -> HostConfig:
    return HostConfig(
        name=name,
        host="10.0.0.1",
        port=22,
        username="root",
        auth=AuthConfig(type="password", password="secret"),
    )


class BarrierSSH:
    """每台主机的 SSH 采集都要越过同一道栅栏：串行执行必然超时失败。"""

    def __init__(self, barrier: threading.Barrier):
        self.barrier = barrier
        self.closed = False

    def run(self, command, timeout):
        self.barrier.wait(timeout=2)
        return CommandResult(stdout="ok", stderr="", exit_status=0)

    def close(self):
        self.closed = True


class SlowSSH:
    def __init__(self, seconds: float):
        self.seconds = seconds
        self.closed = False

    def run(self, command, timeout):
        threading.Event().wait(self.seconds)
        return CommandResult(stdout="ok", stderr="", exit_status=0)

    def close(self):
        self.closed = True


def _run_collect(config: AppConfig, factory) -> list:
    return collect_all_hosts(
        config,
        build_runner=factory,
        build_command_map=lambda: {"host": "cmd"},
        parse_results=lambda _results, host: HostMetrics(
            hostname=host.name, collected_at=datetime.now(timezone.utc)
        ),
    )


def test_collect_all_hosts_runs_hosts_concurrently():
    hosts = [_host(f"gpu-{i}") for i in range(4)]
    barrier = threading.Barrier(4)
    reports = _run_collect(
        _config(hosts, concurrency=8),
        lambda _host, _timeout: BarrierSSH(barrier),
    )
    assert len(reports) == 4
    assert all(report.success for report in reports)


def test_collect_all_hosts_preserves_config_order():
    hosts = [_host(f"host-{i}") for i in range(5)]
    reports = _run_collect(
        _config(hosts, concurrency=8),
        lambda _host, _timeout: SlowSSH(0.02 * (5 - int(_host.name.split("-")[1]))),
    )
    assert [report.host_name for report in reports] == [host.name for host in hosts]


def test_collect_all_hosts_serial_when_concurrency_is_one():
    hosts = [_host("gpu-1"), _host("gpu-2")]
    reports = _run_collect(
        _config(hosts, concurrency=1),
        lambda _host, _timeout: SlowSSH(0.01),
    )
    assert [report.host_name for report in reports] == ["gpu-1", "gpu-2"]
    assert all(report.success for report in reports)


def test_collect_all_hosts_isolates_factory_errors():
    hosts = [_host("bad"), _host("good")]

    def factory(host, _timeout):
        if host.name == "bad":
            raise RuntimeError("bad ssh config")
        return SlowSSH(0.0)

    reports = _run_collect(_config(hosts), factory)
    assert [report.host_name for report in reports] == ["bad", "good"]
    assert reports[0].success is False
    assert reports[0].errors[0].stage == "ssh"
    assert "bad ssh config" in reports[0].errors[0].message
    assert reports[1].success is True


def test_collect_all_hosts_empty_servers_returns_empty():
    assert _run_collect(_config([]), lambda _h, _t: SlowSSH(0.0)) == []


# ---------------------------------------------------------------------------
# 服务器用户页：CSV 导出 + 基线移除确认
# ---------------------------------------------------------------------------


def test_users_page_has_export_button():
    html = (TEMPLATES / "users.html").read_text(encoding="utf-8")
    assert 'id="user-export-csv"' in html


def test_users_js_implements_csv_export():
    script = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function accountsCsv(data)" in script
    assert "'\\uFEFF' + lines.join('\\r\\n')" in script
    assert "function bindExportCsv()" in script
    assert "bindExportCsv();" in script
    # 导出跟随当前筛选（payload.accounts 即筛选后的明细）。
    assert "(data && data.accounts) || []" in script
    # 逗号/引号/换行需要转义。
    assert 'text.replace(/"/g, \'""\')' in script


def test_users_js_confirms_baseline_removal():
    script = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function confirmBaselineRemoval(hostName, username)" in script
    assert "confirmBaselineRemoval(row.host_name, row.username).then" in script
    assert "removeUserBaseline(row.host_name, row.username).then" in script
    # 确认框必须先于真正的移除调用。
    assert script.index("confirmBaselineRemoval(row.host_name") < script.index(
        "removeUserBaseline(row.host_name"
    )


def test_confirm_dialog_styles_exist():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".user-confirm-dialog {" in css
    assert ".user-confirm-foot" in css
    # M3：对话框背景用 --card-bg，暗色在 token 块重定义
    assert ".user-confirm-dialog {" in css and "background: var(--card-bg)" in css
