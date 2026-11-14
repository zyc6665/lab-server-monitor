"""v0.1.281：概览可以只看「采集不足」的主机。"""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
TEMPLATES = ROOT / "servermanage" / "web" / "templates"


def test_templates_offer_stale_option():
    for name in ("overview.html", "hosts.html"):
        page = (TEMPLATES / name).read_text(encoding="utf-8")
        assert '<option value="stale">采集不足</option>' in page, name


def test_script_matches_stale_hosts():
    js = (STATIC / "app.js").read_text(encoding="utf-8")
    assert "function uptimeRatio(uptime)" in js
    assert "tr.setAttribute('data-uptime', uptimeRatio(host.collection_uptime));" in js
    assert "card.setAttribute('data-uptime', uptimeRatio(host.collection_uptime));" in js
    assert "if (status === 'stale') {" in js
    assert "if (!(uptime >= 0 && uptime < 0.9)) { return false; }" in js
