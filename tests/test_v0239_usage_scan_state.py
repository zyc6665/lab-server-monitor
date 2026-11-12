from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIC = ROOT / "servermanage" / "web" / "static"


def test_payload_exposes_running_usage_scan():
    body = (ROOT / "servermanage" / "web" / "routes.py").read_text(encoding="utf-8")
    assert '"usage_scan": _usage_scan_state(current_app._get_current_object()),' in body
    assert "def _usage_scan_state(app: Any) -> dict[str, Any]:" in body
    assert 'return {"running": False}' in body


def test_frontend_announces_running_scan():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "renderUsageHint(data.usage_hint, data.usage_scan);" in js
    assert "正在统计 /home、/data 占用" in js
    assert "hint.classList.toggle('is-running', running);" in js


def test_style_marks_running_hint():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert ".usage-hint.is-running" in css
    assert 'html[data-theme="dark"] .usage-hint.is-running' in css
