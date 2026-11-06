from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class AuthConfig:
    type: str
    password: str | None = None
    password_env: str | None = None
    key_path: Path | None = None
    passphrase: str | None = None
    passphrase_env: str | None = None


@dataclass(frozen=True)
class HostConfig:
    name: str
    host: str
    port: int
    username: str
    auth: AuthConfig


@dataclass(frozen=True)
class SMTPConfig:
    host: str
    port: int
    username: str
    password: str
    use_ssl: bool
    from_addr: str
    to_addrs: list[str]


@dataclass(frozen=True)
class SSHRuntimeConfig:
    connect_timeout: int
    command_timeout: int


@dataclass(frozen=True)
class WeeklyReportConfig:
    enabled: bool = True
    subject_prefix: str = "[Server Weekly Report]"
    busy_threshold: float = 70.0
    idle_threshold: float = 20.0


@dataclass(frozen=True)
class ReportConfig:
    subject_prefix: str
    include_failed_hosts: bool = True
    executive: "ExecutiveReportConfig | None" = None
    weekly: WeeklyReportConfig = field(default_factory=WeeklyReportConfig)


@dataclass(frozen=True)
class ExecutiveReportConfig:
    enabled: bool = False
    subject_prefix: str = "[Leader Summary]"
    to_addrs: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class StorageConfig:
    enabled: bool = True
    db_path: Path = field(default_factory=lambda: Path("data/servermanage.db"))


@dataclass(frozen=True)
class AppConfig:
    smtp: SMTPConfig
    ssh: SSHRuntimeConfig
    report: ReportConfig
    servers: list[HostConfig]
    storage: StorageConfig = field(default_factory=StorageConfig)


@dataclass(frozen=True)
class LoadAverage:
    load_1: float
    load_5: float
    load_15: float


@dataclass(frozen=True)
class MemorySummary:
    total_mb: int
    used_mb: int
    free_mb: int
    shared_mb: int
    buff_cache_mb: int
    available_mb: int
    swap_total_mb: int
    swap_used_mb: int
    swap_free_mb: int


@dataclass(frozen=True)
class DiskUsageRow:
    filesystem: str
    size: str
    used: str
    available: str
    percent: str
    mountpoint: str


@dataclass(frozen=True)
class LoggedInUser:
    username: str
    terminal: str
    login_at: str
    remote_host: str | None = None


@dataclass(frozen=True)
class UserProcessCount:
    username: str
    count: int
    container_id: str | None = None
    container_name: str | None = None


@dataclass(frozen=True)
class ProcessRow:
    username: str
    pid: int
    cpu_percent: float
    mem_percent: float
    elapsed: str
    command: str
    container_id: str | None = None
    container_name: str | None = None


@dataclass(frozen=True)
class GPUSummaryRow:
    index: int
    name: str
    utilization_percent: int
    temperature_c: int | None
    memory_used_mb: int
    memory_total_mb: int


@dataclass(frozen=True)
class GPUProcessRow:
    index: int
    pid: int
    username: str | None
    memory_used_mb: int
    command: str


@dataclass(frozen=True)
class HostMetrics:
    hostname: str | None = None
    os_pretty_name: str | None = None
    kernel_version: str | None = None
    uptime: str | None = None
    collected_at: datetime | None = None
    load_average: LoadAverage | None = None
    cpu_core_count: int | None = None
    cpu_usage_percent: float | None = None
    memory: MemorySummary | None = None
    disk_usage: list[DiskUsageRow] = field(default_factory=list)
    logged_in_users: list[LoggedInUser] = field(default_factory=list)
    total_processes: int | None = None
    process_counts_by_user: list[UserProcessCount] = field(default_factory=list)
    top_cpu_processes: list[ProcessRow] = field(default_factory=list)
    top_memory_processes: list[ProcessRow] = field(default_factory=list)
    gpu_summary: list[GPUSummaryRow] = field(default_factory=list)
    gpu_processes: list[GPUProcessRow] = field(default_factory=list)


@dataclass(frozen=True)
class HostCollectionError:
    stage: str
    message: str


@dataclass(frozen=True)
class HostReport:
    host_name: str
    host: str
    success: bool
    metrics: HostMetrics = field(default_factory=HostMetrics)
    errors: list[HostCollectionError] = field(default_factory=list)


@dataclass(frozen=True)
class DailyReport:
    generated_at: datetime
    reports: list[HostReport]
    subject_prefix: str


@dataclass(frozen=True)
class RenderedReport:
    subject: str
    text_body: str
    html_body: str


@dataclass(frozen=True)
class WeeklyHostSummary:
    host_name: str
    host: str
    sample_count: int
    success_count: int
    cpu_avg: float | None
    cpu_max: float | None
    cpu_min: float | None
    memory_avg_percent: float | None
    memory_max_percent: float | None
    disk_avg_percent: float | None
    disk_max_percent: float | None
    gpu_util_avg: float | None
    gpu_util_max: float | None
    gpu_memory_avg_percent: float | None
    gpu_memory_max_percent: float | None
    load_avg: float | None
    users_avg: float | None
    processes_avg: float | None
    daily_points: list[dict[str, object]] = field(default_factory=list)


@dataclass(frozen=True)
class WeeklyReport:
    generated_at: datetime
    week_start: date
    week_end: date
    summaries: list[WeeklyHostSummary]
    busy_hosts: list[WeeklyHostSummary]
    idle_hosts: list[WeeklyHostSummary]
    subject_prefix: str


@dataclass(frozen=True)
class CommandResult:
    stdout: str
    stderr: str
    exit_status: int


class SSHRunner(Protocol):
    def run(self, command: str, timeout: int) -> CommandResult:
        ...


class HostCollector(Protocol):
    def collect(self, host: HostConfig, runtime: SSHRuntimeConfig) -> HostReport:
        ...


class ReportRenderer(Protocol):
    def render(
        self, report: DailyReport | WeeklyReport, variant: str = "technical"
    ) -> RenderedReport:
        ...


class MailSender(Protocol):
    def send(self, smtp: SMTPConfig, report: RenderedReport, to_addrs: list[str] | None = None) -> None:
        ...
