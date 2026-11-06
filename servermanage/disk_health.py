"""Disk health data models, storcli parsers, health rules and SSH collection.

Task 3 contributed the data models and the parsing helpers for storcli output.
Task 4 builds on those public interfaces: single-drive / virtual-drive health
evaluation plus :func:`collect_disk_health`, which probes storcli over SSH (as
root via ``sudo -n``) and turns its JSON output into a :class:`DiskHealthReport`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any

from servermanage.models import (
    DiskHealthConfig,
    DiskHealthRuleConfig,
    HostConfig,
    HostDiskHealthOverride,
    SSHRunner,
)

__all__ = [
    "StorcliParseError",
    "DiskControllerInfo",
    "VirtualDriveInfo",
    "PhysicalDriveInfo",
    "DiskHealthReport",
    "AlertEvent",
    "parse_temperature",
    "parse_controllers",
    "parse_virtual_drives",
    "parse_physical_drives",
    "parse_physical_drives_text",
    "evaluate_drive_health",
    "evaluate_virtual_drive_health",
    "collect_disk_health",
]


class StorcliParseError(ValueError):
    """Raised when storcli output cannot be parsed as JSON or text."""


@dataclass
class DiskControllerInfo:
    controller: int
    model: str | None = None
    firmware: str | None = None
    bbu_state: str | None = None
    health: str = "unknown"
    reasons: list[str] = field(default_factory=list)


@dataclass
class VirtualDriveInfo:
    controller: int
    vd_id: int
    raid_level: str | None = None
    state: str | None = None
    size: str | None = None
    health: str = "unknown"
    reasons: list[str] = field(default_factory=list)


@dataclass
class PhysicalDriveInfo:
    controller: int
    enclosure: int | None = None
    slot: int | None = None
    did: int | None = None
    model: str | None = None
    serial: str | None = None
    state: str | None = None
    media_errors: int | None = None
    other_errors: int | None = None
    predictive_failures: int | None = None
    smart_alert: bool | None = None
    temperature_c: int | None = None
    shield_counter: int | None = None
    health: str = "unknown"
    reasons: list[str] = field(default_factory=list)


@dataclass
class DiskHealthReport:
    host_name: str
    collected_at: datetime
    status: str = "ok"
    message: str | None = None
    controllers: list[DiskControllerInfo] = field(default_factory=list)
    virtual_drives: list[VirtualDriveInfo] = field(default_factory=list)
    physical_drives: list[PhysicalDriveInfo] = field(default_factory=list)


@dataclass
class AlertEvent:
    host_name: str
    category: str
    severity: str
    title: str
    message: str
    fingerprint: str


# ---------------------------------------------------------------------------
# Low-level conversion helpers. Missing / N/A values must become None, never 0.
# ---------------------------------------------------------------------------

_TRUE_WORDS = {"yes", "y", "true", "1"}
_FALSE_WORDS = {"no", "n", "false", "0"}
_MISSING_WORDS = {"", "-", "n/a", "na", "none", "null", "unknown"}

_TEMP_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*C\b", re.IGNORECASE)
_INT_RE = re.compile(r"-?\d+")


def _clean(value: Any) -> str | None:
    """Trim a textual field; treat empty / N/A-ish values as None."""
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _MISSING_WORDS:
        return None
    return text


def _to_int(value: Any) -> int | None:
    """Best-effort integer conversion; unparseable / missing -> None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if text.lower() in _MISSING_WORDS:
        return None
    match = _INT_RE.search(text)
    if not match:
        return None
    try:
        return int(match.group(0))
    except ValueError:  # pragma: no cover - defensive
        return None


def _to_bool(value: Any) -> bool | None:
    """Best-effort boolean conversion; missing / unknown -> None."""
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    text = str(value).strip().lower()
    if text in _TRUE_WORDS:
        return True
    if text in _FALSE_WORDS:
        return False
    return None


def parse_temperature(value: object) -> int | None:
    """Parse a storcli temperature value into integer Celsius.

    ``" 27C (80.60 F)"`` -> ``27``; ``"N/A"`` / ``None`` -> ``None``;
    a bare number (``31``) -> ``31``.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    if not text or text.lower() in _MISSING_WORDS:
        return None
    match = _TEMP_RE.search(text)
    if match:
        try:
            return int(float(match.group(1)))
        except ValueError:  # pragma: no cover - defensive
            return None
    # Fall back to a bare numeric string.
    try:
        return int(float(text))
    except ValueError:
        return None


def _norm_key(key: Any) -> str:
    """Normalise a key for case/whitespace/punctuation-insensitive matching."""
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def _flatten_pairs(obj: Any) -> list[tuple[str, object]]:
    """Recursively collect every leaf ``key -> value`` pair in *obj*.

    Keys keep their original spelling; matching (see :func:`_lookup`) is
    case/whitespace insensitive via :func:`_norm_key`.
    """
    pairs: list[tuple[str, object]] = []

    def _walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, (dict, list)):
                    _walk(value)
                else:
                    pairs.append((str(key), value))
        elif isinstance(node, list):
            for item in node:
                if isinstance(item, (dict, list)):
                    _walk(item)

    _walk(obj)
    return pairs


def _lookup(pairs: list[tuple[str, object]], *names: str) -> object | None:
    """Return the first value whose normalised key matches any of *names*."""
    targets = {_norm_key(name) for name in names}
    for key, value in pairs:
        if _norm_key(key) in targets:
            return value
    return None


def _first_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                return item
        return {}
    if isinstance(value, dict):
        return value
    return {}


# ---------------------------------------------------------------------------
# JSON loading (tolerant of stray leading/trailing console noise).
# ---------------------------------------------------------------------------

def _load_json(text: str) -> Any:
    if not isinstance(text, str):
        raise StorcliParseError("storcli output must be a string")
    cleaned = text.lstrip("\ufeff").strip()
    if not cleaned:
        raise StorcliParseError("empty storcli output")
    candidates = [idx for idx in (cleaned.find("{"), cleaned.find("[")) if idx >= 0]
    if not candidates:
        raise StorcliParseError("no JSON object found in storcli output")
    start = min(candidates)
    try:
        obj, _end = json.JSONDecoder().raw_decode(cleaned[start:])
    except json.JSONDecodeError as exc:
        raise StorcliParseError(f"invalid storcli JSON: {exc}") from exc
    return obj


def _controllers(obj: Any) -> list[dict[str, Any]]:
    if not isinstance(obj, dict):
        raise StorcliParseError("storcli JSON is not an object")
    controllers = obj.get("Controllers")
    if not isinstance(controllers, list):
        raise StorcliParseError("storcli JSON has no 'Controllers' list")
    return [c for c in controllers if isinstance(c, dict)]


# ---------------------------------------------------------------------------
# /cALL show J -> controllers
# ---------------------------------------------------------------------------

def _extract_bbu_state(response_data: dict[str, Any]) -> str | None:
    for key in ("Cachevault_Info", "BBU_Info", "BBU"):
        value = response_data.get(key)
        block = _first_dict(value)
        if block:
            state = block.get("State") or block.get("Type")
            cleaned = _clean(state)
            if cleaned is not None:
                return cleaned
    return None


def parse_controllers(text: str) -> list[DiskControllerInfo]:
    """Parse ``/cALL show J`` output into controller records."""
    controllers = _controllers(_load_json(text))
    result: list[DiskControllerInfo] = []
    for index, raw in enumerate(controllers):
        status = raw.get("Command Status")
        status = status if isinstance(status, dict) else {}
        response = raw.get("Response Data")
        response = response if isinstance(response, dict) else {}

        controller = _to_int(status.get("Controller"))
        if controller is None:
            controller = index

        pairs = _flatten_pairs(response)
        model = _clean(_lookup(pairs, "Product Name"))
        firmware = _clean(_lookup(pairs, "FW Version"))

        result.append(
            DiskControllerInfo(
                controller=controller,
                model=model,
                firmware=firmware,
                bbu_state=_extract_bbu_state(response),
            )
        )
    return result


# ---------------------------------------------------------------------------
# /cX/vall show J -> virtual drives
# ---------------------------------------------------------------------------

def _virtual_drive_id(raw: dict[str, Any]) -> int:
    dg_vd = raw.get("DG/VD")
    if isinstance(dg_vd, str) and "/" in dg_vd:
        candidate = _to_int(dg_vd.rsplit("/", 1)[-1])
        if candidate is not None:
            return candidate
    for key in ("VD", "VD ID", "VDID"):
        candidate = _to_int(raw.get(key))
        if candidate is not None:
            return candidate
    return 0


def parse_virtual_drives(text: str, controller: int) -> list[VirtualDriveInfo]:
    """Parse ``/cX/vall show J`` output into virtual drive records."""
    result: list[VirtualDriveInfo] = []
    for raw_controller in _controllers(_load_json(text)):
        response = raw_controller.get("Response Data")
        response = response if isinstance(response, dict) else {}
        vds = response.get("Virtual Drives")
        if not isinstance(vds, list):
            vds = response.get("VD LIST")
        if not isinstance(vds, list):
            continue
        for raw in vds:
            if not isinstance(raw, dict):
                continue
            result.append(
                VirtualDriveInfo(
                    controller=controller,
                    vd_id=_virtual_drive_id(raw),
                    raid_level=_clean(raw.get("TYPE") or raw.get("Type")),
                    state=_clean(raw.get("State")),
                    size=_clean(raw.get("Size")),
                )
            )
    return result


# ---------------------------------------------------------------------------
# /cX/eall/sall show all J -> physical drives (JSON first, text fallback)
# ---------------------------------------------------------------------------

_BASE_DRIVE_KEY_RE = re.compile(r"^Drive /c(\d+)/e(\d+)/s(\d+)$")
_TEXT_DRIVE_HEADER_RE = re.compile(
    r"Drive /c(\d+)/e(\d+)/s(\d+)(?: - Detailed Information|\s+State)?:?"
)
_TEXT_KV_RE = re.compile(r"^\s*([^=]+?)\s*=\s*(.*?)\s*$")


def _parse_physical_drives_json(text: str) -> list[PhysicalDriveInfo]:
    drives: list[PhysicalDriveInfo] = []
    for raw_controller in _controllers(_load_json(text)):
        status = raw_controller.get("Command Status")
        status = status if isinstance(status, dict) else {}
        response = raw_controller.get("Response Data")
        response = response if isinstance(response, dict) else {}

        fallback_controller = _to_int(status.get("Controller"))

        for base_key, value in response.items():
            match = _BASE_DRIVE_KEY_RE.match(str(base_key).strip())
            if not match:
                continue
            ctrl_num = int(match.group(1))
            enclosure = int(match.group(2))
            slot = int(match.group(3))

            base_item = _first_dict(value)
            detail = response.get(f"{base_key} - Detailed Information")
            pairs = _flatten_pairs(detail) if detail is not None else []

            controller = ctrl_num if ctrl_num is not None else fallback_controller
            model = _clean(_lookup(pairs, "Model Number")) or _clean(base_item.get("Model"))

            drives.append(
                PhysicalDriveInfo(
                    controller=controller,
                    enclosure=enclosure,
                    slot=slot,
                    did=_to_int(base_item.get("DID")),
                    model=model,
                    serial=_clean(_lookup(pairs, "SN")),
                    state=_clean(base_item.get("State")),
                    media_errors=_to_int(_lookup(pairs, "Media Error Count")),
                    other_errors=_to_int(_lookup(pairs, "Other Error Count")),
                    predictive_failures=_to_int(_lookup(pairs, "Predictive Failure Count")),
                    smart_alert=_to_bool(
                        _lookup(pairs, "S.M.A.R.T alert flagged by drive")
                    ),
                    temperature_c=parse_temperature(_lookup(pairs, "Drive Temperature")),
                    shield_counter=_to_int(_lookup(pairs, "Shield Counter")),
                )
            )
    return drives


def parse_physical_drives_text(text: str) -> list[PhysicalDriveInfo]:
    """Parse human-readable ``show all`` text output into physical drive records."""
    if not isinstance(text, str):
        raise StorcliParseError("storcli output must be a string")

    drives: dict[tuple[int, int, int], PhysicalDriveInfo] = {}
    order: list[tuple[int, int, int]] = []
    current: PhysicalDriveInfo | None = None

    for line in text.splitlines():
        header = _TEXT_DRIVE_HEADER_RE.search(line)
        if header:
            key = (int(header.group(1)), int(header.group(2)), int(header.group(3)))
            if key not in drives:
                drives[key] = PhysicalDriveInfo(
                    controller=key[0], enclosure=key[1], slot=key[2]
                )
                order.append(key)
            current = drives[key]
            continue

        if current is None:
            continue
        match = _TEXT_KV_RE.match(line)
        if not match:
            continue

        name = _norm_key(match.group(1))
        value = match.group(2).strip()
        if name == "mediaerrorcount":
            current.media_errors = _to_int(value)
        elif name == "othererrorcount":
            current.other_errors = _to_int(value)
        elif name == "predictivefailurecount":
            current.predictive_failures = _to_int(value)
        elif name == "drivetemperature":
            current.temperature_c = parse_temperature(value)
        elif name == "smartalertflaggedbydrive":
            current.smart_alert = _to_bool(value)
        elif name == "shieldcounter":
            current.shield_counter = _to_int(value)
        elif name == "sn":
            current.serial = _clean(value)
        elif name == "modelnumber":
            current.model = _clean(value)

    return [drives[key] for key in order]


def parse_physical_drives(text: str) -> list[PhysicalDriveInfo]:
    """Parse ``/cX/eall/sall show all J`` output.

    JSON is tried first; on any JSON parse failure the text parser is used as a
    fallback. :class:`StorcliParseError` is raised only when both approaches
    fail to yield a usable result.
    """
    try:
        return _parse_physical_drives_json(text)
    except StorcliParseError as json_error:
        drives = parse_physical_drives_text(text)
        if drives:
            return drives
        raise StorcliParseError(
            "unable to parse storcli physical drive output as JSON or text"
        ) from json_error


# ---------------------------------------------------------------------------
# Health evaluation (design section 7.2)
# ---------------------------------------------------------------------------

# A physical drive in one of these states is failed and needs replacing.
_CRITICAL_STATES = {"failed", "offline", "offln", "missing"}
# A physical drive in one of these states is rebuilding / degraded.
_WARNING_STATES = {"rebuild", "rbld", "copyback", "degraded"}

_VD_OPTIMAL_STATES = {"optimal", "optl", "online", "onln"}
_VD_CRITICAL_STATES = {"failed", "offline", "offln", "missing"}
_VD_WARNING_STATES = {
    "degraded",
    "partially degraded",
    "partiallydegraded",
    "rbld",
    "rebuild",
    "copyback",
    "init",
    "initializing",
    "dgrd",
}

_BBU_FAILURE_WORDS = {
    "failed",
    "failure",
    "fault",
    "faulty",
    "bad",
    "degraded",
    "critical",
    "offline",
    "missing",
    "replace",
}


def _state_word(value: Any) -> str:
    """Normalise a storcli state string for comparison ("" when absent)."""
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value).strip().lower())


def _increased(current: int | None, previous: int | None) -> bool:
    """True only when both counters are known and *current* grew.

    Missing values are ``None`` (never 0), so an unknown previous counter cannot
    be used as evidence of an increase.
    """
    return current is not None and previous is not None and current > previous


def evaluate_drive_health(
    drive: PhysicalDriveInfo,
    *,
    rules: DiskHealthRuleConfig,
    temperature_threshold_c: float = 55.0,
    previous: PhysicalDriveInfo | None = None,
) -> PhysicalDriveInfo:
    """Return a copy of *drive* with ``health`` and machine-code ``reasons`` set.

    Reason codes: ``state_failed`` / ``state_degraded`` / ``predictive_failure``
    / ``smart_flag`` / ``media_errors`` / ``other_errors`` / ``error_increase``
    / ``temperature``.  The input object is never mutated.
    """
    reasons: list[str] = []
    critical = False
    warning = False

    state = _state_word(drive.state)
    if rules.alert_on_state_not_optimal:
        if state in _CRITICAL_STATES:
            reasons.append("state_failed")
            critical = True
        elif state in _WARNING_STATES:
            reasons.append("state_degraded")
            warning = True

    if (
        rules.alert_on_predictive_failure
        and drive.predictive_failures is not None
        and drive.predictive_failures > 0
    ):
        reasons.append("predictive_failure")
        warning = True

    if rules.alert_on_smart_flag and drive.smart_alert is True:
        reasons.append("smart_flag")
        warning = True

    if (
        rules.alert_on_media_errors
        and drive.media_errors is not None
        and drive.media_errors > 0
    ):
        reasons.append("media_errors")
        warning = True

    if (
        rules.alert_on_other_errors
        and drive.other_errors is not None
        and drive.other_errors > 0
    ):
        reasons.append("other_errors")
        warning = True

    if rules.alert_on_error_increase and previous is not None:
        if _increased(drive.media_errors, previous.media_errors) or _increased(
            drive.other_errors, previous.other_errors
        ):
            reasons.append("error_increase")
            warning = True

    if (
        drive.temperature_c is not None
        and temperature_threshold_c is not None
        and drive.temperature_c > temperature_threshold_c
    ):
        reasons.append("temperature")
        warning = True

    if critical:
        health = "critical"
    elif warning:
        health = "warning"
    else:
        health = "healthy"

    return replace(drive, health=health, reasons=reasons)


def evaluate_virtual_drive_health(vd: VirtualDriveInfo) -> VirtualDriveInfo:
    """Return a copy of *vd* with ``health``/``reasons`` based on its state.

    Only *Optimal* is healthy; a degraded/rebuilding VD is a warning and an
    offline/failed/missing VD is critical.  An unknown/missing state stays
    ``unknown`` (never silently healthy).
    """
    state = _state_word(vd.state)
    if not state:
        return replace(vd, health="unknown", reasons=[])
    if state in _VD_CRITICAL_STATES:
        return replace(vd, health="critical", reasons=["state_failed"])
    if state in _VD_OPTIMAL_STATES:
        return replace(vd, health="healthy", reasons=[])
    if state in _VD_WARNING_STATES:
        return replace(vd, health="warning", reasons=["state_degraded"])
    # "VD State 非 Optimal → warning" (design 7.2): any other known state warns.
    return replace(vd, health="warning", reasons=["state_degraded"])


def _evaluate_controller_health(
    controller: DiskControllerInfo,
) -> DiskControllerInfo:
    """Fill controller health from its BBU/CacheVault state when it is known."""
    bbu = _state_word(controller.bbu_state)
    if not bbu:
        return controller
    if any(word in bbu for word in _BBU_FAILURE_WORDS):
        return replace(controller, health="warning", reasons=["bbu_not_optimal"])
    return replace(controller, health="healthy", reasons=[])


# ---------------------------------------------------------------------------
# SSH collection
# ---------------------------------------------------------------------------

_PERMISSION_MARKERS = ("password is required", "not in the sudoers", "permission")
_NO_CONTROLLER_MARKER = "no controller found"


def _looks_permission_error(*texts: str | None) -> bool:
    """True when any of *texts* (stdout and/or stderr) mentions a sudo failure.

    Some storcli builds print permission problems to stdout rather than stderr,
    so callers pass both streams through here instead of inspecting stderr only.
    """
    lowered = " ".join((text or "") for text in texts).lower()
    return any(marker in lowered for marker in _PERMISSION_MARKERS)


def _brief(text: str | None, limit: int = 300) -> str:
    value = (text or "").strip()
    if len(value) > limit:
        return value[:limit] + "..."
    return value


def collect_disk_health(
    host: HostConfig,
    runner: SSHRunner,
    *,
    config: DiskHealthConfig,
    command_timeout: int,
    previous: DiskHealthReport | None = None,
    override: HostDiskHealthOverride | None = None,
    now: datetime | None = None,
) -> DiskHealthReport:
    """Collect one host's disk health over SSH using storcli.

    Never raises for an operational failure and never fabricates drives: any
    problem yields a report whose ``status`` reflects the real condition.

    Status vocabulary (consumers in Task 10/12 must treat **every** non-``ok``
    status as "disk health unavailable", never as healthy):

    - ``ok``: collection succeeded with no warnings.
    - ``permission_denied``: storcli needs root/免密 sudo that is not available
      (or a non-sudo run reports "No Controller found").
    - ``no_storcli``: none of the candidate storcli binaries could be run.
    - ``no_controller``: storcli ran but reported no controllers.
    - ``error``: a transport/parse failure prevented collection entirely.
    - ``degraded``: some per-controller data was collected but at least one
      query failed; only the successfully collected drives are reported.
    """
    collected_at = now if now is not None else datetime.now(timezone.utc)
    effective = override if override is not None else host.disk_health

    if effective is not None and effective.storcli_path:
        candidates: list[str] = [effective.storcli_path]
    else:
        candidates = list(config.storcli_candidates)

    if effective is not None and effective.use_sudo is not None:
        use_sudo = effective.use_sudo
    else:
        use_sudo = config.use_sudo
    prefix = "sudo -n " if use_sudo else ""

    def _report(status: str, message: str | None, **kwargs: Any) -> DiskHealthReport:
        return DiskHealthReport(
            host_name=host.name,
            collected_at=collected_at,
            status=status,
            message=message,
            **kwargs,
        )

    if not candidates:
        return _report("no_storcli", "未配置 storcli 候选路径")

    # 1. Probe candidates in order; the first one that exits 0 is used.
    storcli: str | None = None
    probe_errors: list[str] = []
    for candidate in candidates:
        try:
            result = runner.run(f"{prefix}{candidate} -v", command_timeout)
        except Exception as exc:  # SSH transport errors must not crash polling.
            probe_errors.append(f"{candidate}: {exc}")
            continue
        if result.exit_status == 0:
            storcli = candidate
            break
        detail = " ".join(
            part for part in (_brief(result.stderr), _brief(result.stdout)) if part
        ) or (f"exit {result.exit_status}")
        probe_errors.append(f"{candidate}: {detail}")

    if storcli is None:
        if any(_looks_permission_error(item) for item in probe_errors):
            return _report(
                "permission_denied",
                "sudo 权限不足，无法以 root 运行 storcli；请配置免密 sudo（NOPASSWD）后重试。",
            )
        return _report(
            "no_storcli",
            "未找到可用的 storcli 可执行文件：" + "; ".join(probe_errors),
        )

    # 2. Enumerate controllers.
    try:
        controllers_result = runner.run(
            f"{prefix}{storcli} /cALL show J", command_timeout
        )
    except Exception as exc:  # SSH transport errors must not crash a poll cycle.
        return _report("error", f"storcli /cALL show J 执行异常：{exc}")

    if controllers_result.exit_status != 0:
        if _looks_permission_error(
            controllers_result.stderr, controllers_result.stdout
        ):
            return _report(
                "permission_denied",
                "sudo 权限不足，无法以 root 运行 storcli；请配置免密 sudo（NOPASSWD）后重试。",
            )
        return _report(
            "error",
            "storcli /cALL show J 执行失败（exit "
            f"{controllers_result.exit_status}）：{_brief(controllers_result.stderr or controllers_result.stdout)}",
        )

    # Interpret the raw stdout *before* parsing: a genuinely controller-less
    # host reports empty output or "No Controller found" (no JSON at all), which
    # ``parse_controllers`` would reject as a generic parse error.  A non-sudo
    # storcli cannot see controllers, so that text is a permission artefact.
    raw_stdout = controllers_result.stdout or ""
    stripped_stdout = raw_stdout.strip()
    if not stripped_stdout or _NO_CONTROLLER_MARKER in stripped_stdout.lower():
        if not use_sudo:
            return _report(
                "permission_denied",
                "storcli 未提权运行且未报告控制器（空输出 / No Controller found）；"
                "非 root 的 storcli 无法看到控制器，请以 root（sudo）运行。",
            )
        return _report("no_controller", "storcli 未发现任何控制器")

    try:
        controllers = parse_controllers(raw_stdout)
    except StorcliParseError as exc:
        return _report("error", f"无法解析控制器输出：{exc}")

    if not controllers:
        # Parsed cleanly (e.g. ``{"Controllers": []}``) but no controllers.
        return _report("no_controller", "storcli 未发现任何控制器")

    # 3. Virtual drives and physical drives per controller.
    virtual_drives: list[VirtualDriveInfo] = []
    physical_drives: list[PhysicalDriveInfo] = []
    warnings: list[str] = []

    for controller in controllers:
        cid = controller.controller

        try:
            vd_result = runner.run(
                f"{prefix}{storcli} /c{cid}/vall show J", command_timeout
            )
        except Exception as exc:  # SSH transport errors must not crash a poll cycle.
            warnings.append(f"控制器 {cid} 虚拟盘查询异常：{exc}")
        else:
            if vd_result.exit_status != 0:
                warnings.append(
                    f"控制器 {cid} 虚拟盘查询失败：{_brief(vd_result.stderr or vd_result.stdout)}"
                )
            else:
                try:
                    virtual_drives.extend(parse_virtual_drives(vd_result.stdout, cid))
                except StorcliParseError as exc:
                    warnings.append(f"控制器 {cid} 虚拟盘解析失败：{exc}")

        try:
            pd_result = runner.run(
                f"{prefix}{storcli} /c{cid}/eall/sall show all J", command_timeout
            )
        except Exception as exc:  # Skip this controller's drives, keep the rest.
            warnings.append(f"控制器 {cid} 物理盘查询异常：{exc}")
            continue
        if pd_result.exit_status != 0:
            warnings.append(
                f"控制器 {cid} 物理盘查询失败：{_brief(pd_result.stderr or pd_result.stdout)}"
            )
            continue
        try:
            physical_drives.extend(parse_physical_drives(pd_result.stdout))
        except StorcliParseError as exc:
            warnings.append(f"控制器 {cid} 物理盘解析失败：{exc}")

    # 4. Evaluate health, matching the previous snapshot by slot identity.
    previous_index: dict[tuple[int, int | None, int | None], PhysicalDriveInfo] = {}
    if previous is not None:
        for item in previous.physical_drives:
            previous_index[(item.controller, item.enclosure, item.slot)] = item

    evaluated: list[PhysicalDriveInfo] = []
    for drive in physical_drives:
        prior = previous_index.get((drive.controller, drive.enclosure, drive.slot))
        evaluated.append(
            evaluate_drive_health(drive, rules=config.rules, previous=prior)
        )

    evaluated_controllers = [_evaluate_controller_health(c) for c in controllers]
    evaluated_virtual = [evaluate_virtual_drive_health(v) for v in virtual_drives]

    if warnings and not physical_drives and not virtual_drives:
        # Every controller failed and nothing usable came back: this is an
        # error, not a healthy-looking "ok"/"degraded" empty report.
        status = "error"
    elif warnings:
        status = "degraded"
    else:
        status = "ok"
    message = "; ".join(warnings) if warnings else None
    return _report(
        status,
        message,
        controllers=evaluated_controllers,
        virtual_drives=evaluated_virtual,
        physical_drives=evaluated,
    )
