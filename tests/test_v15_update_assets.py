"""Static wiring checks for the v1.5 release and auto-update pipeline."""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

from servermanage import __version__


ROOT = Path(__file__).resolve().parents[1]


def test_version_is_synchronised():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    package = json.loads((ROOT / "desktop" / "package.json").read_text(encoding="utf-8"))
    assert pyproject["project"]["version"] == __version__
    assert package["version"] == __version__


def test_settings_page_exposes_update_card():
    html = (ROOT / "servermanage/web/templates/settings.html").read_text(encoding="utf-8")
    assert "软件更新" in html
    assert 'id="update-check-button"' in html
    assert "settings-update.js" in html
    script = (ROOT / "servermanage/web/static/settings-update.js").read_text(encoding="utf-8")
    assert "checkForUpdate" in script
    assert "downloadUpdate" in script
    assert "installUpdate" in script


def test_build_portable_uses_dynamic_version_and_ships_updater():
    script = (ROOT / "desktop/scripts/build-portable.ps1").read_text(encoding="utf-8-sig")
    assert "$appVersion" in script
    assert "服务器轮询监测工具-Windows-x64-v{0}.zip" in script
    assert "apply-update.ps1" in script


def test_release_workflow_publishes_zip_and_checksum():
    workflow = (ROOT / ".github/workflows/release-windows.yml").read_text(encoding="utf-8")
    assert "workflow_dispatch" in workflow
    assert "release/*.zip" in workflow
    assert "release/*.zip.sha256" in workflow
    assert "softprops/action-gh-release" in workflow
    assert re.search(r"tags:\s*\n\s*-\s*\"v\*\"", workflow)
