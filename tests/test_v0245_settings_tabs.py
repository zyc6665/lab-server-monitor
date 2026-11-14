from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = ROOT / "servermanage" / "web" / "templates"
STATIC = ROOT / "servermanage" / "web" / "static"


def _page() -> str:
    return (TEMPLATES / "settings.html").read_text(encoding="utf-8")


def _js() -> str:
    return (STATIC / "settings.js").read_text(encoding="utf-8")


def _css() -> str:
    return (STATIC / "style.css").read_text(encoding="utf-8")


def test_every_settings_section_has_a_tab():
    page = _page()
    sections = []
    for chunk in page.split('class="card settings-card" data-section="')[1:]:
        sections.append(chunk.split('"', 1)[0])
    tabs = []
    for chunk in page.split('data-settings-tab="')[1:]:
        tabs.append(chunk.split('"', 1)[0])
    assert "user_monitoring" in sections
    missing = [name for name in sections if name not in tabs]
    assert missing == [], missing


def test_tabs_follow_a_readable_order():
    page = _page()
    tabs = [chunk.split('"', 1)[0] for chunk in page.split('data-settings-tab="')[1:]]
    assert tabs == [
        "monitoring",
        "hosts",
        "alerts",
        "user_monitoring",
        "disk_health",
        "smtp",
        "report",
        "dashboard",
        "logs",
        "health",
    ]


def test_dirty_section_marks_its_tab():
    script = _js()
    assert "function markTabDirty(sectionName, dirty)" in script
    assert "markTabDirty(sectionName, true);" in script
    assert "markTabDirty(sectionName, false);" in script
    assert 'user_monitoring: "user_monitoring"' in script
    assert 'silences: "alerts"' in script


def test_dirty_dot_is_styled_for_both_themes():
    style = _css()
    assert "v0.1.145 设置分区未保存标记" in style
    assert ".settings-tab.is-dirty::after" in style
    assert 'html[data-theme="dark"] .settings-tab.is-dirty::after' in style
