"""Guarded account provisioning for the server-users feature.

Everything here is deliberately conservative:

* only four fixed operations exist (create, password, docker, data);
* commands are built from validated arguments, never from free-form text;
* the new password travels through the SSH stdin channel (``chpasswd``) and is
  never part of a command line, a log line, an audit row or an API response;
* a plan must be previewed first and then confirmed by typing the host name and
  the account name again;
* nothing destructive is automatic: a partially applied plan stops immediately
  and reports the manual rollback commands instead of deleting data.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from typing import Any, Sequence

#: The operations the UI may request.  Anything else is rejected.
OPERATIONS = ("create", "password", "docker", "data")

OPERATION_LABELS = {
    "create": "创建账号",
    "password": "重置密码",
    "docker": "加入 docker 组",
    "data": "创建 /data 目录",
}

#: ``useradd``-compatible names: lowercase, no leading dash, no spaces.
ACCOUNT_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")

#: Names that must never be created through the web UI (system accounts).
RESERVED_ACCOUNTS = frozenset(
    {
        "root",
        "daemon",
        "bin",
        "sys",
        "sync",
        "games",
        "man",
        "lp",
        "mail",
        "news",
        "uucp",
        "proxy",
        "www-data",
        "backup",
        "list",
        "irc",
        "gnats",
        "nobody",
        "systemd-network",
        "systemd-resolve",
        "messagebus",
        "sshd",
        "docker",
        "adm",
        "sudo",
        "wheel",
    }
)

PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 64
PASSWORD_ALPHABET = string.ascii_letters + string.digits
PLAN_TTL_SECONDS = 600
COMMAND_TIMEOUT_SECONDS = 120
MAX_CACHED_PLANS = 32


class AdminPlanError(ValueError):
    """Raised when a plan cannot be built from the supplied arguments."""


def validate_account_name(name: Any) -> str:
    """Return the normalised account name or raise :class:`AdminPlanError`."""
    if not isinstance(name, str):
        raise AdminPlanError("账号名必须是字符串")
    value = name.strip()
    if not value:
        raise AdminPlanError("请填写账号名")
    if value != value.lower():
        raise AdminPlanError("账号名只能使用小写字母")
    if not ACCOUNT_RE.fullmatch(value):
        raise AdminPlanError("账号名只能包含小写字母、数字、下划线或短横线，且不能以数字或短横线开头")
    if value in RESERVED_ACCOUNTS:
        raise AdminPlanError("这是系统账号名，不能创建")
    return value


def validate_password(value: Any) -> str:
    """Validate an admin-supplied password (no newline, no colon, no space)."""
    if not isinstance(value, str):
        raise AdminPlanError("密码必须是字符串")
    if len(value) < PASSWORD_MIN_LENGTH:
        raise AdminPlanError(f"密码至少需要 {PASSWORD_MIN_LENGTH} 位")
    if len(value) > PASSWORD_MAX_LENGTH:
        raise AdminPlanError(f"密码不能超过 {PASSWORD_MAX_LENGTH} 位")
    if ":" in value or "\n" in value or "\r" in value:
        raise AdminPlanError("密码不能包含冒号或换行")
    if any(ch.isspace() for ch in value):
        raise AdminPlanError("密码不能包含空格")
    if any(ord(ch) < 33 or ord(ch) > 126 for ch in value):
        raise AdminPlanError("密码只能使用可见的 ASCII 字符")
    return value


def generate_password(length: int = 16) -> str:
    """Return a random alphanumeric password (never logged)."""
    length = max(PASSWORD_MIN_LENGTH, min(PASSWORD_MAX_LENGTH, int(length)))
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(length))


def _step(
    step_id: str,
    title: str,
    command: str,
    *,
    elevated: bool = True,
    stdin: str | None = None,
    stdin_label: str | None = None,
    skipped_reason: str | None = None,
) -> dict[str, Any]:
    return {
        "id": step_id,
        "title": title,
        "command": command,
        "elevated": elevated,
        "stdin": stdin,
        "stdin_label": stdin_label,
        "skipped_reason": skipped_reason,
    }


def build_plan(
    operation: str,
    *,
    host_name: str,
    account: str,
    password: str | None = None,
    account_exists: bool = False,
    docker_group: bool = True,
    data_supported: bool = True,
    sudo_configured: bool = True,
    with_docker: bool = True,
    with_data: bool = True,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Build a human-reviewable plan for *operation* on one account.

    The returned mapping is safe to render in the browser **except** for
    ``steps[*]["stdin"]``; callers must use :func:`public_plan` before sending it
    over the API.
    """
    if operation not in OPERATIONS:
        raise AdminPlanError(f"未知操作：{operation}")
    name = validate_account_name(account)
    host = (host_name or "").strip()
    if not host:
        raise AdminPlanError("缺少主机名")
    moment = now or datetime.now(timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)

    steps: list[dict[str, Any]] = []
    warnings: list[str] = []
    blocked: list[str] = []

    if not sudo_configured:
        blocked.append("这台主机还没有配置 sudo 密码，无法执行需要 root 的操作。请先在主机设置里填写 sudo 密码。")

    if operation == "create":
        if account_exists:
            blocked.append(f"账号 {name} 已经存在，不能重复创建；可以改用“重置密码”或“加入 docker 组”。")
        else:
            steps.append(
                _step(
                    "useradd",
                    "创建账号与家目录",
                    f"useradd -m -d /home/{name} -s /bin/bash -- {name}",
                )
            )
            new_password = validate_password(password) if password else generate_password()
            steps.append(
                _step(
                    "chpasswd",
                    "设置初始密码",
                    "chpasswd",
                    stdin=f"{name}:{new_password}",
                    stdin_label="通过标准输入设置密码（不会出现在命令或日志里）",
                )
            )
            if with_docker:
                if docker_group:
                    steps.append(
                        _step("docker", "加入 docker 组", f"gpasswd -a {name} docker")
                    )
                else:
                    warnings.append("这台主机没有 docker 组，跳过加入 docker 组。")
            if with_data:
                if data_supported:
                    steps.append(
                        _step(
                            "data",
                            "创建 /data 目录并设置权限",
                            f"mkdir -p -- /data/{name} && chown {name}:{name} -- /data/{name} && chmod 755 -- /data/{name}",
                        )
                    )
                else:
                    warnings.append("这台主机没有 /data 目录，跳过创建个人目录。")
        verify = [
            _step("verify-id", "验证账号与组", f"id -- {name}", elevated=False),
        ]
        if with_data and data_supported:
            verify.append(
                _step(
                    "verify-data",
                    "验证 /data 目录权限",
                    f"stat -c '%U %G %a %n' -- /data/{name}",
                    elevated=False,
                )
            )
        steps.extend(verify)

    elif operation == "password":
        if not account_exists:
            blocked.append(f"账号 {name} 不存在，无法重置密码。")
        new_password = validate_password(password) if password else generate_password()
        steps.append(
            _step(
                "chpasswd",
                "重置密码",
                "chpasswd",
                stdin=f"{name}:{new_password}",
                stdin_label="通过标准输入设置密码（不会出现在命令或日志里）",
            )
        )
        steps.append(_step("verify-id", "验证账号", f"id -- {name}", elevated=False))

    elif operation == "docker":
        if not account_exists:
            blocked.append(f"账号 {name} 不存在，请先创建账号。")
        if not docker_group:
            blocked.append("这台主机没有 docker 组，无法加入。")
        steps.append(_step("docker", "加入 docker 组", f"gpasswd -a {name} docker"))
        steps.append(
            _step("verify-groups", "验证组成员", f"id -nG -- {name}", elevated=False)
        )
        warnings.append("组成员关系在用户下次登录时生效，已经登录的会话需要重新登录。")

    else:  # data
        if not account_exists:
            blocked.append(f"账号 {name} 不存在，请先创建账号。")
        if not data_supported:
            blocked.append("这台主机没有 /data 目录，无法创建个人目录。")
        steps.append(
            _step(
                "data",
                "创建 /data 目录并设置权限",
                f"mkdir -p -- /data/{name} && chown {name}:{name} -- /data/{name} && chmod 755 -- /data/{name}",
            )
        )
        steps.append(
            _step(
                "verify-data",
                "验证 /data 目录权限",
                f"stat -c '%U %G %a %n' -- /data/{name}",
                elevated=False,
            )
        )

    if any(step["id"] in {"gpasswd", "docker"} for step in steps):
        pass  # membership warnings already added above

    nonce = secrets.token_hex(8)
    plan_hash = _hash_plan(operation, host, name, steps, nonce, moment)
    return {
        "operation": operation,
        "operation_label": OPERATION_LABELS[operation],
        "host": host,
        "account": name,
        "created_at": moment.isoformat(),
        "expires_at": (moment + timedelta(seconds=PLAN_TTL_SECONDS)).isoformat(),
        "nonce": nonce,
        "plan_hash": plan_hash,
        "steps": steps,
        "warnings": warnings,
        "blocked": bool(blocked),
        "blocked_reasons": blocked,
        "rollback_hint": _rollback_hint(operation, name),
    }


def _rollback_hint(operation: str, name: str) -> str:
    if operation == "create":
        return (
            f"如果中途失败，可能只创建了账号或目录。回滚需要你手工确认："
            f"`sudo userdel -r {name}`（会删除家目录）以及 `sudo rm -rf /data/{name}`。"
            "本工具不会自动删除任何数据。"
        )
    if operation == "data":
        return f"如果目录是本次新建的，可以手工执行 `sudo rmdir /data/{name}`（仅在目录为空时有效）。"
    return "本操作只修改密码或组成员关系，可用原密码或 `sudo gpasswd -d %s docker` 撤销。" % name


def _hash_plan(
    operation: str,
    host: str,
    account: str,
    steps: Sequence[dict[str, Any]],
    nonce: str,
    moment: datetime,
) -> str:
    payload = {
        "operation": operation,
        "host": host,
        "account": account,
        "nonce": nonce,
        "created_at": moment.isoformat(),
        "steps": [
            {
                "id": step["id"],
                "command": step["command"],
                "elevated": step["elevated"],
                "stdin_sha256": _digest(step["stdin"]) if step.get("stdin") else None,
            }
            for step in steps
        ],
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def public_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of *plan* with every secret removed."""
    public = {key: value for key, value in plan.items() if key != "steps"}
    public["steps"] = [
        {
            "id": step["id"],
            "title": step["title"],
            "command": step["command"],
            "elevated": step["elevated"],
            "stdin_label": step.get("stdin_label"),
            "has_stdin": bool(step.get("stdin")),
            "skipped_reason": step.get("skipped_reason"),
        }
        for step in plan["steps"]
    ]
    return public


def mask_command(command: str) -> str:
    """Commands are already secret-free; kept for callers that log them."""
    return command


class PlanCache:
    """Short-lived, in-process cache of previewed plans (secrets stay server side)."""

    def __init__(self, *, ttl_seconds: int = PLAN_TTL_SECONDS, max_entries: int = MAX_CACHED_PLANS) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._items: dict[str, tuple[datetime, dict[str, Any]]] = {}

    def put(self, plan: dict[str, Any], *, now: datetime | None = None) -> None:
        moment = now or datetime.now(timezone.utc)
        self._prune(moment)
        self._items[plan["plan_hash"]] = (moment, plan)
        while len(self._items) > self._max:
            oldest = min(self._items, key=lambda key: self._items[key][0])
            self._items.pop(oldest, None)

    def get(self, plan_hash: str, *, now: datetime | None = None) -> dict[str, Any] | None:
        moment = now or datetime.now(timezone.utc)
        self._prune(moment)
        item = self._items.get(plan_hash)
        return item[1] if item else None

    def drop(self, plan_hash: str) -> None:
        self._items.pop(plan_hash, None)

    def _prune(self, moment: datetime) -> None:
        expired = [
            key
            for key, (created, _plan) in self._items.items()
            if (moment - created).total_seconds() > self._ttl
        ]
        for key in expired:
            self._items.pop(key, None)


def execute_plan(
    plan: dict[str, Any],
    runner: Any,
    *,
    timeout: int = COMMAND_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Run every step of *plan* in order, stopping at the first failure.

    ``runner`` must provide ``run(command, timeout)`` and
    ``run_sudo(command, timeout, stdin_data=None)``.  The returned dict never
    contains the password.
    """
    results: list[dict[str, Any]] = []
    for step in plan["steps"]:
        stdin_data = step.get("stdin")
        try:
            if step["elevated"]:
                result = runner.run_sudo(step["command"], timeout, stdin_data=stdin_data)
            else:
                result = runner.run(step["command"], timeout)
        except Exception as exc:  # noqa: BLE001 - mapped to a readable status
            results.append(
                {
                    "id": step["id"],
                    "title": step["title"],
                    "status": "error",
                    "exit_status": None,
                    "stdout": "",
                    "stderr": _safe_error(exc),
                }
            )
            return {"ok": False, "status": "error", "steps": results, "error": _safe_error(exc)}
        entry = {
            "id": step["id"],
            "title": step["title"],
            "status": "ok" if result.exit_status == 0 else "failed",
            "exit_status": result.exit_status,
            "stdout": _clip(result.stdout),
            "stderr": _clip(result.stderr),
        }
        results.append(entry)
        if result.exit_status != 0:
            return {
                "ok": False,
                "status": "failed",
                "steps": results,
                "error": f"步骤“{step['title']}”失败（退出码 {result.exit_status}）",
            }
    return {"ok": True, "status": "succeeded", "steps": results, "error": ""}


def _clip(text: str | None, limit: int = 4000) -> str:
    value = text or ""
    return value if len(value) <= limit else value[:limit] + "…"


def _safe_error(exc: Exception) -> str:
    message = str(exc) or exc.__class__.__name__
    return message[:400]
