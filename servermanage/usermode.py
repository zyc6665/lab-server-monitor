"""Helpers for the admin / member (user) viewing modes.

The mode decides which surfaces the client exposes.  It is a usability
boundary for lab members, not a security boundary: SSH credentials still live
on the local machine and the real limits stay on the servers.
"""

from __future__ import annotations

import re

MODE_ADMIN = "admin"
MODE_USER = "user"
MODES = (MODE_ADMIN, MODE_USER)

_MEMBER_PATTERN = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")


class ModeError(ValueError):
    """Raised when a mode or member account value is not acceptable."""


def normalize_mode(value: object, *, default: str = MODE_ADMIN) -> str:
    """Return ``admin`` or ``user``; empty/None falls back to ``default``."""
    if value is None or value == "":
        return default
    text = str(value).strip().lower()
    if text in MODES:
        return text
    raise ModeError(f"未知使用模式: {value}（只支持 admin / user）")


def normalize_member_account(value: object) -> str:
    """Return a validated Linux account name, or ``""`` when unset."""
    if value is None:
        return ""
    text = str(value).strip().lower()
    if not text:
        return ""
    if not _MEMBER_PATTERN.match(text):
        raise ModeError("账号名只能包含小写字母、数字、下划线和连字符，且以字母或下划线开头")
    return text


def validate_mode(mode: str, member_account: str) -> tuple[str, str]:
    """Validate a mode/member pair and return the normalized values."""
    normalized_mode = normalize_mode(mode)
    normalized_member = normalize_member_account(member_account)
    if normalized_mode == MODE_USER and not normalized_member:
        raise ModeError("用户模式需要填写自己的服务器账号名")
    return normalized_mode, normalized_member
