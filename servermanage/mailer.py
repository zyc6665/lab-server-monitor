from __future__ import annotations

import logging
import smtplib
import time
from email.message import EmailMessage

from servermanage.models import RenderedReport, SMTPConfig

LOGGER = logging.getLogger(__name__)


def build_message(
    *,
    subject: str,
    from_addr: str,
    to_addrs: list[str],
    text_body: str,
    html_body: str,
) -> EmailMessage:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = from_addr
    message["To"] = ", ".join(to_addrs)
    message.set_content(text_body)
    message.add_alternative(html_body, subtype="html")
    return message


def _build_client_factory(smtp: SMTPConfig, smtp_factory, smtp_ssl_factory):
    if smtp.use_ssl:
        return (
            (lambda: smtp_ssl_factory(smtp.host, smtp.port, timeout=30))
            if smtp_ssl_factory is smtplib.SMTP_SSL
            else (lambda: smtp_ssl_factory(smtp.host, smtp.port))
        )

    return (
        (lambda: smtp_factory(smtp.host, smtp.port, timeout=30))
        if smtp_factory is smtplib.SMTP
        else (lambda: smtp_factory(smtp.host, smtp.port))
    )


def _send_once(smtp: SMTPConfig, message: EmailMessage, smtp_factory, smtp_ssl_factory) -> None:
    client_factory = _build_client_factory(smtp, smtp_factory, smtp_ssl_factory)
    with client_factory() as client:
        if not smtp.use_ssl:
            client.starttls()
        client.login(smtp.username, smtp.password)
        client.send_message(message)


def send_report(
    smtp: SMTPConfig,
    report: RenderedReport,
    *,
    to_addrs: list[str] | None = None,
    smtp_factory=None,
    smtp_ssl_factory=None,
    max_attempts: int = 3,
    retry_delay_seconds: int = 3,
    sleep_func=time.sleep,
) -> None:
    message = build_message(
        subject=report.subject,
        from_addr=smtp.from_addr,
        to_addrs=to_addrs or smtp.to_addrs,
        text_body=report.text_body,
        html_body=report.html_body,
    )

    smtp_factory = smtp_factory or smtplib.SMTP
    smtp_ssl_factory = smtp_ssl_factory or smtplib.SMTP_SSL
    attempts = max(1, max_attempts)

    for attempt in range(1, attempts + 1):
        try:
            _send_once(smtp, message, smtp_factory, smtp_ssl_factory)
            return
        except smtplib.SMTPAuthenticationError:
            raise
        except (OSError, TimeoutError, smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError) as exc:
            if attempt >= attempts:
                raise
            sleep_seconds = retry_delay_seconds * attempt
            LOGGER.warning(
                "SMTP send attempt %s/%s failed: %s. Retrying in %s seconds.",
                attempt,
                attempts,
                exc,
                sleep_seconds,
            )
            sleep_func(sleep_seconds)
