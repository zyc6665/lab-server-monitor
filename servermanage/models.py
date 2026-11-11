from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timezone
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
    key_data: str | None = None


@dataclass(frozen=True)
class HostDiskHealthOverride:
    enabled: bool | None = None
    storcli_path: str | None = None
    use_sudo: bool | None = None


@dataclass(frozen=True)
class HostCheckConfig:
    """One availability check configured for a host."""

    name: str
    type: str
    target: str
    timeout_seconds: int = 5
    expected: str | None = None
    enabled: bool = True


@dataclass(frozen=True)
class HostAlertRules:
    """Per-host overrides for the global alert thresholds (``None`` = inherit)."""

    cpu_percent: float | None = None
    memory_percent: float | None = None
    disk_percent: float | None = None
    gpu_memory_percent: float | None = None
    disk_temperature_c: float | None = None
    consecutive_periods: int | None = None


@dataclass(frozen=True)
class HostCheckResult:
    """Outcome of running one :class:`HostCheckConfig` against a host."""

    name: str
    type: str
    target: str
    status: str
    message: str
    latency_ms: float | None = None
    checked_at: datetime | None = None


@dataclass(frozen=True)
class HostConfig:
    name: str
    host: str
    port: int
    username: str
    auth: AuthConfig
    tags: list[str] = field(default_factory=list)
    disk_health: HostDiskHealthOverride | None = None
    disk_mounts: list[str] = field(default_factory=lambda: ["/", "/data"])
    group: str = "未分组"
    owner: str = ""
    location: str = ""
    notes: str = ""
    checks: list[HostCheckConfig] = field(default_factory=list)
    alert_rules: HostAlertRules | None = None
    user_monitoring: bool | None = None
    #: Allows account provisioning on this host (needs the global switch too).
    allow_user_write: bool = False
    sudo_password: str | None = field(
        default=None, repr=False, metadata={"sensitive": True}
    )


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
    time: str = "16:00"
    weekday: int = 4


@dataclass(frozen=True)
class ReportConfig:
    subject_prefix: str
    include_failed_hosts: bool = True
    executive: "ExecutiveReportConfig | None" = None
    weekly: WeeklyReportConfig = field(default_factory=WeeklyReportConfig)
    daily_enabled: bool = True
    daily_time: str = "09:00"


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
class AppRuntimeConfig:
    poll_interval_seconds: int = 600
    disk_poll_interval_seconds: int = 86400
    concurrency: int = 8
    retention_days: int = 90
    host_metrics_max_points: int = 100
    disk_health_retention_days: int = 7
    disk_health_max_batches: int = 100
    host_daily_summary_retention_days: int = 90
    alert_history_retention_days: int = 30
    ssh_audit_retention_days: int = 30
    timezone: str = "Asia/Shanghai"
    auto_port_fallback: bool = True
    tray_enabled: bool = True
    open_browser_on_start: bool = True
    mode: str = "admin"
    member_account: str = ""


@dataclass(frozen=True)
class DashboardAuthConfig:
    enabled: bool = True
    username: str = "admin"
    password_env: str | None = "DASHBOARD_PASSWORD"
    password: str | None = None
    password_hash: str | None = None
    password_salt: str | None = None
    password_iterations: int = 200000


@dataclass(frozen=True)
class DashboardConfig:
    host: str = "0.0.0.0"
    port: int = 8080
    auth: DashboardAuthConfig = field(default_factory=DashboardAuthConfig)
    session_secret_env: str = "DASHBOARD_SECRET"
    session_secret: str | None = None
    session_lifetime_hours: int = 12


@dataclass(frozen=True)
class AlertThresholds:
    cpu_percent: float = 90
    memory_percent: float = 90
    disk_percent: float = 90
    gpu_memory_percent: float = 90
    disk_temperature_c: float = 55


@dataclass(frozen=True)
class WebhookConfig:
    enabled: bool = False
    type: str = "wecom"
    url_env: str | None = "ALERT_WEBHOOK_URL"
    url: str | None = None


@dataclass(frozen=True)
class AlertsConfig:
    enabled: bool = True
    desktop_notification: bool = True
    email: bool = True
    webhook: WebhookConfig = field(default_factory=WebhookConfig)
    thresholds: AlertThresholds = field(default_factory=AlertThresholds)
    cooldown_minutes: int = 60
    repeat_while_active: bool = False
    offline_failures: int = 2
    aggregate_by_host: bool = True
    notify_on_recovery: bool = True
    consecutive_periods: int = 2


@dataclass(frozen=True)
class DiskHealthRuleConfig:
    alert_on_media_errors: bool = True
    alert_on_other_errors: bool = True
    alert_on_predictive_failure: bool = True
    alert_on_smart_flag: bool = True
    alert_on_state_not_optimal: bool = True
    alert_on_error_increase: bool = True


@dataclass(frozen=True)
class DiskHealthConfig:
    enabled: bool = True
    use_sudo: bool = True
    storcli_candidates: tuple[str, ...] = (
        "storcli",
        "storcli64",
        "/opt/MegaRAID/storcli/storcli64",
        "/opt/lsi/storcli/storcli64",
        "/usr/local/bin/storcli",
        "/usr/sbin/storcli",
    )
    rules: DiskHealthRuleConfig = field(default_factory=DiskHealthRuleConfig)


@dataclass(frozen=True)
class UserMonitoringConfig:
    """Global read-only user monitoring settings."""

    enabled: bool = True
    scan_interval_seconds: int = 3600
    usage_interval_seconds: int = 21600
    command_timeout: int = 120
    #: Master switch for account write operations (create/password/docker/data).
    #: Off by default; every host also needs ``allow_user_write``.
    write_enabled: bool = False


@dataclass(frozen=True)
class AppConfig:
    smtp: SMTPConfig | None
    ssh: SSHRuntimeConfig
    report: ReportConfig
    servers: list[HostConfig]
    storage: StorageConfig = field(default_factory=StorageConfig)
    app: AppRuntimeConfig = field(default_factory=AppRuntimeConfig)
    dashboard: DashboardConfig = field(default_factory=DashboardConfig)
    alerts: AlertsConfig = field(default_factory=AlertsConfig)
    disk_health: DiskHealthConfig = field(default_factory=DiskHealthConfig)
    user_monitoring: UserMonitoringConfig = field(
        default_factory=UserMonitoringConfig
    )


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
    net_rx_bytes: int | None = None
    net_tx_bytes: int | None = None


@dataclass(frozen=True)
class HostUserAccount:
    """Read-only snapshot of one laboratory user account on a host."""

    host_name: str
    username: str
    uid: int
    gid: int
    primary_group: str | None = None
    gecos: str = ""
    home: str = ""
    shell: str = ""
    groups: list[str] = field(default_factory=list)
    in_docker: bool = False
    in_sudo: bool = False
    home_exists: bool = False
    home_owner: str | None = None
    home_group: str | None = None
    home_mode: str | None = None
    home_size_bytes: int | None = None
    data_exists: bool = False
    data_owner: str | None = None
    data_group: str | None = None
    data_mode: str | None = None
    data_size_bytes: int | None = None
    data_supported: bool = True
    usage_readable: bool = True
    usage_stale: bool = False
    usage_collected_at: datetime | None = None
    collected_at: datetime = field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    state: str = "present"


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
    checks: list[HostCheckResult] = field(default_factory=list)
    users: list[HostUserAccount] = field(default_factory=list)


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
    checks: list[dict] = field(default_factory=list)


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
