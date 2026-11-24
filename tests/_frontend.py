"""Helpers for reading the front-end source as one logical unit.

M2 split ``app.js`` into ES modules (``lib/*.js`` + ``pages/*.js``).  Existing
tests assert on source fragments to lock behaviour, so they read the whole
bundle instead of only the entry file — the protection stays, the file layout
is free to change.
"""
from __future__ import annotations

from pathlib import Path


def app_js_source(static_dir: Path) -> str:
    """Return app.js plus every module it (transitively) imports."""
    parts = [static_dir / "app.js"]
    parts.extend(sorted((static_dir / "lib").glob("*.js")))
    parts.extend(sorted((static_dir / "pages").glob("*.js")))
    return "\n".join(path.read_text(encoding="utf-8") for path in parts)


def routes_source(web_dir: Path) -> str:
    """Return the routes package source (M1 split it out of routes.py)."""
    package = web_dir / "routes"
    return "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(package.glob("*.py"))
    )
