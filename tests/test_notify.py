from __future__ import annotations

import json
import sys
import types

from servermanage import alerts as alerts_module
from servermanage import notify_desktop
from servermanage.alerts import Notifier
from servermanage.disk_health import AlertEvent
from servermanage.models import AlertsConfig, SMTPConfig, WebhookConfig
from servermanage.notify_webhook import build_webhook_payload, send_webhook


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _event(
    *,
    host_name: str = "gpu-01",
    category: str = "system",
    severity: str = "warning",
    title: str = "CPU 使用率过高",
    message: str = "CPU 95.0% 达到阈值 90%",
) -> AlertEvent:
    return AlertEvent(
        host_name=host_name,
        category=category,
        severity=severity,
        title=title,
        message=message,
        fingerprint=f"system:{host_name}:cpu",
    )


def _smtp() -> SMTPConfig:
    return SMTPConfig(
        host="smtp.example.com",
        port=25,
        username="monitor@example.com",
        password="secret",
        use_ssl=False,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )


class FakeResponse:
    def __init__(self, status: int = 200) -> None:
        self.status = status
        self.closed = False

    def getcode(self) -> int:
        return self.status

    def close(self) -> None:
        self.closed = True


class JsonFakeResponse(FakeResponse):
    def __init__(self, status: int, payload: dict) -> None:
        super().__init__(status)
        self.payload = payload

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class RecordingOpener:
    """Fake ``urlopen`` that records the request and returns a fixed response."""

    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[tuple[object, float | None]] = []

    def __call__(self, request, timeout=None):
        self.calls.append((request, timeout))
        return self.response


class RaisingOpener:
    def __call__(self, request, timeout=None):
        raise OSError("connection refused")


# ---------------------------------------------------------------------------
# Webhook payload shapes
# ---------------------------------------------------------------------------

def test_webhook_payload_wecom():
    payload = build_webhook_payload("wecom", _event())
    assert payload["msgtype"] == "text"
    assert set(payload["text"]) == {"content"}
    content = payload["text"]["content"]
    assert "warning" in content
    assert "CPU 使用率过高" in content
    assert "CPU 95.0% 达到阈值 90%" in content
    assert "gpu-01" in content


def test_webhook_payload_dingtalk():
    payload = build_webhook_payload("dingtalk", _event())
    assert payload["msgtype"] == "text"
    assert set(payload["text"]) == {"content"}
    content = payload["text"]["content"]
    assert "warning" in content
    assert "CPU 使用率过高" in content
    assert "gpu-01" in content


def test_webhook_payload_feishu():
    payload = build_webhook_payload("feishu", _event())
    assert payload["msg_type"] == "text"
    assert set(payload["content"]) == {"text"}
    content = payload["content"]["text"]
    assert "warning" in content
    assert "CPU 使用率过高" in content
    assert "gpu-01" in content


def test_webhook_payload_generic():
    payload = build_webhook_payload("generic", _event())
    assert payload["host"] == "gpu-01"
    assert payload["severity"] == "warning"
    assert payload["title"] == "CPU 使用率过高"
    assert payload["message"] == "CPU 95.0% 达到阈值 90%"
    assert payload["timestamp"]


def test_webhook_payload_unknown_kind_treated_as_generic():
    payload = build_webhook_payload("slack", _event())
    assert payload["host"] == "gpu-01"
    assert payload["severity"] == "warning"


# ---------------------------------------------------------------------------
# Webhook transport
# ---------------------------------------------------------------------------

def test_send_webhook_posts_json():
    opener = RecordingOpener(FakeResponse(200))
    config = WebhookConfig(
        enabled=True, type="generic", url="https://example.com/hook", url_env=None
    )

    ok = send_webhook(config, _event(), opener=opener)

    assert ok is True
    request, timeout = opener.calls[0]
    assert request.full_url == "https://example.com/hook"
    assert request.get_method() == "POST"
    assert request.get_header("Content-type") == "application/json"
    body = json.loads(request.data.decode("utf-8"))
    assert body["host"] == "gpu-01"
    assert body["severity"] == "warning"
    assert timeout is not None and timeout > 0


def test_send_webhook_feishu_success_reads_code_zero():
    opener = RecordingOpener(JsonFakeResponse(200, {"code": 0, "msg": "success"}))
    config = WebhookConfig(enabled=True, type="feishu", url="https://open.feishu.cn/hook", url_env=None)
    assert send_webhook(config, _event(), opener=opener) is True


def test_send_webhook_feishu_application_error_returns_false():
    opener = RecordingOpener(JsonFakeResponse(200, {"code": 9499, "msg": "Bad Request"}))
    config = WebhookConfig(enabled=True, type="feishu", url="https://open.feishu.cn/hook", url_env=None)
    assert send_webhook(config, _event(), opener=opener) is False


def test_send_webhook_wecom_errcode_error_returns_false():
    opener = RecordingOpener(JsonFakeResponse(200, {"errcode": 40013, "errmsg": "invalid corpid"}))
    config = WebhookConfig(enabled=True, type="wecom", url="https://qyapi.weixin.qq.com/hook", url_env=None)
    assert send_webhook(config, _event(), opener=opener) is False


def test_send_webhook_reads_url_from_env(monkeypatch):
    monkeypatch.setenv("TEST_ALERT_HOOK_URL", "https://env.example/hook")
    opener = RecordingOpener(FakeResponse(200))
    config = WebhookConfig(
        enabled=True, type="wecom", url=None, url_env="TEST_ALERT_HOOK_URL"
    )

    assert send_webhook(config, _event(), opener=opener) is True
    assert opener.calls[0][0].full_url == "https://env.example/hook"


def test_send_webhook_missing_url_returns_false(monkeypatch):
    monkeypatch.delenv("ALERT_WEBHOOK_URL", raising=False)
    opener = RecordingOpener(FakeResponse(200))
    config = WebhookConfig(
        enabled=True, type="wecom", url=None, url_env="ALERT_WEBHOOK_URL"
    )

    assert send_webhook(config, _event(), opener=opener) is False
    assert opener.calls == []


def test_send_webhook_returns_false_on_network_error():
    opener = RaisingOpener()
    config = WebhookConfig(
        enabled=True, type="wecom", url="https://example.com/hook", url_env=None
    )

    assert send_webhook(config, _event(), opener=opener) is False


def test_send_webhook_non_2xx_returns_false():
    opener = RecordingOpener(FakeResponse(500))
    config = WebhookConfig(
        enabled=True, type="wecom", url="https://example.com/hook", url_env=None
    )

    assert send_webhook(config, _event(), opener=opener) is False


# ---------------------------------------------------------------------------
# Desktop channel
# ---------------------------------------------------------------------------

def test_desktop_falls_back_to_powershell(monkeypatch):
    monkeypatch.setitem(sys.modules, "winotify", None)  # force ImportError

    recorded: dict[str, object] = {}

    class Result:
        returncode = 0

    def fake_run(args, **kwargs):
        recorded["args"] = args
        recorded["kwargs"] = kwargs
        return Result()

    monkeypatch.setattr(notify_desktop.subprocess, "run", fake_run)

    assert notify_desktop.send_desktop_notification("标题", "内容") is True
    args = recorded["args"]
    assert any("powershell" in str(part).lower() for part in args)
    assert recorded["kwargs"].get("timeout")


def test_desktop_uses_winotify_when_available(monkeypatch):
    shown: dict[str, object] = {}

    class FakeNotification:
        def __init__(self, **kwargs):
            shown["init"] = kwargs

        def show(self):
            shown["shown"] = True

    fake_module = types.SimpleNamespace(Notification=FakeNotification)
    monkeypatch.setitem(sys.modules, "winotify", fake_module)

    assert notify_desktop.send_desktop_notification("标题", "内容") is True
    assert shown.get("shown") is True
    assert shown["init"]["title"] == "标题"


def test_desktop_returns_false_when_powershell_fails(monkeypatch):
    monkeypatch.setitem(sys.modules, "winotify", None)

    class Result:
        returncode = 1

    monkeypatch.setattr(notify_desktop.subprocess, "run", lambda *a, **k: Result())

    assert notify_desktop.send_desktop_notification("标题", "内容") is False


# ---------------------------------------------------------------------------
# Composite notifier
# ---------------------------------------------------------------------------

def test_notifier_dispatches_enabled_channels(monkeypatch):
    calls: list[str] = []

    def fake_desktop(title, message):
        calls.append("desktop")
        return True

    def fake_send_report(smtp, report, **kwargs):
        calls.append("email")

    monkeypatch.setattr(alerts_module, "send_desktop_notification", fake_desktop)
    monkeypatch.setattr(alerts_module, "send_report", fake_send_report)

    notifier = Notifier(smtp=_smtp())
    config = AlertsConfig(
        desktop_notification=True,
        email=True,
        webhook=WebhookConfig(enabled=False),
    )

    assert notifier.dispatch(_event(), config) == ["desktop", "email"]
    assert calls == ["desktop", "email"]


def test_notifier_skips_email_when_smtp_none(monkeypatch):
    monkeypatch.setattr(alerts_module, "send_desktop_notification", lambda t, m: True)

    def fail(*args, **kwargs):
        raise AssertionError("send_report must not be called when smtp is None")

    monkeypatch.setattr(alerts_module, "send_report", fail)

    notifier = Notifier(smtp=None)
    config = AlertsConfig(
        desktop_notification=True,
        email=True,
        webhook=WebhookConfig(enabled=False),
    )

    assert notifier.dispatch(_event(), config) == ["desktop"]


def test_notifier_isolates_channel_failure(monkeypatch):
    def fail_desktop(title, message):
        raise RuntimeError("toast subsystem exploded")

    monkeypatch.setattr(alerts_module, "send_desktop_notification", fail_desktop)
    monkeypatch.setattr(alerts_module, "send_report", lambda *a, **k: None)

    notifier = Notifier(smtp=_smtp())
    config = AlertsConfig(
        desktop_notification=True,
        email=True,
        webhook=WebhookConfig(enabled=False),
    )

    assert notifier.dispatch(_event(), config) == ["email"]


def test_notifier_all_fail_returns_empty(monkeypatch):
    monkeypatch.setattr(alerts_module, "send_desktop_notification", lambda t, m: False)

    def fail(*args, **kwargs):
        raise RuntimeError("smtp down")

    monkeypatch.setattr(alerts_module, "send_report", fail)

    notifier = Notifier(smtp=_smtp())
    config = AlertsConfig(
        desktop_notification=True,
        email=True,
        webhook=WebhookConfig(enabled=True, url="https://h", url_env=None),
    )

    # webhook is also stubbed to fail
    monkeypatch.setattr(alerts_module, "send_webhook", lambda c, e: False)

    assert notifier.dispatch(_event(), config) == []


def test_notifier_disabled_channels_do_no_io(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError("no I/O expected for disabled channels")

    monkeypatch.setattr(alerts_module, "send_desktop_notification", boom)
    monkeypatch.setattr(alerts_module, "send_report", boom)
    monkeypatch.setattr(alerts_module, "send_webhook", boom)

    notifier = Notifier(smtp=_smtp())
    config = AlertsConfig(
        desktop_notification=False,
        email=False,
        webhook=WebhookConfig(enabled=False),
    )

    assert notifier.dispatch(_event(), config) == []


def test_notifier_dispatches_webhook_when_enabled(monkeypatch):
    seen: dict[str, object] = {}

    def fake_webhook(webhook_config, event):
        seen["config"] = webhook_config
        seen["event"] = event
        return True

    monkeypatch.setattr(alerts_module, "send_webhook", fake_webhook)

    hook = WebhookConfig(enabled=True, type="wecom", url="https://h", url_env=None)
    notifier = Notifier(smtp=None)
    config = AlertsConfig(
        desktop_notification=False, email=False, webhook=hook
    )

    assert notifier.dispatch(_event(), config) == ["webhook"]
    assert seen["config"] is hook


def test_notifier_email_builds_readable_report(monkeypatch):
    captured: dict[str, object] = {}

    def fake_send_report(smtp, report, **kwargs):
        captured["smtp"] = smtp
        captured["report"] = report

    monkeypatch.setattr(alerts_module, "send_report", fake_send_report)

    smtp = _smtp()
    notifier = Notifier(smtp=smtp)
    config = AlertsConfig(
        desktop_notification=False,
        email=True,
        webhook=WebhookConfig(enabled=False),
    )

    assert notifier.dispatch(_event(), config) == ["email"]
    report = captured["report"]
    assert captured["smtp"] is smtp
    assert "CPU 使用率过高" in report.subject
    assert "gpu-01" in report.text_body
    assert "warning" in report.text_body


def test_notifier_webhook_exception_isolated(monkeypatch):
    def boom(webhook_config, event):
        raise RuntimeError("webhook exploded")

    monkeypatch.setattr(alerts_module, "send_webhook", boom)
    monkeypatch.setattr(alerts_module, "send_desktop_notification", lambda t, m: True)

    notifier = Notifier(smtp=None)
    config = AlertsConfig(
        desktop_notification=True,
        email=False,
        webhook=WebhookConfig(enabled=True, url="https://h", url_env=None),
    )

    assert notifier.dispatch(_event(), config) == ["desktop"]
