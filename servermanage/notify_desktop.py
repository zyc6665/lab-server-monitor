"""Windows desktop toast notifications for the PC polling monitor.

The toast is delivered through :mod:`winotify` when available.  Because the
project also runs (and its test-suite executes) on non-Windows machines, the
``winotify`` import is deliberately **lazy**: importing this module must never
fail just because the GUI stack is absent.  When ``winotify`` is missing or
raises, we fall back to a PowerShell WinRT toast, which is the same mechanism
``winotify`` uses under the hood.

The public :func:`send_desktop_notification` never raises: it returns ``True``
only when a toast was actually shown and ``False`` otherwise, so the composite
notifier can treat a desktop failure as one isolated channel failure.
"""

from __future__ import annotations

import logging
import subprocess
from xml.sax.saxutils import escape as _xml_escape

LOGGER = logging.getLogger(__name__)

__all__ = ["send_desktop_notification"]

# Keep the toast attempt bounded; a stuck PowerShell must never hang a poll.
_POWERSHELL_TIMEOUT_SECONDS = 15

# Single-quote escaping for the PowerShell string literals we interpolate.
_PS_QUOTE_MAP = {"'": "''", "\u2018": "''", "\u2019": "''"}

_TOAST_SCRIPT_TEMPLATE = (
    "$ErrorActionPreference = 'Stop';"
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, "
    "ContentType = WindowsRuntime] > $null;"
    "$template = "
    "[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent("
    "[Windows.UI.Notifications.ToastTemplateType]::ToastText02);"
    "$texts = $template.GetElementsByTagName('text');"
    "($texts.Item(0)).AppendChild($template.CreateTextNode('{title}')) > $null;"
    "($texts.Item(1)).AppendChild($template.CreateTextNode('{message}')) > $null;"
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($template);"
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
    "'服务器监测').Show($toast);"
)


def _ps_literal(value: str) -> str:
    """Return *value* safe to embed inside a single-quoted PowerShell string."""
    text = "" if value is None else str(value)
    return _xml_escape(text).translate(_PS_QUOTE_MAP)


def _build_powershell_script(title: str, message: str) -> str:
    return _TOAST_SCRIPT_TEMPLATE.format(
        title=_ps_literal(title), message=_ps_literal(message)
    )


def _send_via_powershell(title: str, message: str) -> bool:
    """Show a toast through a PowerShell WinRT script; ``False`` on any error."""
    script = _build_powershell_script(title, message)
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            capture_output=True,
            timeout=_POWERSHELL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        LOGGER.warning("PowerShell desktop toast failed: %s", exc)
        return False
    if result.returncode != 0:
        LOGGER.warning(
            "PowerShell desktop toast exited with code %s", result.returncode
        )
        return False
    return True


def _send_via_winotify(title: str, message: str) -> bool:
    """Show a toast through ``winotify``; raises on any problem."""
    # Lazy import: keeps this module importable on non-Windows / test hosts.
    from winotify import Notification  # type: ignore

    notification = Notification(
        app_id="服务器监测",
        title=title,
        msg=message,
        duration="short",
    )
    notification.show()
    return True


def send_desktop_notification(title: str, message: str) -> bool:
    """Show a desktop toast, preferring ``winotify`` and falling back to PowerShell.

    Returns ``True`` when either path reports success, ``False`` otherwise.
    This function never raises.
    """
    try:
        return _send_via_winotify(title, message)
    except Exception as exc:  # noqa: BLE001 - any winotify failure => fallback
        LOGGER.debug("winotify unavailable/failed (%s); falling back to PowerShell", exc)
    try:
        return _send_via_powershell(title, message)
    except Exception as exc:  # noqa: BLE001 - desktop must never break dispatch
        LOGGER.warning("Desktop notification failed entirely: %s", exc)
        return False
