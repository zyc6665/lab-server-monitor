from datetime import date, datetime, timezone

from servermanage.models import WeeklyHostSummary, WeeklyReport
from servermanage.report import render_svg_line_chart, render_report


def test_render_svg_line_chart_with_data():
    svg = render_svg_line_chart(
        [("2026-07-06", 10.0), ("2026-07-07", 50.0), ("2026-07-08", 30.0)],
        title="CPU",
    )
    assert "<svg" in svg
    assert "CPU" in svg
    assert "polyline" in svg


def test_render_svg_line_chart_with_insufficient_data():
    svg = render_svg_line_chart([("2026-07-06", 10.0)], title="CPU")
    assert "数据不足" in svg


def _make_weekly_report() -> WeeklyReport:
    summary = WeeklyHostSummary(
        host_name="host-a",
        host="10.0.0.1",
        sample_count=7,
        success_count=7,
        cpu_avg=50.0,
        cpu_max=80.0,
        cpu_min=20.0,
        memory_avg_percent=40.0,
        memory_max_percent=60.0,
        disk_avg_percent=30.0,
        disk_max_percent=35.0,
        gpu_util_avg=70.0,
        gpu_util_max=90.0,
        gpu_memory_avg_percent=50.0,
        gpu_memory_max_percent=70.0,
        load_avg=2.0,
        users_avg=3.0,
        processes_avg=120.0,
        daily_points=[
            {"day": "2026-07-06", "cpu_avg": 20.0, "memory_percent": 30.0, "gpu_util": 50.0},
            {"day": "2026-07-07", "cpu_avg": 60.0, "memory_percent": 45.0, "gpu_util": 80.0},
            {"day": "2026-07-08", "cpu_avg": 70.0, "memory_percent": 45.0, "gpu_util": 80.0},
        ],
        checks=[
            {
                "check_name": "Web 服务",
                "check_type": "http",
                "target": "http://10.0.0.1:8080/health",
                "status": "ok",
                "message": "HTTP 200",
                "latency_ms": 12.0,
            },
            {
                "check_name": "数据库",
                "check_type": "tcp",
                "target": "10.0.0.1:5432",
                "status": "failed",
                "message": "连接超时",
                "latency_ms": None,
            },
        ],
    )
    return WeeklyReport(
        generated_at=datetime.now(timezone.utc),
        week_start=date(2026, 7, 6),
        week_end=date(2026, 7, 12),
        summaries=[summary],
        busy_hosts=[summary],
        idle_hosts=[],
        subject_prefix="[Server Weekly Report]",
    )


def test_render_weekly_report():
    report = _make_weekly_report()
    rendered = render_report(report, variant="weekly")

    assert "2026-07-06 ~ 2026-07-12" in rendered.subject
    assert "host-a" in rendered.text_body
    assert "高频算力服务器" in rendered.text_body
    assert "服务检查" in rendered.text_body
    assert "1/2" in rendered.text_body
    assert rendered.html_body != ""
    assert "<svg" in rendered.html_body
    assert "host-a" in rendered.html_body
    assert "服务检查" in rendered.html_body
