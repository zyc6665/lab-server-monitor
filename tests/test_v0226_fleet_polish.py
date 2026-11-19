"""v0.1.226：全队批量读 + 慢查询缓存 + 并行连通性测试 + 终端体验。

- ``/api/users`` 每 30 秒轮询此前每台主机开约 5 个连接（快照/基线/增量/
  扫描状态/GPU 占用各一个）；现在 storage 层提供全队批量读，一次连接读完。
- 30 天容量预测是慢变化信号，加 5 分钟 TTL 缓存，30 秒轮询不再每次重算回归。
- 批量连通性测试此前串行探测：一台掉线主机吃满 connect_timeout，多台
  掉线时浏览器先超时；现在用小线程池并行探测，结果顺序不变。
- 终端页：SSE 断线后提供「重连」按钮（旧会话已死，重连会建立新会话）、
  标签可键盘操作（Enter 激活、左右方向切换、关闭是真实按钮）、
  xterm 配色跟随页面明暗主题。
"""

from __future__ import annotations

import json
import re
import sqlite3
import threading
import time as time_mod
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from servermanage import storage
from servermanage.config import load_config_from_mapping
from servermanage.models import CommandResult
from servermanage.settings import SettingsService
from servermanage.web import create_app
from servermanage.web.routes import _capacity_forecasts_cached

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "servermanage" / "web" / "static"
ADMIN_PASSWORD = "AdminPass!23"
NOW = datetime.now(timezone.utc)


def _read(name: str) -> str:
    return (STATIC / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# storage 批量读 API
# ---------------------------------------------------------------------------


def _accounts(host_seed: int) -> list[dict]:
    return [
        dict(
            username=f"user{host_seed}",
            uid=1000 + host_seed,
            gid=1000 + host_seed,
            primary_group=f"user{host_seed}",
            home=f"/home/user{host_seed}",
            shell="/bin/bash",
            groups=[f"user{host_seed}", "docker"],
            in_docker=True,
            in_sudo=False,
            home_exists=True,
            home_owner=f"user{host_seed}",
            home_group=f"user{host_seed}",
            home_mode="drwxr-xr-x",
            home_size_bytes=10 * 1024**3,
            data_exists=True,
            data_owner=f"user{host_seed}",
            data_group=f"user{host_seed}",
            data_mode="drwxrwsr-x",
            data_size_bytes=5 * 1024**3,
        )
    ]


def _seed_two_hosts(db_path: Path) -> None:
    storage.init_storage(db_path)
    for index, host in enumerate(("alpha", "beta")):
        accounts = _accounts(index + 1)
        storage.save_host_user_scan_result(
            host, accounts, db_path, now=NOW - timedelta(days=7), seed_only=True
        )
        storage.save_host_user_scan_result(host, accounts, db_path, now=NOW, seed_only=True)
        for step in range(0, 8, 2):
            when = NOW - timedelta(days=7 - step)
            storage.append_user_usage_history(
                host,
                [
                    dict(
                        username=accounts[0]["username"],
                        home_size_bytes=10 * 1024**3 + step * 1024**3,
                        data_size_bytes=5 * 1024**3,
                    )
                ],
                db_path,
                now=when,
            )


def test_batch_baselines_and_states_match_per_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed_two_hosts(db_path)
    baselines = storage.get_all_user_baselines(db_path)
    states = storage.get_all_user_scan_states(db_path)
    assert set(baselines) == {"alpha", "beta"}
    for host in ("alpha", "beta"):
        assert baselines[host] == storage.get_user_baseline(host, db_path)
        assert states[host] == storage.get_user_scan_state(host, db_path)
    assert "missing-host" not in states


def test_batch_usage_deltas_match_per_host(tmp_path: Path):
    db_path = tmp_path / "monitor.db"
    _seed_two_hosts(db_path)
    batched = storage.get_all_user_usage_deltas(db_path, days=7, now=NOW)
    assert set(batched) == {"alpha", "beta"}
    for host in ("alpha", "beta"):
        assert batched[host] == storage.get_user_usage_deltas(
            host, db_path, days=7, now=NOW
        )
    # 有 4 个采样点，增量应为正
    assert batched["alpha"]["user1"]["delta"] > 0


def test_batch_usage_deltas_uses_one_connection(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "monitor.db"
    _seed_two_hosts(db_path)
    calls = {"count": 0}
    real_connect = sqlite3.connect

    def counting_connect(*args, **kwargs):
        if args and Path(args[0]) == db_path:
            calls["count"] += 1
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(storage.sqlite3, "connect", counting_connect)
    storage.get_all_user_usage_deltas(db_path, days=7, now=NOW)
    assert calls["count"] == 1


# ---------------------------------------------------------------------------
# 容量预测 TTL 缓存
# ---------------------------------------------------------------------------


def _cache_config(tmp_path: Path):
    return load_config_from_mapping(
        {
            "report": {"daily_enabled": False, "weekly": {"enabled": False}},
            "dashboard": {"auth": {"password": "secret"}},
            "servers": [
                {
                    "name": "gpu-01",
                    "host": "10.0.0.1",
                    "username": "root",
                    "auth": {"type": "key", "key_data": "PEM"},
                }
            ],
        }
    )


def test_capacity_forecasts_cached(tmp_path: Path, monkeypatch):
    db_path = tmp_path / "monitor.db"
    storage.init_storage(db_path)
    config = _cache_config(tmp_path)
    import servermanage.capacity as capacity

    calls = {"count": 0}
    real_build = capacity.build_capacity_forecasts

    def counting_build(*args, **kwargs):
        calls["count"] += 1
        return real_build(*args, **kwargs)

    monkeypatch.setattr(capacity, "build_capacity_forecasts", counting_build)
    first = _capacity_forecasts_cached(config, db_path, None, None, config.alerts.thresholds)
    second = _capacity_forecasts_cached(config, db_path, None, None, config.alerts.thresholds)
    assert calls["count"] == 1  # 第二次命中缓存
    assert second is first
    # 换预测窗口（7d）应重算
    _capacity_forecasts_cached(config, db_path, None, None, config.alerts.thresholds, days=7)
    assert calls["count"] == 2


# ---------------------------------------------------------------------------
# 批量连通性测试并行化
# ---------------------------------------------------------------------------


@pytest.fixture()
def api_client(tmp_path):
    cfg_path = tmp_path / "config.yaml"
    cfg_path.write_text("servers: []\n", encoding="utf-8")
    db = tmp_path / "m.db"
    base = load_config_from_mapping({}, allow_empty_servers=True)
    svc = SettingsService(config_path=cfg_path, db_path=db, base_config=base)
    app = create_app(config=svc.load(), db_path=db, settings_service=svc)
    test_client = app.test_client()
    page = test_client.get("/setup").get_data(as_text=True)
    test_client.post(
        "/setup",
        data={
            "username": "admin",
            "password": ADMIN_PASSWORD,
            "confirm": ADMIN_PASSWORD,
            "csrf_token": re.search(r'name="csrf_token" value="([^"]+)"', page).group(1),
        },
    )
    test_client.post("/login", data={"username": "admin", "password": ADMIN_PASSWORD})
    meta = test_client.get("/").get_data(as_text=True)
    test_client.environ_base["HTTP_X_CSRF_TOKEN"] = re.search(
        r'name="csrf-token" content="([^"]+)"', meta
    ).group(1)
    return test_client


def _seed(client, name: str) -> None:
    resp = client.put(
        f"/api/settings/hosts/{name}",
        json={
            "host": "10.0.0.51",
            "port": 22,
            "username": "u",
            "auth_type": "password",
            "password": "pw",
        },
    )
    assert resp.status_code == 200


def test_test_batch_probes_hosts_concurrently(api_client, monkeypatch):
    import servermanage.web.routes as routes

    names = ["p1", "p2", "p3"]
    for name in names:
        _seed(api_client, name)
    barrier = threading.Barrier(len(names), timeout=5)

    def fake_run(self, command, timeout):
        barrier.wait(timeout=5)
        return CommandResult(stdout="ok", stderr="", exit_status=0)

    monkeypatch.setattr(routes.SSHClientWrapper, "run", fake_run)
    resp = api_client.post("/api/settings/hosts/test-batch", json={"names": names})
    assert resp.status_code == 200
    body = resp.get_json()
    # 串行探测会让栅栏超时（结果 ok=False）；并行则全部成功且保持顺序。
    assert [item["name"] for item in body["results"]] == names
    assert all(item["ok"] for item in body["results"])


# ---------------------------------------------------------------------------
# 终端页
# ---------------------------------------------------------------------------


def test_terminal_offers_reconnect_after_sse_error():
    script = _read("terminal.js")
    assert 'reconnect.textContent = "重连"' in script
    assert "function markDisconnected(record)" in script
    assert "async function reconnectSession(record)" in script
    assert "stream.onerror = function () {" in script


def test_terminal_tabs_are_keyboard_reachable():
    script = _read("terminal.js")
    assert 'close.setAttribute("aria-label", "关闭 " + hostName + " 的终端")' in script
    assert 'event.key === "ArrowRight" || event.key === "ArrowLeft"' in script
    assert 'event.key === "Enter" || event.key === " "' in script
    # close/reconnect 是真实按钮
    assert 'const close = document.createElement("button")' in script
    assert 'const reconnect = document.createElement("button")' in script


def test_terminal_xterm_theme_follows_page_theme():
    script = _read("terminal.js")
    assert "function terminalTheme()" in script
    assert "MutationObserver" in script
    assert 'attributeFilter: ["data-theme"]' in script


def test_terminal_css_follows_theme():
    css = _read("terminal.css")
    assert "--terminal-bg: #f8fafc;" in css
    assert 'html[data-theme="dark"] { --terminal-bg: #0b1220; }' in css
    assert "background: var(--card-bg," in css
    assert ".terminal-tab .tab-reconnect" in css
