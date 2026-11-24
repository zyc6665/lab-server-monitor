"""M2: app.js split into ES modules.

``app.js`` used to be one 4 172-line IIFE.  Shared UI primitives and the two
heaviest renderers now live in modules that the entry file imports:

  lib/ui.js           toast + themed confirm/prompt dialogs
  lib/api.js          fetch wrapper with CSRF + error detail
  lib/format.js       byte/percent/stamp formatters
  pages/overview-trends.js   pure trend math (Node-tested)
  pages/trend-chart.js       SVG trend rendering + hover readout
  pages/host-views.js        host table rows and cards

The tests assert the module boundary, that the entry file imports them, and
that the old ``window.*`` facades survive for page scripts that rely on them.
"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"

MODULES = {
    "lib/ui.js": ["export function showToast", "export function failToast",
                  "export function servermonitorConfirm",
                  "export function servermonitorPrompt"],
    "lib/api.js": ["export"],
    "lib/format.js": ["export function formatBytesShared", "export function formatPercent"],
    "pages/overview-trends.js": ["export function overviewNumbers",
                                 "export function overviewPathIndexed",
                                 "export function overviewTrendText"],
    "pages/trend-chart.js": ["export function drawOverviewTrend",
                             "export function overviewPath",
                             "export function overviewSvgEl",
                             "export function bindOverviewHover"],
    "pages/host-views.js": ["export function buildHostRow",
                            "export function buildHostCard",
                            "export function attentionChip",
                            "export function percentCell",
                            "export function sparkline"],
}


def test_modules_exist_and_export_expected_symbols():
    for name, markers in MODULES.items():
        source = (STATIC / name).read_text(encoding="utf-8")
        for marker in markers:
            assert marker in source, f"{name} missing {marker}"


def test_app_imports_every_module():
    app = (STATIC / "app.js").read_text(encoding="utf-8")
    for name in MODULES:
        assert f"'./{name}'" in app or f'"./{name}"' in app, f"app.js does not import {name}"


def test_app_keeps_module_behaviour_instead_of_duplicating_it():
    app = (STATIC / "app.js").read_text(encoding="utf-8")
    # 这些实现已迁出，app.js 不应再有本地副本
    for marker in (
        "function servermonitorConfirm(",
        "function buildHostRow(",
        "function buildHostCard(",
        "function drawOverviewTrend(",
        "function percentCell(",
        "function sparkline(",
    ):
        assert marker not in app, f"app.js still defines {marker}"


def test_window_facades_survive_for_page_scripts():
    app = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "window.servermonitorToast = showToast;" in app
    assert "window.servermonitorConfirm = servermonitorConfirm;" in app
    assert "window.servermonitorPrompt = servermonitorPrompt;" in app
    assert "window.servermonitorFmt = { bytes: formatBytesShared, stamp: formatStampShared };" in app


def test_app_is_meaningfully_smaller():
    app = (STATIC / "app.js").read_text(encoding="utf-8")
    # 拆分前 4172 行；抽走两批渲染器后应显著下降（防回退）
    assert len(app.splitlines()) < 3600
