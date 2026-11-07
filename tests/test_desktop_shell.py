from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_electron_frameless_and_titlebar_ipc() -> None:
    main = (ROOT / "desktop" / "electron" / "main.js").read_text(encoding="utf-8")
    preload = (ROOT / "desktop" / "electron" / "preload.js").read_text(encoding="utf-8")
    titlebar = (ROOT / "servermanage" / "web" / "static" / "titlebar.js").read_text(encoding="utf-8")
    assert "frame: false" in main
    assert "window:action" in main
    assert "windowAction" in preload
    assert "data-window-action" in titlebar


def test_desktop_mode_is_loopback_only() -> None:
    app_py = (ROOT / "servermanage" / "app.py").read_text(encoding="utf-8")
    example = (ROOT / "config" / "config.yaml.example").read_text(encoding="utf-8")
    assert 'host = "127.0.0.1"' in app_py
    assert 'host: "127.0.0.1"' in example
    build = (ROOT / "desktop" / "scripts" / "build-portable.ps1").read_text(encoding="utf-8")
    assert "允许局域网访问.ps1" not in build
