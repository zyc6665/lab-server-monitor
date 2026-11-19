"""v0.1.225：看板视觉走查（亮/暗双主题截图）发现的问题修复。

- 分组概览「在线」永远是 0：读取了不存在的 ``host.status`` 字段，
  实际 API 字段是布尔 ``host.online``；
- 分组概览卡片在窄宽度下组名与数字换行错位，改为两行卡片布局；
- 磁盘健康页「只看异常盘」复选框重复渲染两次（同一 id，第二个是死 UI），
  筛选行不再挤压换行；
- 用户页主机卡片底部信息从括号中间断行；
- 设置页独立 toast 统一为全局样式；
- 无 SettingsService 的部署里 ``/settings`` 因 key_path 是 ``Path`` 对象
  无法 JSON 序列化而 500。
"""

from __future__ import annotations

import json
from pathlib import Path

from servermanage.config import load_config_from_mapping
from servermanage.web.routes import _settings_snapshot

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# 分组概览：在线数 bug + 两行卡片
# ---------------------------------------------------------------------------


def test_group_summary_counts_online_hosts():
    script = _read("app.js")
    assert "if (host.online) { bucket.online += 1; }" in script
    assert "host.status === 'online'" not in script


def test_group_summary_card_two_row_layout():
    script = _read("app.js")
    assert "top.className = 'group-summary-top';" in script
    css = _read("style.css")
    assert ".group-summary-top { display: flex;" in css
    assert ".group-summary-name { font-weight: 600; font-size: 13px; white-space: nowrap;" in css
    assert ".group-summary-meta { font-size: 11.5px;" in css and "text-overflow: ellipsis" in css


# ---------------------------------------------------------------------------
# 磁盘健康页：重复复选框 + 筛选行布局
# ---------------------------------------------------------------------------


def test_disk_template_has_single_bad_drive_toggle():
    html = (TEMPLATES / "disk_health.html").read_text(encoding="utf-8")
    assert html.count('id="disk-only-bad"') == 1


def test_disk_filter_row_wraps_cleanly():
    css = _read("style.css")
    assert "flex-wrap: wrap;" in css.split(".disk-filter {", 1)[1][:400]
    assert ".disk-filter .disk-legend { margin: 0; flex-basis: 100%; }" in css
    assert ".disk-groups-toggle { white-space: nowrap; }" in css


# ---------------------------------------------------------------------------
# 用户页卡片 footer 不再从词组中间断行
# ---------------------------------------------------------------------------


def test_user_host_foot_wraps_as_units():
    css = _read("style.css")
    assert ".user-host-foot > span { white-space: nowrap; min-width: 0; }" in css


# ---------------------------------------------------------------------------
# 设置页 toast 统一 + 无 service 模式的 Path 序列化
# ---------------------------------------------------------------------------


def test_settings_toast_uses_global_style():
    script = _read("settings.js")
    assert "window.servermonitorToast" in script


def test_settings_snapshot_serializes_path_key(tmp_path: Path):
    key_file = tmp_path / "id_ed25519"
    key_file.write_text("dummy", encoding="utf-8")
    config = load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "username": "root",
                    "auth": {"type": "key", "key_path": str(key_file)},
                }
            ],
        }
    )
    payload = _settings_snapshot(config)
    # 修复前 auth.key_path 是 Path 对象，json.dumps 直接抛 TypeError。
    assert json.dumps(payload, ensure_ascii=False)
    assert payload["hosts"][0]["key_path"] == str(key_file)
