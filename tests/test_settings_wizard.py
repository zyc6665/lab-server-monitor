from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def test_settings_wizard_markup_and_assets() -> None:
    html = (TEMPLATES / "settings.html").read_text(encoding="utf-8")
    assert "连接向导" in html
    assert 'id="wizard-overlay"' in html
    assert 'data-wizard-field="host"' in html
    assert 'data-step-panel="2"' in html
    assert "settings-wizard.js" in html
    assert "settings-wizard.css" in html
    assert (STATIC / "settings-wizard.js").is_file()
    assert (STATIC / "settings-wizard.css").is_file()


def test_settings_wizard_uses_probe_and_csrf() -> None:
    js = (STATIC / "settings-wizard.js").read_text(encoding="utf-8")
    assert "/api/settings/hosts/probe" in js
    assert "X-CSRF-Token" in js
    assert "private_key" in js
    assert "disk_mounts" in js
    assert "Array.isArray(result.mounts)" in js
