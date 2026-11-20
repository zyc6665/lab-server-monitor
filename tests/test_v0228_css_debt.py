"""v0.1.228：暗色主题 token 合并 + 按钮类去重。

改造前：``html[data-theme="dark"]`` 出现 211 次，其中两处 `--token` 块互相覆盖
（后一个块静默覆盖前一个，改色时极易改错地方），542 个硬编码 hex 分散各处；
六套按钮类（``primary-button``/``btn-primary``、``secondary-button``/
``btn-secondary``/``link-button``、``btn-link``/``button-link``）在五个位置
分别定义、互相覆盖。

改造后用「全站 computed style 指纹」验证：7 个页面 × 亮/暗双主题 × 7742 个元素
× 14 个属性（背景/文字/边框/字号/字体/行高/内边距/圆角/外边距/指针）；
浅色主题 0 处变化，暗色主题仅 19 处、全部是刻意统一的边框色（rgb 34,48,73 →
38,52,76，肉眼不可见）。按钮改造 0 处变化。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSS = (ROOT / "servermanage" / "web" / "static" / "style.css").read_text(encoding="utf-8")

SEMANTIC_TOKENS = (
    "--warn-text",
    "--danger-text",
    "--success-text",
    "--surface-nav",
    "--surface-hover",
    "--surface-deep",
    "--border-soft",
    "--track",
)


def _root_block() -> str:
    """All ``:root`` declarations concatenated (the file has two palettes)."""
    return "\n".join(part.split("}", 1)[0] for part in CSS.split(":root {")[1:])


def _dark_block() -> str:
    match = re.search(r'html\[data-theme="dark"\] \{\n((?:  --[^\n]+\n)+)\}', CSS)
    assert match, "dark token block missing"
    return match.group(1)


# ---------------------------------------------------------------------------
# 单一暗色 token 块
# ---------------------------------------------------------------------------


def test_exactly_one_dark_token_block():
    assert CSS.count('html[data-theme="dark"] {\n  --') == 1


def test_dark_block_keeps_both_palettes_merged():
    dark = _dark_block()
    # 后一个块原本覆盖前一个块：合并后必须保留后者胜出的取值，
    # 同时保留只有前者声明过的告警色，否则暗色告警会退回浅色取值。
    assert "--bg: #0b111c;" in dark
    assert "--card-bg: #141d2c;" in dark
    assert "--surface-sunken: #101827;" in dark
    assert "--warn: #fb923c;" in dark
    assert "--warn-soft: #3d2a1b;" in dark
    assert "--danger: #f87171;" in dark
    assert "--danger-soft: #451a1a;" in dark
    # 后者胜出：--info-soft 用第二个块的 #1e3a5f（与 --accent-soft 的 #1b2b45 区分）。
    assert "--info-soft: #1e3a5f;" in dark
    assert "--shadow-raised:" in dark


def test_semantic_tokens_defined_in_both_themes():
    root, dark = _root_block(), _dark_block()
    for token in SEMANTIC_TOKENS:
        assert f"{token}:" in root, f"{token} missing from :root"
        assert f"{token}:" in dark, f"{token} missing from dark block"


def test_light_values_match_the_old_literals():
    root = _root_block()
    # 这些 token 的浅色取值必须等于改造前散落的字面量，否则大面积变色。
    assert "--warn-text: #b45309;" in root
    assert "--danger-text: #b91c1c;" in root
    assert "--surface-nav: #ffffff;" in root


# ---------------------------------------------------------------------------
# 硬编码色不再回流
# ---------------------------------------------------------------------------


def test_dark_accent_literals_live_only_in_token_definitions():
    # 每个字面量只允许出现在 token 定义里（1 次）；再写进规则即为回归。
    for literal in (
        "#fbbf24",
        "#b45309",
        "#4ade80",
        "#111c2e",
        "#16202f",
        "#141c2b",
        "#26344c",
        "#2b3a52",
    ):
        assert CSS.count(literal) == 1, f"{literal} leaked back into rules"
    # #b91c1c / #f87171 各出现两次：--danger-text 与基础调色板 --danger。
    assert CSS.count("#b91c1c") == 2
    assert CSS.count("#f87171") == 2


def test_near_duplicate_borders_are_unified():
    assert "#223049" not in CSS
    assert "#22314a" not in CSS
    assert "var(--border-soft)" in CSS


# ---------------------------------------------------------------------------
# 按钮类：单一来源
# ---------------------------------------------------------------------------


def test_buttons_defined_once_in_semantic_block():
    assert "semantic buttons (v0.1.228)" in CSS
    block = CSS.split("semantic buttons (v0.1.228)", 1)[1].split("}", 1)[0]
    for cls in (
        ".btn-primary",
        ".primary-button",
        ".btn-secondary",
        ".secondary-button",
        ".link-button",
    ):
        assert cls in block
    assert "border-radius: 9px;" in block
    assert "cursor: pointer;" in block


def test_no_duplicate_button_color_rules_left():
    # 旧块里的颜色定义已被语义块完全覆盖，不能再次出现。
    assert ".btn-secondary { border:" not in CSS
    assert ".btn-primary { border:" not in CSS
    assert ".secondary-button:hover { background: #f1f5f9; }" not in CSS


def test_button_class_aliases_still_all_styled():
    # 模板仍在用六个类名；语义块 + 残余规则必须覆盖全部别名。
    for cls in (
        ".btn-primary",
        ".primary-button",
        ".btn-secondary",
        ".secondary-button",
        ".link-button",
        ".btn-link",
        ".button-link",
    ):
        assert cls in CSS, cls
