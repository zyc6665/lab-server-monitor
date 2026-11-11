"""v0.1.115：设置页顶部只读配置摘要。"""

from __future__ import annotations

from test_user_pages import _client


def test_summary_card_lists_effective_settings(tmp_path):
    client = _client(tmp_path)
    page = client.get("/settings").get_data(as_text=True)
    assert 'id="settings-summary"' in page
    assert "管理员模式" in page
    assert "轮询" in page and "磁盘健康" in page
    assert "监听" in page


def test_summary_reports_enabled_channels(tmp_path):
    client = _client(tmp_path)
    page = client.get("/settings").get_data(as_text=True)
    summary = page.split('id="settings-summary"')[1].split("</section>")[0]
    assert "summary-flag" in summary
    assert ("桌面" in summary) or ("邮件" in summary) or ("Webhook" in summary) or ("未启用" in summary)


def test_summary_appears_before_tabs(tmp_path):
    client = _client(tmp_path)
    page = client.get("/settings").get_data(as_text=True)
    assert page.index('id="settings-summary"') < page.index('id="settings-tabs"')


def test_styles_cover_summary():
    from pathlib import Path

    css = (Path(__file__).resolve().parents[1] / "servermanage" / "web" / "static" / "style.css").read_text(
        encoding="utf-8"
    )
    tail = css.split("v0.1.115 设置页配置摘要")[1]
    assert ".settings-summary .summary-chips" in tail
    assert ".summary-flag.is-on" in tail
    assert 'html[data-theme="dark"] .settings-summary .summary-flag.is-on' in tail
