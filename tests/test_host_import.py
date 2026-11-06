from __future__ import annotations

from pathlib import Path

from servermanage.host_import import (
    HostCandidate,
    ParseResult,
    parse_csv,
    parse_ssh_config,
    parse_yaml,
)

FIXTURES = Path(__file__).parent / "fixtures" / "host_import"


def _read(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# dataclasses / interface
# ---------------------------------------------------------------------------


def test_host_candidate_defaults():
    candidate = HostCandidate(name="web1", host="10.0.0.1")
    assert candidate.port == 22
    assert candidate.username == ""
    assert candidate.auth_type == "key"
    assert candidate.key_path is None
    assert candidate.tags == ()
    assert candidate.disk_mounts == ("/", "/data")
    assert candidate.group == "未分组"
    assert candidate.owner == ""
    assert candidate.location == ""
    assert candidate.notes == ""
    assert candidate.warnings == ()
    assert candidate.valid is True
    assert candidate.error is None


def test_parse_result_shape():
    result = ParseResult(candidates=[], errors=[], warnings=[])
    assert result.candidates == []
    assert result.errors == []
    assert result.warnings == []


# ---------------------------------------------------------------------------
# parse_ssh_config
# ---------------------------------------------------------------------------


def test_ssh_multi_alias_shares_attributes(tmp_path: Path):
    key = tmp_path / ".ssh" / "id_ed25519"
    key.parent.mkdir(parents=True)
    key.write_text("KEY")

    text = f"""
Host web1 web2
    HostName 10.0.0.11
    User deploy
    Port 2222
    IdentityFile {key}
""".strip()

    result = parse_ssh_config(text, home=tmp_path)

    assert result.errors == []
    assert [c.name for c in result.candidates] == ["web1", "web2"]
    for candidate in result.candidates:
        assert candidate.host == "10.0.0.11"
        assert candidate.username == "deploy"
        assert candidate.port == 2222
        assert candidate.key_path == str(key)
        assert candidate.valid is True
        assert candidate.error is None


def test_ssh_tilde_and_relative_identity_paths(tmp_path: Path):
    (tmp_path / ".ssh").mkdir()
    expected = tmp_path / ".ssh" / "id_rsa"
    expected.write_text("KEY")
    tilde_text = "Host a\n    HostName 1.1.1.1\n    IdentityFile ~/.ssh/id_rsa\n"

    result = parse_ssh_config(tilde_text, home=tmp_path)
    assert result.candidates[0].key_path == str(expected)

    relative_text = "Host b\n    HostName 2.2.2.2\n    IdentityFile keys/id_rsa\n"
    result = parse_ssh_config(relative_text, home=tmp_path)
    assert result.candidates[0].key_path == str(tmp_path / ".ssh" / "keys" / "id_rsa")


def test_ssh_missing_key_only_warns(tmp_path: Path):
    text = "Host a\n    HostName 1.1.1.1\n    IdentityFile ~/.ssh/ghost\n"
    result = parse_ssh_config(text, home=tmp_path)

    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.valid is True
    assert candidate.error is None
    assert any("私钥文件不存在" in w for w in result.warnings)


def test_ssh_proxyjump_invalid(tmp_path: Path):
    text = "Host via-jump\n    HostName 1.1.1.1\n    ProxyJump bastion\n"
    result = parse_ssh_config(text, home=tmp_path)

    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.valid is False
    assert candidate.error == "需要代理跳转，工具暂不支持"
    assert any("需要代理跳转，工具暂不支持" in w for w in result.warnings)


def test_ssh_proxycommand_invalid(tmp_path: Path):
    text = "Host via-cmd\n    HostName 1.1.1.1\n    ProxyCommand ssh -W %h:%p bastion\n"
    result = parse_ssh_config(text, home=tmp_path)

    candidate = result.candidates[0]
    assert candidate.valid is False
    assert candidate.error == "需要代理跳转，工具暂不支持"


def test_ssh_wildcard_and_match_and_include_skipped(tmp_path: Path):
    text = """
Include ~/.ssh/config.d/*

Host *
    ServerAliveInterval 30

Match host foo
    User bar

Host real
    HostName 3.3.3.3
""".strip()
    result = parse_ssh_config(text, home=tmp_path)

    assert [c.name for c in result.candidates] == ["real"]
    joined = "\n".join(result.warnings)
    assert "Include" in joined
    assert "Match" in joined
    assert "通配符" in joined


def test_ssh_wildcard_alias_does_not_create_candidate(tmp_path: Path):
    text = "Host web-?\n    HostName 1.1.1.1\n"
    result = parse_ssh_config(text, home=tmp_path)
    assert result.candidates == []
    assert any("通配符" in w for w in result.warnings)


def test_ssh_fixture_file():
    result = parse_ssh_config(_read("sample_ssh_config"), home=Path("/home/tester"))
    names = [c.name for c in result.candidates]
    assert "web1" in names and "web2" in names and "db-primary" in names
    assert "bastion-only" in names
    assert "*" not in names
    bastion = next(c for c in result.candidates if c.name == "bastion-only")
    assert bastion.valid is False
    assert bastion.error == "需要代理跳转，工具暂不支持"
    web1 = next(c for c in result.candidates if c.name == "web1")
    assert web1.port == 2222
    assert web1.username == "deploy"
    assert web1.key_path == str(Path("/home/tester") / ".ssh" / "id_ed25519")


# ---------------------------------------------------------------------------
# parse_csv
# ---------------------------------------------------------------------------


def test_csv_chinese_headers_with_bom():
    text = (
        "\ufeff名称,地址,端口,用户名,私钥,认证,标签,磁盘目录,分组,负责人,位置,备注\n"
        "web1,10.0.0.11,2222,root,~/.ssh/id_rsa,key,prod;web,/;/data,生产,张三,A机房,主站\n"
    )
    result = parse_csv(text)

    assert result.errors == []
    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.name == "web1"
    assert candidate.host == "10.0.0.11"
    assert candidate.port == 2222
    assert candidate.username == "root"
    assert candidate.key_path == "~/.ssh/id_rsa"
    assert candidate.tags == ("prod", "web")
    assert candidate.disk_mounts == ("/", "/data")
    assert candidate.group == "生产"
    assert candidate.owner == "张三"
    assert candidate.location == "A机房"
    assert candidate.notes == "主站"


def test_csv_defaults_and_empty_disk_mounts():
    text = "name,host,port,tags,disk_mounts\nweb1,10.0.0.1,,,,\nweb2,10.0.0.2,22,a;b,\n"
    result = parse_csv(text)

    assert result.errors == []
    assert result.candidates[0].disk_mounts == ("/", "/data")
    assert result.candidates[0].port == 22
    assert result.candidates[1].tags == ("a", "b")
    assert result.candidates[1].disk_mounts == ("/", "/data")


def test_csv_tab_delimited():
    text = "name\thost\tport\nweb1\t10.0.0.1\t2200\n"
    result = parse_csv(text)

    assert len(result.candidates) == 1
    assert result.candidates[0].host == "10.0.0.1"
    assert result.candidates[0].port == 2200


def test_csv_missing_required_columns():
    result = parse_csv("name,port\nweb1,22\n")
    assert result.candidates == []
    assert result.errors
    assert any("name" in e["error"] and "host" in e["error"] for e in result.errors)


def test_csv_row_error_is_collected_not_faked():
    text = "name,host,port\nweb1,10.0.0.1,22\n,10.0.0.2,22\nweb3,,22\nweb4,10.0.0.4,abc\n"
    result = parse_csv(text)

    assert [c.name for c in result.candidates] == ["web1"]
    assert len(result.errors) == 3
    assert all("row" in e and "error" in e for e in result.errors)


def test_csv_gb18030_bytes():
    raw = "名称,地址\n服务器一,10.0.0.9\n".encode("gb18030")
    result = parse_csv(raw)

    assert result.errors == []
    assert len(result.candidates) == 1
    assert result.candidates[0].name == "服务器一"
    assert result.candidates[0].host == "10.0.0.9"


def test_csv_fixture_file():
    result = parse_csv(_read("sample_hosts.csv"))
    assert len(result.candidates) == 2
    assert result.candidates[0].tags == ("prod", "web")
    assert result.candidates[1].name == "web2"
    assert result.candidates[1].disk_mounts == ("/", "/data")


# ---------------------------------------------------------------------------
# parse_yaml
# ---------------------------------------------------------------------------


def test_yaml_hosts_key_list():
    text = """
hosts:
  - name: web1
    host: 10.0.0.11
    port: 2222
    username: root
    tags: [prod, web]
    disk_mounts: ["/", "/data"]
    group: 生产
    owner: 张三
""".strip()
    result = parse_yaml(text)

    assert result.errors == []
    assert len(result.candidates) == 1
    candidate = result.candidates[0]
    assert candidate.name == "web1"
    assert candidate.port == 2222
    assert candidate.tags == ("prod", "web")
    assert candidate.disk_mounts == ("/", "/data")
    assert candidate.group == "生产"
    assert candidate.owner == "张三"


def test_yaml_root_list_and_string_lists():
    text = """
- name: web1
  host: 10.0.0.1
  tags: "prod;web"
  disk_mounts: "/;/data"
""".strip()
    result = parse_yaml(text)

    assert result.errors == []
    assert result.candidates[0].tags == ("prod", "web")
    assert result.candidates[0].disk_mounts == ("/", "/data")


def test_yaml_invalid_syntax_returns_error():
    result = parse_yaml("hosts: [unclosed\n")
    assert result.candidates == []
    assert result.errors
    assert "YAML" in result.errors[0]["error"]


def test_yaml_bad_rows_collected():
    text = """
hosts:
  - name: web1
    host: 10.0.0.1
  - name: missing-host
  - just-a-string
""".strip()
    result = parse_yaml(text)

    assert [c.name for c in result.candidates] == ["web1"]
    assert len(result.errors) == 2


def test_yaml_native_int_port_out_of_range_rejected():
    for bad_port in (70000, 0, -1):
        text = f"hosts:\n  - name: web1\n    host: 10.0.0.1\n    port: {bad_port}\n"
        result = parse_yaml(text)
        assert result.candidates == [], bad_port
        assert len(result.errors) == 1, bad_port
        assert "无效端口" in result.errors[0]["error"]


def test_yaml_native_int_port_in_range_accepted():
    text = "hosts:\n  - name: web1\n    host: 10.0.0.1\n    port: 2222\n"
    result = parse_yaml(text)
    assert result.errors == []
    assert result.candidates[0].port == 2222


def test_yaml_fixture_file():
    result = parse_yaml(_read("sample_hosts.yaml"))
    assert len(result.candidates) == 2
    assert result.candidates[1].name == "gpu1"
    assert result.candidates[1].disk_mounts == ("/", "/data", "/scratch")
