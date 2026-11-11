"""v0.1.113：服务检查「只看异常」筛选。"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.models import HostCheckResult
from servermanage.storage import init_storage, save_host_check_results
from servermanage.web import create_app

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
TEMPLATES = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "templates"


def _config():
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "a100-zyc",
                    "host": "202.119.189.245",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def _client(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    init_storage(db_path)
    results = [
        HostCheckResult(name="SSH 22", type="tcp", target=":22", status="ok", message="", latency_ms=3.0),
        HostCheckResult(
            name="nginx",
            type="http",
            target="http://127.0.0.1/",
            status="error",
            message="502",
            latency_ms=12.0,
        ),
    ]
    save_host_check_results("a100-zyc", results, db_path)
    app = create_app(config=_config(), db_path=db_path)
    app.config.update(TESTING=True)
    client = app.test_client()
    with client.session_transaction() as session:
        session["logged_in"] = True
        session["username"] = "tester"
        session["csrf_token"] = "token"
    return client


def test_template_has_filter_toggle(tmp_path: Path):
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)
    assert 'id="host-checks-only-bad"' in html
    assert "只看异常" in html


def test_rows_carry_status_for_filtering(tmp_path: Path):
    html = _client(tmp_path).get("/host/a100-zyc").get_data(as_text=True)
    assert 'data-check-status="ok"' in html
    assert 'data-check-status="error"' in html


def test_script_filters_and_reports_counts():
    script = (STATIC / "host-detail.js").read_text(encoding="utf-8")
    assert "function applyCheckFilter()" in script
    assert "row.hidden = onlyBad && !bad;" in script
    assert "'只看异常：' + (total - hidden) + ' / ' + total + ' 项'" in script
    assert "bindCheckFilter();" in script


def test_styles_cover_filter_toggle():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.113 服务检查只看异常")[1]
    assert ".checks-filter {" in tail
    assert "#host-checks-body tr[hidden] { display: none !important; }" in tail


def test_template_has_no_inline_filter_logic():
    html = (TEMPLATES / "host.html").read_text(encoding="utf-8")
    assert "host-checks-only-bad" in html
