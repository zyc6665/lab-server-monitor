import smtplib
import socket

from servermanage.mailer import build_message, send_report
from servermanage.models import RenderedReport, SMTPConfig


class FakeSMTP:
    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.logged_in = None
        self.sent_message = None
        self.started_tls = False

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def starttls(self):
        self.started_tls = True

    def login(self, username, password):
        self.logged_in = (username, password)

    def send_message(self, message):
        self.sent_message = message


class FailingAuthSMTP(FakeSMTP):
    def login(self, username, password):
        raise smtplib.SMTPAuthenticationError(535, b"auth failed")


def test_build_message_creates_multipart_alternative():
    message = build_message(
        subject="daily",
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
        text_body="plain",
        html_body="<html><body>html</body></html>",
    )
    assert message.get_content_type() == "multipart/alternative"


def test_send_report_uses_ssl_client():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=465,
        username="monitor@example.com",
        password="secret",
        use_ssl=True,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    fake = FakeSMTP("smtp.example.com", 465)

    send_report(smtp, report, smtp_ssl_factory=lambda host, port: fake)

    assert fake.logged_in == ("monitor@example.com", "secret")
    assert fake.sent_message["To"] == "ops@example.com"


def test_send_report_uses_starttls_client():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=587,
        username="monitor@example.com",
        password="secret",
        use_ssl=False,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    fake = FakeSMTP("smtp.example.com", 587)

    send_report(smtp, report, smtp_factory=lambda host, port: fake)

    assert fake.started_tls is True
    assert fake.logged_in == ("monitor@example.com", "secret")
    assert fake.sent_message["To"] == "ops@example.com"


def test_send_report_retries_ssl_network_failure_and_succeeds():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=465,
        username="monitor@example.com",
        password="secret",
        use_ssl=True,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    fake = FakeSMTP("smtp.example.com", 465)
    attempts = {"count": 0}
    sleeps: list[int] = []

    def flaky_factory(host, port):
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise socket.gaierror(-3, "Temporary failure in name resolution")
        return fake

    send_report(
        smtp,
        report,
        smtp_ssl_factory=flaky_factory,
        sleep_func=lambda seconds: sleeps.append(seconds),
    )

    assert attempts["count"] == 2
    assert sleeps == [3]
    assert fake.sent_message["To"] == "ops@example.com"


def test_send_report_raises_after_retry_exhausted():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=465,
        username="monitor@example.com",
        password="secret",
        use_ssl=True,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    attempts = {"count": 0}
    sleeps: list[int] = []

    def failing_factory(host, port):
        attempts["count"] += 1
        raise TimeoutError("timed out")

    try:
        send_report(
            smtp,
            report,
            smtp_ssl_factory=failing_factory,
            sleep_func=lambda seconds: sleeps.append(seconds),
        )
    except TimeoutError:
        pass
    else:  # pragma: no cover - defensive
        raise AssertionError("Expected TimeoutError to be raised")

    assert attempts["count"] == 3
    assert sleeps == [3, 6]


def test_send_report_does_not_retry_auth_failure():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=465,
        username="monitor@example.com",
        password="secret",
        use_ssl=True,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    attempts = {"count": 0}

    def auth_factory(host, port):
        attempts["count"] += 1
        return FailingAuthSMTP(host, port)

    try:
        send_report(smtp, report, smtp_ssl_factory=auth_factory, sleep_func=lambda _seconds: None)
    except smtplib.SMTPAuthenticationError:
        pass
    else:  # pragma: no cover - defensive
        raise AssertionError("Expected SMTPAuthenticationError to be raised")

    assert attempts["count"] == 1


def test_send_report_uses_explicit_recipient_override():
    report = RenderedReport(subject="daily", text_body="plain", html_body="<html></html>")
    smtp = SMTPConfig(
        host="smtp.example.com",
        port=465,
        username="monitor@example.com",
        password="secret",
        use_ssl=True,
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
    )
    fake = FakeSMTP("smtp.example.com", 465)

    send_report(
        smtp,
        report,
        to_addrs=["leader@example.com"],
        smtp_ssl_factory=lambda host, port: fake,
    )

    assert fake.sent_message["To"] == "leader@example.com"
