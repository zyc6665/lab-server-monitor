"""v0.1.214：错误与提示统一走页面内 toast，不再用阻塞 alert。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"


def test_no_blocking_alert_left_in_static_scripts():
    for path in STATIC.glob("*.js"):
        text = path.read_text(encoding="utf-8")
        assert "window.alert(" not in text, path.name


def test_settings_uses_toast_for_save_errors():
    js = (STATIC / "settings.js").read_text(encoding="utf-8")
    assert js.count("toast(error.message, true);") == 2


def test_health_page_has_local_flash_helper():
    js = (STATIC / "settings-health.js").read_text(encoding="utf-8")
    assert "function flash(message, isError)" in js
    assert "flash('数据库已恢复，请关闭并重新打开工具使配置生效。', false);" in js
