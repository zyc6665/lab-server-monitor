from datetime import datetime, timezone

from servermanage.models import (
    DailyReport,
    DiskUsageRow,
    GPUSummaryRow,
    HostCollectionError,
    HostCheckResult,
    HostMetrics,
    HostReport,
    MemorySummary,
    ProcessRow,
    UserProcessCount,
)
from servermanage.report import render_report


def test_render_report_includes_failed_host_section():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-03",
                host="10.0.0.3",
                success=False,
                metrics=HostMetrics(),
                errors=[HostCollectionError(stage="ssh", message="SSH timeout")],
            )
        ],
    )

    rendered = render_report(report)

    assert "Failed Hosts" in rendered.text_body
    assert "gpu-03" in rendered.html_body


def test_render_report_contains_inline_styles():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[HostReport(host_name="gpu-01", host="10.0.0.1", success=True, metrics=HostMetrics())],
    )

    rendered = render_report(report)

    assert "style=" in rendered.html_body
    assert "http://" not in rendered.html_body
    assert "https://" not in rendered.html_body


def test_render_report_shows_partial_collection_errors():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(),
                errors=[HostCollectionError(stage="gpu_summary", message="nvidia-smi missing")],
            )
        ],
    )

    rendered = render_report(report)

    assert "Collection Errors" in rendered.text_body
    assert "采集异常" in rendered.html_body
    assert "nvidia-smi missing" in rendered.html_body


def test_render_report_handles_non_numeric_disk_percent():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(
                    disk_usage=[
                        DiskUsageRow(
                            filesystem="文件系统",
                            size="容量",
                            used="已用",
                            available="可用",
                            percent="已用%",
                            mountpoint="挂载点",
                        )
                    ]
                ),
            )
        ],
    )

    rendered = render_report(report)

    assert "DISK 挂载点 已用%" in rendered.text_body or "挂载点 已用%" in rendered.html_body


def test_render_report_shows_container_label_in_user_columns():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(
                    process_counts_by_user=[
                        UserProcessCount(username="root", count=12, container_name="zhangz-train")
                    ],
                    top_cpu_processes=[
                        ProcessRow(
                            username="root",
                            pid=123,
                            cpu_percent=80.0,
                            mem_percent=10.0,
                            elapsed="00:10",
                            command="python train.py",
                            container_name="zhangz-train",
                        )
                    ],
                    top_memory_processes=[
                        ProcessRow(
                            username="root",
                            pid=456,
                            cpu_percent=40.0,
                            mem_percent=20.0,
                            elapsed="00:20",
                            command="python eval.py",
                            container_id="3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10",
                        )
                    ],
                ),
            )
        ],
    )

    rendered = render_report(report)

    assert "zhangz-train | root=12" in rendered.text_body
    assert "zhangz-train | root" in rendered.html_body
    assert "3fa4c1b92e10 | root" in rendered.text_body


def test_render_executive_report_contains_summary_risk_and_ownership_sections():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Leader Summary]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(
                    cpu_usage_percent=92.0,
                    memory=MemorySummary(
                        total_mb=32768,
                        used_mb=24576,
                        free_mb=4096,
                        shared_mb=128,
                        buff_cache_mb=4096,
                        available_mb=8192,
                        swap_total_mb=0,
                        swap_used_mb=0,
                        swap_free_mb=0,
                    ),
                    disk_usage=[
                        DiskUsageRow(
                            filesystem="/dev/sda1",
                            size="500G",
                            used="430G",
                            available="70G",
                            percent="86%",
                            mountpoint="/",
                        )
                    ],
                    process_counts_by_user=[
                        UserProcessCount(username="root", count=12, container_name="zhangz-train")
                    ],
                    top_cpu_processes=[
                        ProcessRow(
                            username="root",
                            pid=123,
                            cpu_percent=92.0,
                            mem_percent=18.0,
                            elapsed="01:20",
                            command="python train.py",
                            container_name="zhangz-train",
                        )
                    ],
                    top_memory_processes=[
                        ProcessRow(
                            username="root",
                            pid=456,
                            cpu_percent=40.0,
                            mem_percent=72.0,
                            elapsed="02:20",
                            command="python eval.py",
                            container_name="duanzt-exp01",
                        )
                    ],
                ),
            )
        ],
    )

    rendered = render_report(report, variant="executive")

    assert "风险摘要" in rendered.html_body
    assert "资源看板" in rendered.html_body
    assert "使用归属摘要" in rendered.html_body
    assert "zhangz-train | root" in rendered.text_body
    assert "Top CPU Processes" not in rendered.html_body


def test_render_executive_report_uses_total_disk_not_peak_partition():
    report = DailyReport(
        generated_at=datetime(2026, 3, 26, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Leader Summary]",
        reports=[
            HostReport(
                host_name="gpu-02",
                host="10.0.0.2",
                success=True,
                metrics=HostMetrics(
                    disk_usage=[
                        DiskUsageRow(
                            filesystem="/dev/sda1",
                            size="500G",
                            used="400G",
                            available="100G",
                            percent="80%",
                            mountpoint="/",
                        ),
                        DiskUsageRow(
                            filesystem="/dev/sdb1",
                            size="1.0T",
                            used="200G",
                            available="824G",
                            percent="20%",
                            mountpoint="/data",
                        ),
                        DiskUsageRow(
                            filesystem="/dev/sdb1",
                            size="1.0T",
                            used="200G",
                            available="824G",
                            percent="20%",
                            mountpoint="/srv/data",
                        ),
                        DiskUsageRow(
                            filesystem="tmpfs",
                            size="32G",
                            used="0G",
                            available="32G",
                            percent="0%",
                            mountpoint="/run",
                        ),
                        DiskUsageRow(
                            filesystem="overlay",
                            size="500G",
                            used="400G",
                            available="100G",
                            percent="80%",
                            mountpoint="/var/lib/docker/overlay2",
                        ),
                    ]
                ),
            )
        ],
    )

    rendered = render_report(report, variant="executive")

    assert "已用 600.0 GiB / 1.5 TiB (39.4%)" in rendered.text_body
    assert "/ 80%" not in rendered.text_body
    assert "/data 20%" not in rendered.text_body


def test_render_executive_report_uses_total_gpu_memory_not_peak_card():
    report = DailyReport(
        generated_at=datetime(2026, 3, 26, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Leader Summary]",
        reports=[
            HostReport(
                host_name="gpu-03",
                host="10.0.0.3",
                success=True,
                metrics=HostMetrics(
                    gpu_summary=[
                        GPUSummaryRow(
                            index=0,
                            name="NVIDIA A100",
                            utilization_percent=92,
                            temperature_c=70,
                            memory_used_mb=20480,
                            memory_total_mb=40960,
                        ),
                        GPUSummaryRow(
                            index=1,
                            name="NVIDIA A100",
                            utilization_percent=15,
                            temperature_c=45,
                            memory_used_mb=10240,
                            memory_total_mb=40960,
                        ),
                    ]
                ),
            )
        ],
    )

    rendered = render_report(report, variant="executive")

    assert "已用 30.0 GiB / 80.0 GiB (37.5%)" in rendered.text_body
    assert "GPU0 92%" not in rendered.text_body


def test_render_executive_report_shows_concise_error_messages_in_risk_summary():
    report = DailyReport(
        generated_at=datetime(2026, 3, 26, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Leader Summary]",
        reports=[
            HostReport(
                host_name="8-a100",
                host="10.0.0.8",
                success=True,
                metrics=HostMetrics(),
                errors=[
                    HostCollectionError(stage="gpu_summary", message="nvidia-smi missing"),
                    HostCollectionError(stage="gpu_processes", message="dcgm unavailable"),
                ],
            )
        ],
    )

    rendered = render_report(report, variant="executive")

    assert "8-a100：采集异常：nvidia-smi missing；dcgm unavailable" in rendered.text_body
    assert "存在 2 项采集异常" not in rendered.text_body


def test_render_daily_report_includes_service_checks():
    report = DailyReport(
        generated_at=datetime(2026, 3, 26, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(),
                checks=[
                    HostCheckResult(
                        name="Web 服务",
                        type="http",
                        target="http://10.0.0.1:8080/health",
                        status="ok",
                        message="HTTP 200",
                        latency_ms=12.0,
                    ),
                    HostCheckResult(
                        name="数据库",
                        type="tcp",
                        target="10.0.0.1:5432",
                        status="failed",
                        message="连接超时",
                        latency_ms=None,
                    ),
                ],
            )
        ],
    )

    rendered = render_report(report)

    assert "1/2" in rendered.text_body
    assert "数据库" in rendered.text_body
    assert "连接超时" in rendered.text_body
    assert "服务检查" in rendered.html_body
    assert "数据库" in rendered.html_body
