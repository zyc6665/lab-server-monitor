"""Pure-function parsers for importing host definitions.

This module accepts raw text (SSH client config, CSV, or YAML) and returns
validated :class:`HostCandidate` objects.  It never opens server files: the
only filesystem interaction is expanding ``~``/relative ``IdentityFile``
paths and probing whether a local private key exists (so a missing key only
raises a warning).  Callers are responsible for reading the source files and
persisting the accepted candidates.
"""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Iterable

import yaml

_DEFAULT_DISK_MOUNTS: tuple[str, ...] = ("/", "/data")
_DEFAULT_GROUP = "未分组"
_PROXY_ERROR = "需要代理跳转，工具暂不支持"


@dataclass(frozen=True)
class HostCandidate:
    name: str
    host: str
    port: int = 22
    port_explicit: bool = True
    username: str = ""
    auth_type: str = "key"
    key_path: str | None = None
    tags: tuple[str, ...] = ()
    disk_mounts: tuple[str, ...] = ("/", "/data")
    group: str = _DEFAULT_GROUP
    owner: str = ""
    location: str = ""
    notes: str = ""
    warnings: tuple[str, ...] = ()
    valid: bool = True
    error: str | None = None


@dataclass(frozen=True)
class ParseResult:
    candidates: list[HostCandidate] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# shared helpers
# ---------------------------------------------------------------------------


def _decode(text: str | bytes) -> str:
    """Decode bytes as UTF-8-sig, falling back to GB18030; strip a str BOM."""

    if isinstance(text, bytes):
        try:
            return text.decode("utf-8-sig")
        except UnicodeDecodeError:
            return text.decode("gb18030")
    if text.startswith("\ufeff"):
        return text.lstrip("\ufeff")
    return text


def _split_multi(value: str | None) -> tuple[str, ...]:
    """Split a ``tags``/``disk_mounts`` cell on comma or semicolon."""

    if not value:
        return ()
    normalized = value.replace(";", ",")
    return tuple(part.strip() for part in normalized.split(",") if part.strip())


def _as_text(value: object) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _int_or_none(value: str) -> int | None:
    try:
        return int(value.strip())
    except (AttributeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# SSH client config
# ---------------------------------------------------------------------------


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _is_wildcard(pattern: str) -> bool:
    return any(char in pattern for char in ("*", "?", "!"))


def _expand_identity(value: str, home: Path) -> str:
    value = value.strip().replace("%d", str(home))
    if value == "~":
        return str(home)
    if value.startswith("~/"):
        return str(home / value[2:])
    if value.startswith("~"):
        return str(home / value[1:].lstrip("/"))
    path = Path(value)
    if path.is_absolute():
        return str(path)
    return str(home / ".ssh" / path)


def parse_ssh_config(text: str | bytes, *, home: Path | None = None) -> ParseResult:
    """Parse an OpenSSH client config into host candidates.

    ``home`` is used only to expand ``~`` and relative ``IdentityFile`` paths.
    ``Match``/wildcard ``Host``/``Include`` blocks are skipped with a warning;
    hosts requiring ``ProxyJump``/``ProxyCommand`` are returned as invalid.
    """

    text = _decode(text)
    home_path = Path(home) if home is not None else Path.home()

    candidates: list[HostCandidate] = []
    errors: list[dict] = []
    warnings: list[str] = []

    blocks: list[dict] = []
    current: dict | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        keyword = parts[0].lower()
        value = _unquote(parts[1]) if len(parts) > 1 else ""

        if keyword == "host":
            aliases = [alias for alias in value.split() if alias]
            current = {"kind": "host", "patterns": aliases, "options": {}, "value": value}
            blocks.append(current)
        elif keyword == "match":
            current = {"kind": "match", "patterns": [], "options": {}, "value": value}
            blocks.append(current)
        elif keyword == "include":
            warnings.append(f"跳过 Include 指令: {value}")
            current = None
        else:
            if current is None:
                continue
            current["options"].setdefault(keyword, []).append(value)

    for block in blocks:
        if block["kind"] == "match":
            match_value = block["value"]
            warnings.append(f"跳过 Match 配置块: {match_value}" if match_value else "跳过 Match 配置块")
            continue

        patterns: Iterable[str] = block["patterns"]
        wildcards = [pattern for pattern in patterns if _is_wildcard(pattern)]
        aliases = [pattern for pattern in patterns if not _is_wildcard(pattern)]
        for wildcard in wildcards:
            warnings.append(f"跳过通配符 Host: {wildcard}")
        if not aliases:
            continue

        options: dict[str, list[str]] = block["options"]
        hostname = options.get("hostname", [""])[0]
        username = options.get("user", [""])[0]
        port = 22
        raw_port = options.get("port", [""])[0]
        if raw_port:
            parsed_port = _int_or_none(raw_port)
            if parsed_port is None:
                warnings.append(f"无效端口 {raw_port}，使用默认 22")
            else:
                port = parsed_port

        identity = options.get("identityfile", [""])[0]
        key_path: str | None = None
        if identity:
            key_path = _expand_identity(identity, home_path)
            if not Path(key_path).exists():
                warnings.append(f"私钥文件不存在: {key_path}")

        needs_proxy = "proxyjump" in options or "proxycommand" in options

        for alias in aliases:
            host = hostname or alias
            candidate_warnings: list[str] = []
            if needs_proxy:
                candidate_warnings.append(_PROXY_ERROR)
                warnings.append(f"主机 {alias} {_PROXY_ERROR}")
            candidates.append(
                HostCandidate(
                    name=alias,
                    host=host,
                    port=port,
                    port_explicit=bool(raw_port),
                    username=username,
                    key_path=key_path,
                    warnings=tuple(candidate_warnings),
                    valid=not needs_proxy,
                    error=_PROXY_ERROR if needs_proxy else None,
                )
            )

    return ParseResult(candidates=candidates, errors=errors, warnings=warnings)


def _parse_star_defaults(text: str) -> dict[str, str]:
    """Return option values from the last/first ``Host *`` block.

    OpenSSH applies ``Host *`` as a defaults block.  A compact parser is enough
    here: take the first value of each option in the first ``Host *`` block.
    """

    defaults: dict[str, str] = {}
    in_star = False
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        keyword = parts[0].lower()
        value = _unquote(parts[1]) if len(parts) > 1 else ""
        if keyword == "host":
            in_star = "*" in value.split()
            continue
        if keyword in ("match", "include"):
            in_star = False
            continue
        if not in_star:
            continue
        if keyword not in defaults and value:
            defaults[keyword] = value
    return defaults


def _replace_ssh_tokens(value: str, *, home: Path, host: str, username: str) -> str:
    return (
        value.replace("%d", str(home))
        .replace("%h", host)
        .replace("%u", username)
    )


def apply_import_defaults(
    result: ParseResult,
    text: str | bytes,
    *,
    home: Path | None = None,
    default_username: str | None = None,
) -> ParseResult:
    """Fill OpenSSH defaults and local key fallbacks for import candidates.

    This is intentionally separate from :func:`parse_ssh_config`: the generic
    parser stays strict for CSV/YAML and the connection wizard, while the SSH
    config import flow may create hosts that still need credentials.
    """

    text = _decode(text)
    home_path = Path(home) if home is not None else Path.home()
    defaults = _parse_star_defaults(text)
    default_user = defaults.get("user") or (default_username or "")
    default_identity = defaults.get("identityfile", "")

    resolved: list[HostCandidate] = []
    warnings = list(result.warnings)
    unused_tokens_seen = False
    for candidate in result.candidates:
        host = _replace_ssh_tokens(
            candidate.host,
            home=home_path,
            host=candidate.host,
            username=candidate.username or default_user,
        )
        username = _replace_ssh_tokens(
            candidate.username or default_user,
            home=home_path,
            host=host,
            username=candidate.username or default_user,
        )
        port = candidate.port
        if not candidate.port_explicit and defaults.get("port"):
            default_port = _int_or_none(defaults["port"])
            if default_port is not None and 0 < default_port < 65536:
                port = default_port
        key_path = candidate.key_path
        if key_path:
            key_path = _replace_ssh_tokens(
                key_path, home=home_path, host=host, username=username
            )
        elif default_identity:
            key_path = _expand_identity(
                _replace_ssh_tokens(
                    default_identity, home=home_path, host=host, username=username
                ),
                home_path,
            )
        elif not key_path:
            for name in ("id_ed25519", "id_rsa"):
                candidate_path = home_path / ".ssh" / name
                if candidate_path.exists():
                    key_path = str(candidate_path)
                    break

        candidate_warnings = list(candidate.warnings)
        if not username:
            candidate_warnings.append("未指定用户名，导入后需补用户名")
        if candidate.auth_type == "key" and not key_path:
            candidate_warnings.append("未指定 IdentityFile，导入后需补私钥或密码")
        elif candidate.auth_type == "key" and key_path and not Path(key_path).exists():
            candidate_warnings.append(f"私钥文件不存在: {key_path}")
        if "%" in (key_path or "") or "%" in host:
            unused_tokens_seen = True
            candidate_warnings.append("包含未识别的 SSH 配置占位符，请检查")

        valid_port = isinstance(port, int) and 0 < port < 65536
        valid = bool(candidate.name and host and valid_port) and candidate.error is None
        resolved.append(
            replace(
                candidate,
                host=host,
                port=port,
                username=username,
                key_path=key_path,
                warnings=tuple(dict.fromkeys(candidate_warnings)),
                valid=valid,
            )
        )
        warnings.extend(candidate_warnings)

    if unused_tokens_seen:
        warnings.append("部分 SSH 配置包含未识别占位符，请确认导入后配置")
    return ParseResult(
        candidates=resolved,
        errors=list(result.errors),
        warnings=list(dict.fromkeys(warnings)),
    )


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------

_HEADER_ALIASES: dict[str, str] = {
    "name": "name",
    "名称": "name",
    "主机名": "name",
    "host": "host",
    "地址": "host",
    "主机": "host",
    "主机地址": "host",
    "port": "port",
    "端口": "port",
    "username": "username",
    "user": "username",
    "用户名": "username",
    "auth_type": "auth_type",
    "auth": "auth_type",
    "认证": "auth_type",
    "认证方式": "auth_type",
    "key_path": "key_path",
    "私钥": "key_path",
    "密钥": "key_path",
    "tags": "tags",
    "标签": "tags",
    "disk_mounts": "disk_mounts",
    "磁盘目录": "disk_mounts",
    "挂载点": "disk_mounts",
    "group": "group",
    "分组": "group",
    "owner": "owner",
    "负责人": "owner",
    "location": "location",
    "位置": "location",
    "notes": "notes",
    "备注": "notes",
}


def _normalize_header(cell: str) -> str:
    return cell.strip().lstrip("\ufeff").strip().lower()


def _delimiter_for(text: str) -> str:
    sample = "\n".join(text.splitlines()[:10])
    try:
        return csv.Sniffer().sniff(sample, delimiters=",\t").delimiter
    except csv.Error:
        return ","


def _candidate_from_record(record: dict[str, str], row: int) -> tuple[HostCandidate | None, dict | None]:
    name = record.get("name", "").strip()
    host = record.get("host", "").strip()
    if not name or not host:
        return None, {"row": row, "error": "name 和 host 不能为空"}

    port = 22
    raw_port = record.get("port", "").strip()
    if raw_port:
        parsed_port = _int_or_none(raw_port)
        if parsed_port is None or not 0 < parsed_port < 65536:
            return None, {"row": row, "error": f"无效端口: {raw_port}"}
        port = parsed_port

    disk_mounts = _split_multi(record.get("disk_mounts", "")) or _DEFAULT_DISK_MOUNTS
    key_path = record.get("key_path", "").strip() or None

    candidate = HostCandidate(
        name=name,
        host=host,
        port=port,
        username=record.get("username", "").strip(),
        auth_type=record.get("auth_type", "").strip() or "key",
        key_path=key_path,
        tags=_split_multi(record.get("tags", "")),
        disk_mounts=disk_mounts,
        group=record.get("group", "").strip() or _DEFAULT_GROUP,
        owner=record.get("owner", "").strip(),
        location=record.get("location", "").strip(),
        notes=record.get("notes", "").strip(),
    )
    return candidate, None


def parse_csv(text: str | bytes) -> ParseResult:
    """Parse a delimited table (comma or tab) into host candidates."""

    text = _decode(text)
    delimiter = _delimiter_for(text)
    rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
    rows = [row for row in rows if any(cell.strip() for cell in row)]

    candidates: list[HostCandidate] = []
    errors: list[dict] = []
    warnings: list[str] = []

    if not rows:
        return ParseResult(candidates=candidates, errors=errors, warnings=warnings)

    header = rows[0]
    column_fields: list[str | None] = []
    seen: set[str] = set()
    for cell in header:
        canonical = _HEADER_ALIASES.get(_normalize_header(cell))
        if canonical is not None and canonical not in seen:
            seen.add(canonical)
            column_fields.append(canonical)
        else:
            column_fields.append(None)

    if "name" not in seen or "host" not in seen:
        errors.append({"row": 1, "error": "缺少必需列: name, host"})
        return ParseResult(candidates=candidates, errors=errors, warnings=warnings)

    for row_number, row in enumerate(rows[1:], start=2):
        record = {
            field_name: (row[index].strip() if index < len(row) else "")
            for index, field_name in enumerate(column_fields)
            if field_name is not None
        }
        candidate, error = _candidate_from_record(record, row_number)
        if error is not None:
            errors.append(error)
        elif candidate is not None:
            candidates.append(candidate)

    return ParseResult(candidates=candidates, errors=errors, warnings=warnings)


# ---------------------------------------------------------------------------
# YAML
# ---------------------------------------------------------------------------


def _yaml_tags(value: object) -> tuple[str, ...]:
    if isinstance(value, (list, tuple)):
        return tuple(str(item).strip() for item in value if item is not None and str(item).strip())
    return _split_multi(_as_text(value))


def _yaml_disk_mounts(value: object) -> tuple[str, ...]:
    mounts = _yaml_tags(value)
    return mounts or _DEFAULT_DISK_MOUNTS


def parse_yaml(text: str | bytes) -> ParseResult:
    """Parse a YAML host list (``hosts:`` key or a root list)."""

    text = _decode(text)
    candidates: list[HostCandidate] = []
    errors: list[dict] = []
    warnings: list[str] = []

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        errors.append({"row": None, "error": f"YAML 解析失败: {exc}"})
        return ParseResult(candidates=candidates, errors=errors, warnings=warnings)

    if data is None:
        return ParseResult(candidates=candidates, errors=errors, warnings=warnings)

    if isinstance(data, dict):
        if "hosts" not in data:
            errors.append({"row": None, "error": "YAML 根节点必须为列表或包含 hosts 列表"})
            return ParseResult(candidates=candidates, errors=errors, warnings=warnings)
        data = data["hosts"]

    if not isinstance(data, list):
        errors.append({"row": None, "error": "YAML 根节点必须为列表或包含 hosts 列表"})
        return ParseResult(candidates=candidates, errors=errors, warnings=warnings)

    for row_number, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            errors.append({"row": row_number, "error": "主机条目必须为映射"})
            continue
        name = _as_text(item.get("name"))
        host = _as_text(item.get("host"))
        if not name or not host:
            errors.append({"row": row_number, "error": "name 和 host 不能为空"})
            continue

        port = 22
        raw_port = item.get("port")
        if isinstance(raw_port, int) and not isinstance(raw_port, bool):
            if not 0 < raw_port < 65536:
                errors.append({"row": row_number, "error": f"无效端口: {raw_port}"})
                continue
            port = raw_port
        elif _as_text(raw_port):
            parsed_port = _int_or_none(_as_text(raw_port))
            if parsed_port is None or not 0 < parsed_port < 65536:
                errors.append({"row": row_number, "error": f"无效端口: {_as_text(raw_port)}"})
                continue
            port = parsed_port

        key_path = _as_text(item.get("key_path")) or None
        candidates.append(
            HostCandidate(
                name=name,
                host=host,
                port=port,
                username=_as_text(item.get("username")),
                auth_type=_as_text(item.get("auth_type")) or "key",
                key_path=key_path,
                tags=_yaml_tags(item.get("tags")),
                disk_mounts=_yaml_disk_mounts(item.get("disk_mounts")),
                group=_as_text(item.get("group")) or _DEFAULT_GROUP,
                owner=_as_text(item.get("owner")),
                location=_as_text(item.get("location")),
                notes=_as_text(item.get("notes")),
            )
        )

    return ParseResult(candidates=candidates, errors=errors, warnings=warnings)
