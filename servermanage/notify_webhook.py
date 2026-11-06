"""Webhook notification channels (WeCom / DingTalk / generic JSON).

WeCom (企业微信) and DingTalk (钉钉) robot webhooks must receive a specific
"text" payload; a generic webhook just receives a flat JSON object describing
the alert.  :func:`send_webhook` performs the HTTP POST with a bounded timeout
and never raises — it returns ``True`` only for a 2xx response so the composite
notifier can isolate a failing channel.

The webhook URL is resolved from ``config.url`` first and then from the
environment variable named by ``config.url_env``.  The config loader normalises
this already, but re-reading the env keeps the channel usable when constructed
directly (e.g. in tests or ad-hoc scripts).  Secrets are only ever read from
config/env; nothing secret is logged.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

from servermanage.disk_health import AlertEvent
from servermanage.models import WebhookConfig

LOGGER = logging.getLogger(__name__)

__all__ = ["build_webhook_payload", "send_webhook"]

# Channel kinds that share the "text/markdown-ish" robot payload shape.
_TEXT_KINDS = frozenset({"wecom", "dingtalk"})

# Network timeout so a dead endpoint can never hang the polling loop.
WEBHOOK_TIMEOUT_SECONDS = 10


def _now_iso() -> str:
    """Local, human-readable ISO-8601 timestamp for alert payloads."""
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _text_content(event: AlertEvent) -> str:
    """Readable text body shared by WeCom and DingTalk.

    Keeps the brief's ``[severity] title\\nmessage`` shape while also naming the
    host and stamping the time so a chat reader has full context.
    """
    return (
        f"[{event.severity}] {event.title}\n"
        f"主机: {event.host_name}\n"
        f"{event.message}\n"
        f"时间: {_now_iso()}"
    )


def build_webhook_payload(kind: str, event: AlertEvent) -> dict[str, Any]:
    """Build the JSON payload for *kind* from *event*.

    * ``wecom`` / ``dingtalk`` → ``{"msgtype": "text", "text": {"content": ...}}``
    * anything else → a flat ``{"host", "severity", "title", "message",
      "timestamp"}`` object.
    """
    normalized = (kind or "").strip().lower()
    if normalized in _TEXT_KINDS:
        return {"msgtype": "text", "text": {"content": _text_content(event)}}
    return {
        "host": event.host_name,
        "severity": event.severity,
        "title": event.title,
        "message": event.message,
        "timestamp": _now_iso(),
    }


def _resolve_url(config: WebhookConfig) -> str | None:
    if config.url:
        return config.url
    env_name = config.url_env
    if env_name:
        return os.getenv(env_name) or None
    return None


def _response_status(response: Any) -> int | None:
    status = getattr(response, "status", None)
    if status is None:
        getcode = getattr(response, "getcode", None)
        if callable(getcode):
            status = getcode()
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def send_webhook(
    config: WebhookConfig,
    event: AlertEvent,
    *,
    opener: Callable[..., Any] | None = None,
) -> bool:
    """POST the event to *config*'s webhook; return ``True`` on a 2xx reply.

    ``opener`` defaults to :func:`urllib.request.urlopen` and is injectable for
    tests.  Any failure (missing URL, bad config, network error, non-2xx) is
    logged at warning/debug level and yields ``False``; this function never
    raises.
    """
    url = _resolve_url(config)
    if not url:
        LOGGER.warning(
            "Webhook channel enabled but no URL configured (type=%s)",
            config.type,
        )
        return False

    try:
        payload = build_webhook_payload(config.type, event)
    except Exception:  # noqa: BLE001 - malformed event must not raise
        LOGGER.exception("Failed to build webhook payload")
        return False

    try:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        open_url = opener or urllib.request.urlopen
        response = open_url(request, timeout=WEBHOOK_TIMEOUT_SECONDS)
        try:
            status = _response_status(response)
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
    except urllib.error.HTTPError as exc:
        # HTTPError's str() embeds the URL (which may carry a token), so only
        # log the numeric status.
        LOGGER.warning("Webhook endpoint returned HTTP %s", exc.code)
        return False
    except Exception as exc:  # noqa: BLE001 - network must never break dispatch
        # Log only the exception type: messages can echo a token-bearing URL.
        LOGGER.warning("Webhook POST failed (%s)", type(exc).__name__)
        return False

    if status is not None and 200 <= status < 300:
        return True
    LOGGER.warning("Webhook endpoint returned non-2xx status: %s", status)
    return False
