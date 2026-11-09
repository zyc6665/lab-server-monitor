"""Read-only server user scanning (0.3.0 Task 3).

The remote side runs one fixed, whitelisted bash script that reads
``/etc/passwd`` and ``/etc/group`` directly (never ``getent``, which would
resolve LDAP/AD accounts) plus ``stat`` for the home and ``/data/<user>``
directory metadata.  Optional disk usage comes from a single ``du`` call
through sudo, with every path quoted and restricted to ``/home/`` or
``/data/``.

No user input ever reaches a shell command: the scan script is a constant,
and usage paths are derived from validated usernames and remote passwd data.
"""

from __future__ import annotations

import posixpath
import re
import shlex
from datetime import datetime
from typing import Protocol

from .models import CommandResult, HostConfig, HostUserAccount
from .ssh_client import SudoAuthError, SudoUnavailable

USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

_USAGE_PREFIXES = ("/home/", "/data/")
_DOCKER_GROUP = "docker"
_SUDO_GROUPS = frozenset({"sudo", "wheel"})

# Fixed bash script.  It takes no parameters and interpolates nothing from the
# caller: every value printed comes from the remote ``/etc/passwd``,
# ``/etc/group`` or ``stat``.  Output records are TAB separated:
#
#   P  <data exists 0|1>
#   U  <name> <uid> <gid> <home> <shell> <gecos>   (every passwd line)
#   G  <name> <gid> <comma separated members>      (every group line)
#   H  <name> <exists 0|1> <owner> <group> <mode>
#   D  <name> <exists 0|1> <owner> <group> <mode>  (only when /data exists)
#
# ``IFS`` below holds a literal TAB.  ``stat -c`` does not interpret ``\t`` in
# its format string, so owner/group/mode are separated with ``:`` and split by
# ``read``.  The loop only visits ordinary accounts (UID >= 1000, login shell).
_SCAN_COMMAND = r"""export LC_ALL=C
if test -d /data; then printf 'P\t1\n'; else printf 'P\t0\n'; fi
awk -F: '{ printf "U\t%s\t%s\t%s\t%s\t%s\t%s\n", $1, $3, $4, $6, $7, $5 }' /etc/passwd 2>/dev/null || true
awk -F: '{ printf "G\t%s\t%s\t%s\n", $1, $3, $4 }' /etc/group 2>/dev/null || true
awk -F: '$3 >= 1000 && $7 !~ /(nologin|false)$/ { printf "%s\t%s\n", $1, $6 }' /etc/passwd 2>/dev/null | while IFS='	' read -r name home; do
  if test -d "$home"; then
    meta=$(stat -c '%U:%G:%a' -- "$home" 2>/dev/null || true)
  else
    meta=""
  fi
  owner=-
  group=-
  mode=-
  if test -n "$meta"; then
    IFS=: read -r owner group mode <<EOF
$meta
EOF
    owner=${owner:--}
    group=${group:--}
    mode=${mode:--}
  fi
  if test -d "$home"; then
    printf 'H\t%s\t1\t%s\t%s\t%s\n' "$name" "$owner" "$group" "$mode"
  else
    printf 'H\t%s\t0\t-\t-\t-\n' "$name"
  fi
  if test -d /data; then
    data_path="/data/$name"
    if test -d "$data_path"; then
      meta=$(stat -c '%U:%G:%a' -- "$data_path" 2>/dev/null || true)
    else
      meta=""
    fi
    owner=-
    group=-
    mode=-
    if test -n "$meta"; then
      IFS=: read -r owner group mode <<EOF
$meta
EOF
      owner=${owner:--}
      group=${group:--}
      mode=${mode:--}
    fi
    if test -d "$data_path"; then
      printf 'D\t%s\t1\t%s\t%s\t%s\n' "$name" "$owner" "$group" "$mode"
    else
      printf 'D\t%s\t0\t-\t-\t-\n' "$name"
    fi
  fi
done
"""


class UserScanRunner(Protocol):
    """Runner interface used by :func:`collect_host_users`."""

    def run(self, command: str, timeout: int) -> CommandResult:
        ...

    def run_sudo(self, command: str, timeout: int) -> CommandResult:
        ...


def validate_username(name: str) -> bool:
    """Return ``True`` for a name safe to use as one path component."""
    if not isinstance(name, str):
        return False
    return USERNAME_RE.fullmatch(name) is not None


def parse_passwd(text: str) -> list[dict]:
    """Parse ``/etc/passwd`` text, keeping ordinary login accounts only.

    A line is kept when it has exactly seven colon-separated fields, its UID
    parses to an integer >= 1000 and its shell does not end in ``/nologin`` or
    ``/false``.  Malformed lines are skipped silently.
    """
    users: list[dict] = []
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line or line.startswith("#"):
            continue
        fields = line.split(":")
        if len(fields) != 7:
            continue
        name, _password, uid_text, gid_text, gecos, home, shell = fields
        if not name:
            continue
        try:
            uid = int(uid_text)
            gid = int(gid_text)
        except ValueError:
            continue
        if uid < 1000:
            continue
        if shell.endswith(("/nologin", "/false")):
            continue
        users.append(
            {
                "username": name,
                "uid": uid,
                "gid": gid,
                "home": home,
                "shell": shell,
                "gecos": gecos,
            }
        )
    return users


def parse_group(text: str) -> tuple[dict[str, list[str]], dict[int, str]]:
    """Parse ``/etc/group`` into (name -> members, gid -> name) maps."""
    groups: dict[str, list[str]] = {}
    gid_map: dict[int, str] = {}
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line or line.startswith("#"):
            continue
        fields = line.split(":")
        if len(fields) != 4:
            continue
        name, _password, gid_text, members_text = fields
        if not name:
            continue
        try:
            gid = int(gid_text)
        except ValueError:
            continue
        members = [member.strip() for member in members_text.split(",") if member.strip()]
        groups[name] = members
        gid_map.setdefault(gid, name)
    return groups, gid_map


def build_scan_command() -> str:
    """Return the fixed, parameterless remote scan script."""
    return _SCAN_COMMAND


def _safe_usage_path(path: object) -> str:
    """Validate one ``du`` target and return its normalised form.

    Only real paths directly below ``/home/`` or ``/data/`` are allowed: no
    ``..`` segments (``/home/../etc`` would escape the allowed roots), no empty
    component, and no control characters.
    """
    if not isinstance(path, str) or not path.startswith(_USAGE_PREFIXES):
        raise ValueError(f"不允许统计该路径的占用: {path!r}")
    if any(char in path for char in ("\n", "\r", "\x00")):
        raise ValueError(f"路径包含非法控制字符: {path!r}")
    if ".." in path.split("/"):
        raise ValueError(f"路径不允许包含上级目录: {path!r}")
    if posixpath.normpath(path) != path.rstrip("/"):
        raise ValueError(f"路径不是规范形式: {path!r}")
    return path.rstrip("/")


def build_usage_command(paths: list[str]) -> str:
    """Build the ``du`` command for *paths*, each validated and quoted."""
    quoted: list[str] = []
    for path in paths:
        quoted.append(shlex.quote(_safe_usage_path(path)))
    return "du -sx --block-size=1 -- " + " ".join(quoted)


def parse_usage(text: str) -> dict[str, int]:
    """Parse ``bytes<TAB>path`` lines from ``du``; ignore malformed lines."""
    usage: dict[str, int] = {}
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line or "\t" not in line:
            continue
        size_text, path = line.split("\t", 1)
        if not path:
            continue
        try:
            size = int(size_text)
        except ValueError:
            continue
        if size < 0:
            continue
        usage[path] = size
    return usage


def _optional_field(fields: list[str], index: int) -> str | None:
    if len(fields) <= index:
        return None
    value = fields[index].strip()
    if not value or value == "-":
        return None
    return value


def _scan_metadata(fields: list[str]) -> dict:
    exists = fields[2] == "1"
    return {
        "exists": exists,
        "owner": _optional_field(fields, 3),
        "group": _optional_field(fields, 4),
        "mode": _optional_field(fields, 5),
    }


def _parse_scan_output(
    text: str,
) -> tuple[
    list[dict],
    dict[str, list[str]],
    dict[int, str],
    dict[str, dict],
    dict[str, dict],
    bool,
]:
    users: list[dict] = []
    seen: set[str] = set()
    group_members: dict[str, list[str]] = {}
    gid_names: dict[int, str] = {}
    homes: dict[str, dict] = {}
    data_dirs: dict[str, dict] = {}
    data_supported = False
    saw_marker = False
    saw_user_line = False
    saw_unparseable = False

    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if not line:
            continue
        fields = line.split("\t")
        kind = fields[0]

        if kind == "U":
            saw_user_line = True
            if len(fields) < 6:
                saw_unparseable = True
                continue
            name = fields[1]
            uid_text, gid_text = fields[2], fields[3]
            home, shell = fields[4], fields[5]
            gecos = "\t".join(fields[6:]) if len(fields) > 6 else ""
            if not validate_username(name) or name in seen:
                saw_unparseable = True
                continue
            try:
                uid = int(uid_text)
                gid = int(gid_text)
            except ValueError:
                saw_unparseable = True
                continue
            if uid < 1000:
                continue
            if shell.endswith(("/nologin", "/false")):
                continue
            seen.add(name)
            users.append(
                {
                    "username": name,
                    "uid": uid,
                    "gid": gid,
                    "home": home,
                    "shell": shell,
                    "gecos": gecos,
                }
            )

        elif kind == "G":
            if len(fields) < 3:
                saw_unparseable = True
                continue
            name = fields[1]
            members_text = fields[3] if len(fields) > 3 else ""
            if not validate_username(name):
                saw_unparseable = True
                continue
            try:
                gid = int(fields[2])
            except ValueError:
                saw_unparseable = True
                continue
            members = [
                member.strip()
                for member in members_text.split(",")
                if member.strip()
            ]
            group_members[name] = members
            gid_names.setdefault(gid, name)

        elif kind in ("H", "D"):
            if len(fields) < 3 or fields[2] not in ("0", "1"):
                continue
            name = fields[1]
            if not validate_username(name):
                continue
            target = homes if kind == "H" else data_dirs
            target[name] = _scan_metadata(fields)

        elif kind == "P":
            if len(fields) >= 2 and fields[1] in ("0", "1"):
                data_supported = fields[1] == "1"
                saw_marker = True

    # A truncated/garbled response (empty output, only a marker, no group
    # records) must not be mistaken for "the host now has zero users": that
    # would wipe the snapshot and raise a false ``user-present`` for every
    # baseline account.  The caller stores ``last_error`` and keeps the old data.
    if not saw_marker:
        raise RuntimeError("用户扫描输出缺少结束标记，已保留上次结果")
    if not saw_user_line:
        raise RuntimeError("用户扫描输出缺少账号数据，已保留上次结果")
    if not users and saw_unparseable:
        raise RuntimeError("用户扫描输出无法解析，已保留上次结果")
    if users and not gid_names:
        raise RuntimeError("用户扫描输出缺少组信息，已保留上次结果")

    return users, group_members, gid_names, homes, data_dirs, data_supported


def collect_host_users(
    host: HostConfig,
    runner: UserScanRunner,
    *,
    now: datetime,
    usage_due: bool,
    command_timeout: int = 120,
) -> tuple[list[HostUserAccount], bool, bool]:
    """Collect one host's user snapshot through *runner*.

    Returns ``(accounts, usage_readable, usage_refreshed)``.  ``du`` runs only
    when *usage_due* is true and at least one candidate directory exists; sudo
    failures are reported through ``usage_readable`` instead of raising.
    """
    result = runner.run(build_scan_command(), command_timeout)
    if result.exit_status != 0:
        raise RuntimeError(
            f"用户扫描命令执行失败（退出码 {result.exit_status}）"
        )

    (
        users,
        group_members,
        gid_names,
        homes,
        data_dirs,
        data_supported,
    ) = _parse_scan_output(result.stdout)

    supplemental: dict[str, list[str]] = {}
    for group_name, members in group_members.items():
        for member in members:
            supplemental.setdefault(member, []).append(group_name)

    usage_readable = True
    usage_refreshed = False
    usage_sizes: dict[str, int] = {}

    if usage_due:
        candidate_paths: list[str] = []
        for user in users:
            name = user["username"]
            home = user["home"]
            home_meta = homes.get(name, {})
            data_meta = data_dirs.get(name, {})
            if home_meta.get("exists") and home.startswith("/home/"):
                candidate_paths.append(home)
            if data_supported and data_meta.get("exists"):
                candidate_paths.append(f"/data/{name}")
        # Preserve order while dropping duplicates.
        candidate_paths = list(dict.fromkeys(candidate_paths))

        if candidate_paths:
            try:
                usage_command = build_usage_command(candidate_paths)
            except ValueError:
                usage_readable = False
            else:
                try:
                    usage_result = runner.run_sudo(usage_command, command_timeout)
                except (SudoAuthError, SudoUnavailable):
                    usage_readable = False
                except Exception:  # noqa: BLE001 - usage failure must not abort scan
                    usage_readable = False
                else:
                    parsed = parse_usage(usage_result.stdout)
                    # ``du`` exits non-zero when one path fails, but still
                    # prints the sizes it could read.  Keep those.
                    if usage_result.exit_status == 0 or parsed:
                        usage_sizes = parsed
                        usage_refreshed = True
                    else:
                        usage_readable = False

    accounts: list[HostUserAccount] = []
    for user in users:
        name = user["username"]
        gid = user["gid"]
        primary_group = gid_names.get(gid)
        groups: list[str] = []
        if primary_group:
            groups.append(primary_group)
        for group_name in sorted(supplemental.get(name, ())):
            if group_name not in groups:
                groups.append(group_name)

        home_meta = homes.get(name, {})
        home = user["home"]
        home_exists = bool(home_meta.get("exists"))
        data_meta = data_dirs.get(name, {})
        data_exists = bool(data_supported and data_meta.get("exists"))

        home_size = None
        if home_exists and home.startswith("/home/"):
            home_size = usage_sizes.get(home)
        data_size = None
        if data_exists:
            data_size = usage_sizes.get(f"/data/{name}")

        accounts.append(
            HostUserAccount(
                host_name=host.name,
                username=name,
                uid=user["uid"],
                gid=gid,
                primary_group=primary_group,
                gecos=user["gecos"],
                home=home,
                shell=user["shell"],
                groups=groups,
                in_docker=_DOCKER_GROUP in groups,
                in_sudo=any(group in _SUDO_GROUPS for group in groups),
                home_exists=home_exists,
                home_owner=home_meta.get("owner"),
                home_group=home_meta.get("group"),
                home_mode=home_meta.get("mode"),
                home_size_bytes=home_size,
                data_exists=data_exists,
                data_owner=data_meta.get("owner") if data_exists else None,
                data_group=data_meta.get("group") if data_exists else None,
                data_mode=data_meta.get("mode") if data_exists else None,
                data_size_bytes=data_size,
                data_supported=data_supported,
                usage_readable=usage_readable,
                usage_stale=False,
                usage_collected_at=now if usage_refreshed else None,
                collected_at=now,
                state="present",
            )
        )

    return accounts, usage_readable, usage_refreshed
