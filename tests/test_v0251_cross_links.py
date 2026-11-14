"""v0.1.151：用户页与算力页互相跳转。"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_gpu_chip_links_to_compute_row():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function gpuChip(memoryMb, procs, user)" in js
    assert "chip.setAttribute('href', '/compute' + (user ? '#gpu-user-' + encodeURIComponent(user) : ''));" in js
    assert "gpuChip(row.gpu_memory_mb, row.gpu_process_count, row.username)" in js


def test_compute_rows_are_anchored_and_link_back():
    page = (TEMPLATES / "compute.html").read_text(encoding="utf-8")
    assert 'id="gpu-user-{{ user.user }}"' in page
    assert 'href="/users?host={{ user.hosts[0]|urlencode }}&amp;q={{ user.user|urlencode }}"' in page


def test_users_page_accepts_keyword_param():
    js = (STATIC / "users.js").read_text(encoding="utf-8")
    assert "function applyKeywordFromUrl()" in js
    assert "new URLSearchParams(window.location.search).get('q')" in js
    assert "    applyKeywordFromUrl();" in js


def test_styles_highlight_target_row_and_link_chip():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    assert "a.usage-gpu {" in css
    assert ".compute-users tr:target {" in css
    assert ".compute-users a.user-link {" in css
