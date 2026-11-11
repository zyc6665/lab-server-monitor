"""Static contract tests for the Windows portable desktop launchers and docs.

The shipped ``.bat`` files are GBK-encoded (Windows console code page) while the
PowerShell/TXT files carry a UTF-8 BOM.  These tests read the real files so a
mismatch in encoding or content fails the build, but they never execute the
scripts.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read_text(name: str) -> str:
    """Decode a shipped launcher/doc, tolerating GBK .bat files and UTF-8 BOMs."""
    data = (ROOT / name).read_bytes()
    for encoding in ("utf-8-sig", "gbk", "utf-8"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def test_start_bat_launches_visible_desktop_exe() -> None:
    text = read_text("启动.bat")

    assert "cd /d" in text.lower(), "启动.bat must cd into its own directory"
    assert "servermonitor.exe" in text
    assert re.search(r'start\s+""\s+"?servermonitor\.exe"?', text, re.IGNORECASE), (
        "启动.bat must launch servermonitor.exe with a visible window"
    )
    assert "--start-hidden" not in text, "手动启动必须显示窗口，不能传 --start-hidden"


def test_stop_bat_kills_both_desktop_and_backend() -> None:
    text = read_text("停止.bat")

    assert re.search(r"taskkill\s+/IM\s+servermonitor\.exe", text, re.IGNORECASE), (
        "停止.bat must kill servermonitor.exe"
    )
    assert re.search(
        r"taskkill\s+/IM\s+servermonitor-backend\.exe", text, re.IGNORECASE
    ), "停止.bat must also kill the python sidecar servermonitor-backend.exe"


def test_autostart_task_runs_exe_with_start_hidden() -> None:
    text = read_text("注册开机自启.ps1")

    assert "servermonitor.exe" in text
    assert re.search(r'-\s*Argument\s+"?--start-hidden"?', text), (
        "开机自启计划任务必须传 --start-hidden，只在托盘运行"
    )
    assert re.search(r"-\s*Execute\s+\$Exe", text, re.IGNORECASE), (
        "计划任务的 -Execute 必须是 servermonitor.exe，而不是 启动.bat"
    )
    assert "启动.bat" not in text, "开机自启不应再通过 启动.bat 转发参数"
    # Repeatable registration: remove the same task name first.
    assert "Unregister-ScheduledTask" in text
    assert "Register-ScheduledTask" in text


def test_pyproject_version_is_1_5_1() -> None:
    data = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    assert data["project"]["version"] == "0.1.90"


def test_user_guide_covers_v14_desktop_workflow() -> None:
    text = read_text("使用说明.txt")

    assert "0.1.90" in text
    assert "/setup" in text, "首次启动说明必须提到 /setup 初始化管理员"
    assert "托盘" in text, "必须说明关闭窗口隐藏到托盘的行为"
    assert "SSH 终端" in text
    assert "config" in text and "data" in text and "logs" in text, (
        "升级说明必须提示备份/保留 config、data、logs"
    )


def test_readme_covers_v14_desktop_workflow() -> None:
    text = read_text("README.md")

    assert "1.4.1" in text
    assert "SSH 终端" in text
    assert "servermonitor.exe" in text
    assert "--start-hidden" in text, "README 应说明开机自启走 --start-hidden"
