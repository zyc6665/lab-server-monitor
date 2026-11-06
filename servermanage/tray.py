"""Optional system-tray integration.

The tray is a *convenience* layer on top of the long-running web dashboard.  It
is only fully available on Windows with the optional ``pystray`` and ``Pillow``
dependencies installed; everywhere else :func:`tray_available` returns
``False`` and :func:`start_tray` returns ``None`` so the console/service keeps
running exactly as before.  Nothing in this module may ever raise into the main
service: every failure is logged and downgraded to "no tray".
"""

from __future__ import annotations

import logging
import os
import sys
import threading
from pathlib import Path
from typing import Any, Callable

from servermanage.runtime import open_browser

__all__ = ["TrayHandle", "tray_available", "start_tray"]

LOGGER = logging.getLogger(__name__)


def tray_available() -> bool:
    """Return ``True`` only on Windows when pystray and Pillow import cleanly."""
    if sys.platform != "win32":
        return False
    try:
        import pystray  # noqa: F401  (imported only to probe availability)
        from PIL import Image  # noqa: F401
    except Exception:  # noqa: BLE001 - missing optional dependency is expected
        return False
    return True


class TrayHandle:
    """Handle to a running tray icon and its daemon thread."""

    def __init__(self, *, icon: Any, thread: threading.Thread | None) -> None:
        self.icon = icon
        self.thread = thread
        self._stopped = False

    def stop(self) -> None:
        """Stop the icon and join its thread.  Idempotent and never raises."""
        if self._stopped:
            return
        self._stopped = True
        try:
            self.icon.stop()
        except Exception:  # noqa: BLE001 - shutdown must not raise
            LOGGER.exception("Failed to stop system tray icon")
        if self.thread is not None and self.thread.is_alive():
            try:
                self.thread.join(timeout=5)
            except Exception:  # noqa: BLE001
                LOGGER.exception("Failed to join system tray thread")


def _open_directory(path: Path) -> None:
    """Open *path* in the platform file manager."""
    target = str(path)
    if sys.platform == "win32":
        os.startfile(target)  # type: ignore[attr-defined]  # noqa: S606
    elif sys.platform == "darwin":  # pragma: no cover - macOS only
        import subprocess

        subprocess.Popen(["open", target])
    else:  # pragma: no cover - Linux only
        import subprocess

        subprocess.Popen(["xdg-open", target])


def _build_image() -> Any:
    """Draw the tray icon (a small blue monitor glyph)."""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.ellipse((2, 2, 62, 62), fill=(31, 111, 235, 255))
    draw.rectangle((16, 22, 48, 27), fill=(255, 255, 255, 255))
    draw.rectangle((16, 32, 48, 37), fill=(255, 255, 255, 255))
    draw.rectangle((16, 42, 34, 47), fill=(255, 255, 255, 255))
    return image


def start_tray(
    *,
    url: str,
    log_dir: Path | str,
    on_exit: Callable[[], None] | None,
    enabled: bool = True,
) -> TrayHandle | None:
    """Start the system tray icon on a daemon thread.

    Returns a :class:`TrayHandle` when the icon is running, or ``None`` when the
    tray is disabled, unavailable, or failed to start.  This function never
    raises: an unavailable tray must not disturb the web service.
    """
    if not enabled:
        return None
    try:
        if not tray_available():
            LOGGER.info("System tray unavailable; continuing without a tray icon")
            return None

        import pystray

        log_path = Path(log_dir)

        def _open_dashboard(icon: Any = None, item: Any = None) -> None:
            try:
                open_browser(url)
            except Exception:  # noqa: BLE001 - menu callback must not crash
                LOGGER.exception("Failed to open dashboard from tray")

        def _open_logs(icon: Any = None, item: Any = None) -> None:
            try:
                log_path.mkdir(parents=True, exist_ok=True)
                _open_directory(log_path)
            except Exception:  # noqa: BLE001
                LOGGER.exception("Failed to open log directory from tray")

        def _quit(icon: Any, item: Any = None) -> None:
            try:
                if on_exit is not None:
                    on_exit()
            except Exception:  # noqa: BLE001
                LOGGER.exception("Tray on_exit callback failed")
            finally:
                try:
                    icon.stop()
                except Exception:  # noqa: BLE001
                    LOGGER.exception("Failed to stop tray icon")

        menu = pystray.Menu(
            pystray.MenuItem("打开看板", _open_dashboard, default=True),
            pystray.MenuItem("打开日志目录", _open_logs),
            pystray.MenuItem("退出", _quit),
        )
        icon = pystray.Icon("servermonitor", _build_image(), "服务器监控", menu)
        thread = threading.Thread(
            target=icon.run, name="servermonitor-tray", daemon=True
        )
        thread.start()
        return TrayHandle(icon=icon, thread=thread)
    except Exception:  # noqa: BLE001 - tray must never break the service
        LOGGER.exception("Failed to start system tray")
        return None
