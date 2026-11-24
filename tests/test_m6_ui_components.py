"""M6: unified dialog shell, single card definition, token-driven surfaces.

Before M6 every modal repeated its own border/radius/background/shadow and one
of three different backdrops; ``.card`` was declared twice (the second silently
overrode the first).  The shell now lives in one grouped rule driven by tokens,
so a new dialog only declares its size.
"""

from __future__ import annotations

import re
from pathlib import Path

STATIC = Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static"
CSS = (STATIC / "style.css").read_text(encoding="utf-8")

DIALOGS = [
    "settings-dialog",
    "command-dialog",
    "user-admin-dialog",
    "disk-drive-dialog",
    "shortcut-help",
    "user-confirm-dialog",
    "confirm-dialog",
]


def test_dialog_tokens_defined_in_both_themes():
    light = "\n".join(part.split("}", 1)[0] for part in CSS.split(":root {")[1:])
    dark = re.search(r'html\[data-theme="dark"\] \{\n((?:  --[^\n]+\n)+)\}', CSS).group(1)
    for token in ("--dialog-radius", "--dialog-padding", "--shadow-dialog", "--backdrop"):
        assert token in light, f"{token} missing from :root"
    for token in ("--shadow-dialog", "--backdrop"):
        assert token in dark, f"{token} missing from dark block"


def test_single_grouped_dialog_shell():
    assert "M6: one dialog shell for every modal" in CSS
    block = CSS.split("M6: one dialog shell for every modal", 1)[1].split("}", 1)[0]
    for cls in DIALOGS:
        assert f".{cls}" in block, f"{cls} missing from the shared shell"
    shell_body = CSS.split("M6: one dialog shell for every modal", 1)[1]
    head = shell_body.split("/* Per-dialog deltas", 1)[0]
    assert "border-radius: var(--dialog-radius);" in head
    assert "box-shadow: var(--shadow-dialog);" in head
    assert "background: var(--card-bg);" in head


def test_dialogs_no_longer_repeat_the_shell():
    for cls in DIALOGS:
        match = re.search(rf"^\.{cls} \{{([^}}]*)\}}", CSS, re.M)
        assert match, cls
        body = match.group(1)
        assert "--dialog-radius" not in body, f"{cls} still sets its own radius"
        assert "box-shadow" not in body, f"{cls} still sets its own shadow"


def test_backdrops_use_the_token():
    assert "background: var(--backdrop);" in CSS
    # 不再有逐对话框的 rgba backdrop 字面量
    assert len(re.findall(r"::backdrop \{ background: rgba\(", CSS)) == 0


def test_card_declared_once():
    assert len(re.findall(r"^\.card \{", CSS, re.M)) == 1
    card = re.search(r"^\.card \{([^}]*)\}", CSS, re.M).group(1)
    assert "border-radius: var(--radius);" in card
    assert "background: var(--card-bg);" in card
