"""v0.1.114：关注项原因浮层。"""

from __future__ import annotations

from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"


def _script() -> str:
    return (STATIC / "app.js").read_text(encoding="utf-8")


def test_chip_is_a_clickable_button():
    script = _script()
    assert "chip.setAttribute('data-attention-host', host.name || '');" in script
    assert "chip.setAttribute('aria-label'" in script
    assert "chip.type = 'button';" in script


def test_popover_lists_reasons():
    script = _script()
    assert "function openAttentionPopover(button)" in script
    assert "var reasons = (button.title || '').split(' · ').filter(Boolean);" in script
    assert "item.textContent = reason;" in script


def test_popover_closes_on_outside_click_and_escape():
    script = _script()
    assert "closeAttentionPopover();" in script
    assert "if (event.key === 'Escape')" in script


def test_popover_is_wired_into_init():
    script = _script()
    assert "bindAttentionChips();" in script


def test_styles_cover_popover():
    tail = (STATIC / "style.css").read_text(encoding="utf-8").split("v0.1.114 关注项原因浮层")[1]
    assert ".attention-pop {" in tail
    assert ".attention-pop[hidden] { display: none !important; }" in tail
    assert ".attention-chip:focus-visible" in tail
