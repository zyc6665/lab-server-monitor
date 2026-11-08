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
    return re.sub(
        r'(?m)^version\s*=\s*"[^"]+"',
        f'version = "{version}"',
        text,
        count=1,
    )


def _replace_init(text: str, version: str) -> str:
    return re.sub(
        r'(?m)^__version__\s*=\s*"[^"]+"',
        f'__version__ = "{version}"',
        text,
        count=1,
    )


def bump(version: str) -> None:
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise SystemExit(f"invalid version: {version}")

    pyproject = PYPROJECT.read_text(encoding="utf-8")
    updated = _replace_pyproject(pyproject, version)
    if updated == pyproject:
        raise SystemExit("pyproject.toml version not found")
    PYPROJECT.write_text(updated, encoding="utf-8", newline="\n")

    package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    package["version"] = version
    PACKAGE_JSON.write_text(
        json.dumps(package, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )

    init_text = INIT_PY.read_text(encoding="utf-8")
    updated_init = _replace_init(init_text, version)
    if updated_init == init_text:
        raise SystemExit("servermanage/__init__.py __version__ not found")
    INIT_PY.write_text(updated_init, encoding="utf-8", newline="\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="semantic version, e.g. 1.5.0")
    args = parser.parse_args()
    bump(args.version)
    print(f"version updated to {args.version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
