"""Static assertions for the PyInstaller backend sidecar packaging.

These tests do not run PyInstaller -- they only pin the contract of the
``packaging/backend.spec`` build definition and its ``build-backend.ps1``
driver so the desktop shell can rely on a stable onedir output layout.
"""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "packaging" / "backend.spec"
BUILD = ROOT / "packaging" / "build-backend.ps1"


def _read(path: Path) -> str:
    assert path.is_file(), f"missing file: {path}"
    return path.read_text(encoding="utf-8")


def test_spec_exists() -> None:
    assert SPEC.is_file()


def test_spec_names_backend_bundle() -> None:
    text = _read(SPEC)
    # COLLECT onedir name drives both the folder and the exe name.
    assert "servermonitor-backend" in text
    assert "name=\"servermonitor-backend\"" in text or "name='servermonitor-backend'" in text


def test_spec_is_headless() -> None:
    text = _read(SPEC)
    assert "console=False" in text


def test_spec_entrypoint_is_servermanage_main() -> None:
    text = _read(SPEC)
    assert "servermanage" in text
    assert "__main__.py" in text


def test_spec_resolves_project_root_by_probing_entrypoint() -> None:
    text = _read(SPEC)
    # Must not blindly use parent.parent; it probes for the package marker.
    assert "__main__.py" in text
    assert "is_file()" in text
    assert "SPECPATH" in text


def test_spec_datas_include_all_template_and_static_dirs() -> None:
    text = _read(SPEC)
    for expected in (
        "servermanage/templates",
        "servermanage/web/templates",
        "servermanage/web/static",
    ):
        assert expected in text, f"datas missing {expected}"


def test_spec_hiddenimports() -> None:
    text = _read(SPEC)
    for expected in (
        "waitress",
        "jinja2.ext",
        "servermanage.settings",
        "servermanage.security",
        "servermanage.disk_capacity",
        "winotify",
    ):
        assert expected in text, f"hiddenimports missing {expected}"


def test_build_script_uses_backend_spec() -> None:
    text = _read(BUILD)
    lowered = text.lower()
    assert "pyinstaller" in lowered
    assert "packaging/backend.spec" in lowered or "packaging\\backend.spec" in lowered


def test_build_script_checks_output_exe() -> None:
    text = _read(BUILD)
    normalized = text.replace("\\", "/")
    assert "dist/backend/servermonitor-backend/servermonitor-backend.exe" in normalized


def test_build_script_stops_on_error() -> None:
    text = _read(BUILD)
    assert "$ErrorActionPreference" in text
    assert "Stop" in text
