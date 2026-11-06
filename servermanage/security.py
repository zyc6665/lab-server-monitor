"""Security primitives: DPAPI secret storage, password hashing, machine identity.

Windows 11 is the primary runtime. Secret blobs are protected with the
user-scoped DPAPI (CryptProtectData / CryptUnprotectData) so they can only be
read back by the same Windows user on the same machine. Password hashing uses
PBKDF2-HMAC-SHA256; passwords themselves are never stored.
"""

from __future__ import annotations

import ctypes
import getpass
import hashlib
import hmac
import os
import platform
import sys
from typing import Any

__all__ = [
    "SecurityError",
    "dpapi_available",
    "protect_secret",
    "unprotect_secret",
    "hash_password",
    "verify_password",
    "current_machine_id",
]

CRYPTPROTECT_UI_FORBIDDEN = 0x1

_MACHINE_GUID_KEY = r"SOFTWARE\Microsoft\Cryptography"
_MACHINE_GUID_VALUE = "MachineGuid"


class SecurityError(RuntimeError):
    """Raised when a security primitive cannot complete (e.g. DPAPI failure)."""


def dpapi_available() -> bool:
    """Return True only on Windows, where the DPAPI is provided."""
    return sys.platform == "win32"


def _require_dpapi() -> None:
    if not dpapi_available():
        raise SecurityError("DPAPI is only available on Windows")


def _win32_types() -> tuple[Any, Any]:
    """Import the Win32 ctypes bindings lazily (they do not exist off Windows)."""
    try:
        import ctypes.wintypes as wintypes
        from ctypes import WinDLL
    except (ImportError, ValueError) as exc:  # pragma: no cover - non-Windows
        raise SecurityError(f"Win32 ctypes bindings unavailable: {exc}") from exc
    return wintypes, WinDLL


_BLOB_TYPE: Any = None


def _dpapi_blob_type() -> Any:
    """Return the (cached) DATA_BLOB structure: cbData DWORD, pbData POINTER(c_char)."""
    global _BLOB_TYPE
    if _BLOB_TYPE is None:
        wintypes, _ = _win32_types()

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [
                ("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char)),
            ]

        _BLOB_TYPE = DATA_BLOB
    return _BLOB_TYPE


def _crypt32() -> Any:
    wintypes, WinDLL = _win32_types()
    crypt32 = WinDLL("crypt32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(_dpapi_blob_type()),  # pDataIn
        wintypes.LPCWSTR,  # szDataDescr
        ctypes.POINTER(_dpapi_blob_type()),  # pOptionalEntropy
        ctypes.c_void_p,  # pvReserved
        ctypes.c_void_p,  # pPromptStruct
        wintypes.DWORD,  # dwFlags
        ctypes.POINTER(_dpapi_blob_type()),  # pDataOut
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(_dpapi_blob_type()),  # pDataIn
        ctypes.POINTER(wintypes.LPWSTR),  # ppszDataDescr
        ctypes.POINTER(_dpapi_blob_type()),  # pOptionalEntropy
        ctypes.c_void_p,  # pvReserved
        ctypes.c_void_p,  # pPromptStruct
        wintypes.DWORD,  # dwFlags
        ctypes.POINTER(_dpapi_blob_type()),  # pDataOut
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    return crypt32


def _kernel32() -> Any:
    _, WinDLL = _win32_types()
    kernel32 = WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return kernel32


def _make_in_blob(data: bytes) -> tuple[Any, Any]:
    """Return (DATA_BLOB, keepalive buffer) for *data*."""
    data_blob = _dpapi_blob_type()
    if not data:
        # DPAPI rejects a NULL pbData even with cbData == 0, so pass a valid buffer.
        buffer = ctypes.create_string_buffer(1)
        blob = data_blob(0, ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
        return blob, buffer
    buffer = ctypes.create_string_buffer(data, len(data))
    blob = data_blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    return blob, buffer


def _take_out_blob(out_blob: Any) -> bytes:
    """Copy the bytes out of a DPAPI output blob and LocalFree it."""
    try:
        if not out_blob.pbData:
            return b""
        return ctypes.string_at(out_blob.pbData, out_blob.cbData)
    finally:
        if out_blob.pbData:
            _kernel32().LocalFree(out_blob.pbData)


def protect_secret(data: bytes) -> bytes:
    """Encrypt *data* with the current user's DPAPI key. Returns an opaque blob."""
    _require_dpapi()
    if not isinstance(data, (bytes, bytearray)):
        raise SecurityError("protect_secret expects bytes")
    crypt32 = _crypt32()
    in_blob, keepalive = _make_in_blob(bytes(data))
    out_blob = _dpapi_blob_type()()
    ok = crypt32.CryptProtectData(
        ctypes.byref(in_blob),
        None,
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    )
    del keepalive
    if not ok:
        raise SecurityError(f"CryptProtectData failed: {ctypes.WinError(ctypes.get_last_error())}")
    return _take_out_blob(out_blob)


def unprotect_secret(blob: bytes) -> bytes:
    """Decrypt a blob produced by :func:`protect_secret` for the current user."""
    _require_dpapi()
    if not isinstance(blob, (bytes, bytearray)):
        raise SecurityError("unprotect_secret expects bytes")
    crypt32 = _crypt32()
    in_blob, keepalive = _make_in_blob(bytes(blob))
    out_blob = _dpapi_blob_type()()
    description = ctypes.c_wchar_p()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(in_blob),
        ctypes.byref(description),
        None,
        None,
        None,
        CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(out_blob),
    )
    del keepalive
    try:
        if not ok:
            raise SecurityError(
                f"CryptUnprotectData failed: {ctypes.WinError(ctypes.get_last_error())}"
            )
        return _take_out_blob(out_blob)
    finally:
        if description:
            _kernel32().LocalFree(description)


def hash_password(password: str, *, iterations: int = 200_000) -> tuple[str, str]:
    """Derive a PBKDF2-HMAC-SHA256 hash. Returns ``(hash_hex, salt_hex)``."""
    if not isinstance(password, str):
        raise TypeError("password must be str")
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return digest.hex(), salt.hex()


def verify_password(password: str, hash_hex: str, salt_hex: str, iterations: int) -> bool:
    """Constant-time check of *password* against a stored hash/salt pair."""
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    if not isinstance(password, str):
        return False
    try:
        actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations))
    except (ValueError, TypeError, OverflowError):
        return False
    return hmac.compare_digest(actual, expected)


def _windows_machine_guid() -> str | None:
    try:
        import winreg
    except ImportError:  # pragma: no cover - non-Windows
        return None
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE, _MACHINE_GUID_KEY, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY
        ) as key:
            value, _ = winreg.QueryValueEx(key, _MACHINE_GUID_VALUE)
    except OSError:
        return None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def current_machine_id() -> str:
    """Stable per-machine, per-user identifier (SHA-256 hex)."""
    machine_guid = _windows_machine_guid() if sys.platform == "win32" else None
    basis = machine_guid or platform.node() or ""
    combined = f"{basis}:{getpass.getuser()}"
    return hashlib.sha256(combined.encode("utf-8")).hexdigest()
