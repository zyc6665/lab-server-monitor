"""Disk health data models and storcli output parsers.

This module currently holds only the data models and the parsing helpers for
storcli output (Task 3). Health evaluation and SSH collection are added by a
later task and build on top of these public interfaces.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

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
