"""Synchronise the project version across the Python package and desktop app."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYPROJECT = ROOT / "pyproject.toml"
PACKAGE_JSON = ROOT / "desktop" / "package.json"
INIT_PY = ROOT / "servermanage" / "__init__.py"


def _replace_pyproject(text: str, version: str) -> str:
    updated, count = re.subn(
        r'(?m)^version\s*=\s*"[^"]+"',
        f'version = "{version}"',
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit("pyproject.toml version not found")
    return updated


def _replace_init(text: str, version: str) -> str:
    updated, count = re.subn(
        r'(?m)^__version__\s*=\s*"[^"]+"',
        f'__version__ = "{version}"',
        text,
        count=1,
    )
    if count != 1:
        raise SystemExit("servermanage/__init__.py __version__ not found")
    return updated


def bump(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"invalid version: {version}")

    pyproject = PYPROJECT.read_text(encoding="utf-8")
    PYPROJECT.write_text(
        _replace_pyproject(pyproject, version), encoding="utf-8", newline="\n"
    )

    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    package["version"] = version
    PACKAGE_JSON.write_text(
        json.dumps(package, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    init_text = INIT_PY.read_text(encoding="utf-8")
    INIT_PY.write_text(
        _replace_init(init_text, version), encoding="utf-8", newline="\n"
    )


VERSION_RE = re.compile(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?')


def _read_versions() -> dict[str, str]:
    pyproject = PYPROJECT.read_text(encoding="utf-8")
    init_text = INIT_PY.read_text(encoding="utf-8")
    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    py_match = re.search(r'(?m)^version\s*=\s*"([^"]+)"', pyproject)
    init_match = re.search(r'(?m)^__version__\s*=\s*"([^"]+)"', init_text)
    return {
        "pyproject.toml": py_match.group(1) if py_match else "",
        "servermanage/__init__.py": init_match.group(1) if init_match else "",
        "desktop/package.json": str(package.get("version") or ""),
    }


def check() -> list[str]:
    """Return a list of problems; empty means the three version files agree."""
    versions = _read_versions()
    problems: list[str] = []
    for path, version in versions.items():
        if not VERSION_RE.fullmatch(version):
            problems.append(f"{path}: missing or malformed version {version!r}")
    if not problems and len(set(versions.values())) != 1:
        detail = ", ".join(f"{path}={version}" for path, version in versions.items())
        problems.append(f"version files disagree: {detail}")
    return problems


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", nargs="?", help="semantic version, e.g. 1.5.0")
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the three version files agree instead of bumping",
    )
    args = parser.parse_args()
    if args.check:
        problems = check()
        if problems:
            for problem in problems:
                print(f"ERROR: {problem}")
            return 1
        versions = _read_versions()
        print(f"version consistent: {next(iter(versions.values()))}")
        return 0
    if not args.version:
        parser.error("version is required unless --check is given")
    bump(args.version)
    print(f"version updated to {args.version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
