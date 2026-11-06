# Server Daily Monitor Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a centralized Python-based daily monitoring tool that connects to multiple Linux servers over SSH, collects CPU/memory/disk/process/NVIDIA GPU data, and sends an HTML email report with a plain-text fallback through SMTP.

**Architecture:** The project will use a small Python package with clear layers for configuration, SSH execution, data collection, parsing, report rendering, and mail delivery. The runtime flow is `config -> SSH collect -> parse -> render -> SMTP send`, orchestrated by a single CLI entrypoint suitable for `cron`.

**Tech Stack:** Python 3.11+, Paramiko, PyYAML, python-dotenv, Jinja2, pytest

---

> 注：当前工作区不是 Git 仓库，且主人未要求 Git 流程；因此本计划保留 TDD 与验证步骤，但省略 `git commit` 相关步骤喵～

### Task 1: Bootstrap the project skeleton

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `config.yaml.example`
- Create: `.env.example`
- Create: `servermanage/__init__.py`
- Create: `servermanage/main.py`
- Create: `servermanage/models.py`
- Create: `tests/test_smoke.py`

**Step 1: Write the failing test**

```python
from servermanage.main import main


def test_main_importable():
    assert callable(main)
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_smoke.py" -v`
Expected: FAIL with `ModuleNotFoundError` or import failure

**Step 3: Write minimal implementation**

Create the package skeleton, add dependencies in `pyproject.toml`, and expose a minimal `main()` in `servermanage/main.py`.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_smoke.py" -v`
Expected: PASS

### Task 2: Implement configuration models and validation

**Files:**
- Modify: `servermanage/models.py`
- Create: `servermanage/config.py`
- Modify: `config.yaml.example`
- Modify: `.env.example`
- Create: `tests/test_config.py`

**Step 1: Write the failing test**

```python
from pathlib import Path

from servermanage.config import load_config


def test_load_config_with_password_auth(tmp_path: Path, monkeypatch):
    config_file = tmp_path / "config.yaml"
    config_file.write_text(
        """
smtp:
  host: "smtp.example.com"
  port: 465
  username: "monitor@example.com"
  password_env: "SMTP_PASSWORD"
  use_ssl: true
  from_addr: "monitor@example.com"
  to_addrs: ["ops@example.com"]
ssh:
  connect_timeout: 10
  command_timeout: 20
report:
  subject_prefix: "[Server Daily Report]"
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
    port: 22
    username: "root"
    auth:
      type: "password"
      password_env: "GPU01_PASSWORD"
""".strip(),
        encoding="utf-8",
    )
    monkeypatch.setenv("SMTP_PASSWORD", "smtp-secret")
    monkeypatch.setenv("GPU01_PASSWORD", "ssh-secret")

    config = load_config(config_file)

    assert config.smtp.host == "smtp.example.com"
    assert config.servers[0].auth.type == "password"
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_config.py::test_load_config_with_password_auth" -v`
Expected: FAIL because `load_config` does not exist

**Step 3: Write minimal implementation**

Implement typed config models and a `load_config()` function that:

- reads YAML
- resolves secrets from environment variables
- validates password/key auth combinations
- validates required SMTP fields

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_config.py::test_load_config_with_password_auth" -v`
Expected: PASS

**Step 5: Add one more validation test**

Write and run a second test proving key-based auth fails fast when `key_path` is missing.

### Task 3: Implement SSH execution abstraction

**Files:**
- Create: `servermanage/ssh_client.py`
- Create: `tests/test_ssh_client.py`

**Step 1: Write the failing test**

```python
from servermanage.ssh_client import CommandResult


def test_command_result_captures_exit_code():
    result = CommandResult(stdout="ok", stderr="", exit_status=0)
    assert result.exit_status == 0
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_ssh_client.py::test_command_result_captures_exit_code" -v`
Expected: FAIL because `ssh_client.py` is missing

**Step 3: Write minimal implementation**

Implement:

- `CommandResult`
- `SSHClientWrapper`
- password auth and key auth branches
- `run(command: str, timeout: int) -> CommandResult`

Keep network behavior isolated so orchestration code can be tested with fakes.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_ssh_client.py::test_command_result_captures_exit_code" -v`
Expected: PASS

**Step 5: Add seam tests**

Add tests that verify auth configuration selection without making real SSH calls.

### Task 4: Implement command catalog and parsers

**Files:**
- Create: `servermanage/parsers.py`
- Create: `servermanage/commands.py`
- Create: `tests/test_parsers.py`

**Step 1: Write the failing test**

```python
from servermanage.parsers import parse_uptime


def test_parse_uptime_extracts_load_average():
    data = parse_uptime(" 09:00:00 up 12 days,  2 users,  load average: 2.15, 1.98, 1.76")
    assert data.load_1 == 2.15
    assert data.load_5 == 1.98
    assert data.load_15 == 1.76
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_parsers.py::test_parse_uptime_extracts_load_average" -v`
Expected: FAIL because parser function is missing

**Step 3: Write minimal implementation**

Implement parser helpers for:

- uptime / load average
- memory summary
- disk usage rows
- `who` output
- process-by-user summary
- top CPU / top memory process rows
- `nvidia-smi` GPU summary rows
- `nvidia-smi` GPU process rows

Also define a small command catalog in `servermanage/commands.py` so remote commands are centralized.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_parsers.py::test_parse_uptime_extracts_load_average" -v`
Expected: PASS

**Step 5: Add representative parser coverage**

Add tests with fixed sample outputs for:

- `free -m`
- `df -h`
- `ps`
- `nvidia-smi`

### Task 5: Implement host collection orchestration

**Files:**
- Create: `servermanage/collectors.py`
- Modify: `servermanage/models.py`
- Create: `tests/test_collectors.py`

**Step 1: Write the failing test**

```python
from servermanage.collectors import collect_host_report
from servermanage.models import HostConfig


class FakeSSH:
    def run(self, command, timeout):
        return ...


def test_collect_host_report_marks_partial_gpu_failure():
    host = HostConfig(...)
    report = collect_host_report(host, FakeSSH(), connect_timeout=10, command_timeout=20)
    assert report.host_name == host.name
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_collectors.py::test_collect_host_report_marks_partial_gpu_failure" -v`
Expected: FAIL because collector module is missing

**Step 3: Write minimal implementation**

Implement `collect_host_report()` that:

- runs the configured command set
- parses each output into structured models
- records field-level errors instead of crashing the whole host
- marks hosts with SSH-level failure separately from partial command failure

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_collectors.py::test_collect_host_report_marks_partial_gpu_failure" -v`
Expected: PASS

**Step 5: Add collector behavior tests**

Add tests for:

- successful host collection
- SSH failure
- missing GPU support
- broken `nvidia-smi` output

### Task 6: Implement HTML and plain-text report rendering

**Files:**
- Create: `servermanage/report.py`
- Create: `servermanage/templates/report.html.j2`
- Create: `servermanage/templates/report.txt.j2`
- Create: `tests/test_report.py`

**Step 1: Write the failing test**

```python
from servermanage.report import render_report


def test_render_report_includes_failed_host_section(sample_daily_report):
    rendered = render_report(sample_daily_report)
    assert "Failed Hosts" in rendered.text_body
    assert "gpu-03" in rendered.html_body
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_report.py::test_render_report_includes_failed_host_section" -v`
Expected: FAIL because renderer is missing

**Step 3: Write minimal implementation**

Implement:

- a report renderer that returns subject, plain text body, and HTML body
- a compatibility-first HTML template with inline CSS
- a plain-text fallback template with matching structure

HTML requirements:

- summary cards at top
- failed-host block before host details
- per-host cards with overview metrics
- compact tables for process and GPU sections

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_report.py::test_render_report_includes_failed_host_section" -v`
Expected: PASS

**Step 5: Add content assertions**

Add tests that assert:

- host overview line is rendered
- HTML contains inline styles
- no external CSS or JS references are emitted

### Task 7: Implement SMTP mail delivery

**Files:**
- Create: `servermanage/mailer.py`
- Create: `tests/test_mailer.py`

**Step 1: Write the failing test**

```python
from servermanage.mailer import build_message


def test_build_message_creates_multipart_alternative():
    message = build_message(
        subject="daily",
        from_addr="monitor@example.com",
        to_addrs=["ops@example.com"],
        text_body="plain",
        html_body="<html><body>html</body></html>",
    )
    assert message.get_content_type() == "multipart/alternative"
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_mailer.py::test_build_message_creates_multipart_alternative" -v`
Expected: FAIL because mailer module is missing

**Step 3: Write minimal implementation**

Implement:

- message builder with plain text + HTML parts
- SMTP SSL / STARTTLS branch selection
- send function with clear exception propagation

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_mailer.py::test_build_message_creates_multipart_alternative" -v`
Expected: PASS

**Step 5: Add safety tests**

Add tests to verify recipient headers and HTML part presence.

### Task 8: Implement the main orchestration CLI

**Files:**
- Modify: `servermanage/main.py`
- Create: `tests/test_main.py`

**Step 1: Write the failing test**

```python
from pathlib import Path

from servermanage.main import main


def test_main_returns_zero_for_partial_host_failures(monkeypatch, tmp_path: Path):
    config_path = tmp_path / "config.yaml"
    config_path.write_text("...", encoding="utf-8")
    monkeypatch.setattr("servermanage.main.load_config", lambda path: ...)
    monkeypatch.setattr("servermanage.main.collect_all_hosts", lambda config: ...)
    monkeypatch.setattr("servermanage.main.send_report", lambda *args, **kwargs: None)
    assert main(["--config", str(config_path)]) == 0
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_main.py::test_main_returns_zero_for_partial_host_failures" -v`
Expected: FAIL because orchestration behavior is incomplete

**Step 3: Write minimal implementation**

Implement CLI orchestration that:

- parses `--config`
- loads `.env`
- loads validated config
- iterates hosts and collects reports
- renders final email
- sends email
- writes structured logs
- returns non-zero only for startup or mail-delivery failures

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_main.py::test_main_returns_zero_for_partial_host_failures" -v`
Expected: PASS

**Step 5: Add exit-code coverage**

Add tests for:

- invalid config returns non-zero
- SMTP failure returns non-zero
- SSH failure on one host still returns zero if mail send succeeds

### Task 9: Finish documentation and deployment guidance

**Files:**
- Modify: `README.md`
- Modify: `config.yaml.example`
- Modify: `.env.example`

**Step 1: Write the failing test**

There is no code-level failing test for this documentation task. Instead, define explicit documentation acceptance criteria:

- installation steps are complete
- config examples cover password and key auth
- cron example is present
- sample email sections are described

**Step 2: Verify the docs currently fail the acceptance criteria**

Run: manually inspect `README.md`, `config.yaml.example`, and `.env.example`
Expected: missing setup and deployment instructions

**Step 3: Write minimal documentation**

Add:

- install commands
- dependency description
- environment variable explanation
- configuration examples
- cron setup example
- troubleshooting section for SSH, SMTP, and `nvidia-smi`

**Step 4: Verify the docs satisfy the acceptance criteria**

Run: manually inspect the updated files
Expected: all acceptance criteria are covered

### Task 10: Run the verification suite

**Files:**
- Modify: none

**Step 1: Run targeted unit tests during implementation**

Run:

```bash
pytest "tests/test_smoke.py" -v
pytest "tests/test_config.py" -v
pytest "tests/test_ssh_client.py" -v
pytest "tests/test_parsers.py" -v
pytest "tests/test_collectors.py" -v
pytest "tests/test_report.py" -v
pytest "tests/test_mailer.py" -v
pytest "tests/test_main.py" -v
```

Expected: all tests PASS

**Step 2: Run the full suite**

Run: `pytest -v`
Expected: PASS

**Step 3: Perform one manual dry-run**

Run: `python -m servermanage.main --config "config.yaml"`
Expected: configuration loads, host collection runs, and email sending reaches the SMTP layer or clearly reports missing credentials

**Step 4: Verify cron command**

Run:

```bash
python -m servermanage.main --config "config.yaml" >> "logs/cron.log" 2>&1
```

Expected: command form works for scheduled execution
