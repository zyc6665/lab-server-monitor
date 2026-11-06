"""Runtime helpers for the desktop app: single-instance lock, port probing,
runtime-state file and browser launching.

Windows is the primary runtime.  Single-instance enforcement uses a named
Win32 mutex (``CreateMutexW``) whose name is derived from the absolute lock
path, so two copies launched from the same data directory cannot both run.
On POSIX the same contract is implemented with ``fcntl.flock`` on the lock
file.  Only :mod:`ctypes` is used on Windows — no ``win32api`` dependency.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import os
import socket
import sys
import tempfile
import webbrowser
from pathlib import Path
from typing import Any

__all__ = [
    "InstanceLock",
    "acquire_single_instance",
    "find_available_port",
    "write_runtime_state",
    "read_runtime_state",
    "open_browser",
]

# GetLastError() value returned when the named mutex already existed.
_ERROR_ALREADY_EXISTS = 183


class InstanceLock:
    """Handle returned by :func:`acquire_single_instance`.

    ``acquired`` is ``True`` only when this object owns the lock.  ``release``
    is idempotent and safe to call on a lock that was never acquired.
    """

    def __init__(
        self,
        *,
        acquired: bool,
        path: Path | None = None,
        handle: Any = None,
        fd: int | None = None,
    ) -> None:
        self.acquired = acquired
        self._path = path
        self._handle = handle
        self._fd = fd

    def release(self) -> None:
        """Release the lock (close the mutex handle / unlock and close the file)."""
        if not self.acquired:
            return
        if sys.platform == "win32":
            if self._handle:
                _kernel32().CloseHandle(self._handle)
            self._handle = None
        else:
            if self._fd is not None:
                try:
                    import fcntl

                    fcntl.flock(self._fd, fcntl.LOCK_UN)
                except OSError:
                    pass
                try:
                    os.close(self._fd)
                except OSError:
                    pass
            self._fd = None
        self.acquired = False

    def __enter__(self) -> "InstanceLock":
        return self

    def __exit__(self, *exc: object) -> bool:
        self.release()
        return False

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"InstanceLock(acquired={self.acquired!r}, path={self._path!r})"


def _kernel32() -> Any:
    """Return the kernel32 bindings (lazily; only valid on Windows)."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [
        ctypes.c_void_p,  # lpMutexAttributes
        ctypes.c_bool,  # bInitialOwner
        ctypes.c_wchar_p,  # lpName
    ]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_bool
    return kernel32


def _mutex_name(lock_path: Path) -> str:
    """Build ``Local\\ServerMonitor-<hash>`` from the absolute lock path."""
    resolved = Path(os.path.abspath(lock_path))
    key = str(resolved)
    if sys.platform == "win32":
        key = os.path.normcase(key)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:32]
    return f"Local\\ServerMonitor-{digest}"


def acquire_single_instance(lock_path: Path | os.PathLike[str]) -> InstanceLock:
    """Try to become the single running instance.

    Creates the parent directory of *lock_path* if needed.  Returns an
    :class:`InstanceLock` whose ``acquired`` attribute tells whether the lock
    was obtained; on contention it is ``False`` and the caller should exit.
    """
    path = Path(lock_path).expanduser()
    if path.parent and not path.parent.exists():
        path.parent.mkdir(parents=True, exist_ok=True)

    if sys.platform == "win32":
        return _acquire_windows(path)
    return _acquire_posix(path)


def _acquire_windows(path: Path) -> InstanceLock:
    kernel32 = _kernel32()
    name = _mutex_name(path)
    ctypes.set_last_error(0)
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        return InstanceLock(acquired=False, path=path)
    if ctypes.get_last_error() == _ERROR_ALREADY_EXISTS:
        # Another instance already holds the named mutex; drop our handle.
        kernel32.CloseHandle(handle)
        return InstanceLock(acquired=False, path=path)
    return InstanceLock(acquired=True, path=path, handle=handle)


def _acquire_posix(path: Path) -> InstanceLock:
    import fcntl

    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return InstanceLock(acquired=False, path=path)
    return InstanceLock(acquired=True, path=path, fd=fd)


def find_available_port(host: str, preferred: int, span: int = 20) -> int:
    """Return the first bindable TCP port in ``[preferred, preferred + span)``.

    ``span`` is the number of consecutive candidates to probe.  Raises
    :class:`OSError` when every candidate in the window is occupied.
    """
    last_error: OSError | None = None
    for port in range(preferred, preferred + span):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((host, port))
            except OSError as exc:
                last_error = exc
                continue
            return port
    raise OSError(
        f"No available port in {preferred}-{preferred + span - 1} on {host!r}"
        f" (last error: {last_error})"
    )


def write_runtime_state(
    path: Path | os.PathLike[str],
    *,
    url: str,
    port: int,
    pid: int | None = None,
) -> None:
    """Atomically write the runtime state JSON (UTF-8) to *path*."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {"url": url, "port": port, "pid": pid}

    fd, tmp_name = tempfile.mkstemp(
        prefix=target.name + ".", suffix=".tmp", dir=str(target.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_runtime_state(path: Path | os.PathLike[str]) -> dict[str, Any] | None:
    """Read runtime state JSON; return ``None`` if missing or invalid."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def open_browser(url: str) -> bool:
    """Open *url* in the default browser; return ``True`` on success."""
    try:
        return bool(webbrowser.open(url))
    except Exception:  # noqa: BLE001 - launching a browser must never crash the app
        return False
