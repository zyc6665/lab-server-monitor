# Executive Report Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a second, leadership-oriented summary email that is rendered from the same collected metrics as the technical report and sent to its own recipients in the same run.

**Architecture:** Keep data collection unchanged, extend configuration with an optional executive report block, render two report variants from the same `DailyReport`, and send either one or two emails depending on configuration. The executive renderer will summarize health, risks, and resource ownership instead of duplicating detailed tables.

**Tech Stack:** Python 3.11+, Jinja2, pytest, existing SMTP and SSH pipeline

---

> 注：主人已经要求直接开始实现，本计划作为执行基线保存在这里；实现仍严格按 TDD 进行，不额外拆出 Git 提交步骤喵～

### Task 1: Add failing tests for executive report config loading

**Files:**
- Modify: `tests/test_config.py`
- Modify: `servermanage/models.py`
- Modify: `servermanage/config.py`
- Modify: `config.yaml.example`

**Step 1: Write the failing test**

```python
def test_load_config_with_executive_report(tmp_path: Path, monkeypatch):
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
  subject_prefix: "[Daily]"
  executive:
    enabled: true
    subject_prefix: "[Leader]"
    to_addrs: ["leader@example.com"]
servers:
  - name: "gpu-01"
    host: "10.0.0.1"
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

    assert config.report.executive is not None
    assert config.report.executive.enabled is True
    assert config.report.executive.to_addrs == ["leader@example.com"]
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_config.py::test_load_config_with_executive_report" -v`
Expected: FAIL because `ReportConfig` has no executive section yet

**Step 3: Write minimal implementation**

Add an executive report config model and load it from YAML:

- `enabled`
- `subject_prefix`
- `to_addrs`

Keep backward compatibility for configs without `report.executive`.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_config.py::test_load_config_with_executive_report" -v`
Expected: PASS

**Step 5: Add validation coverage**

Add a test proving `enabled: true` with empty `to_addrs` fails fast.

### Task 2: Add failing report tests for an executive summary renderer

**Files:**
- Modify: `tests/test_report.py`
- Modify: `servermanage/report.py`
- Create: `servermanage/templates/report_executive.html.j2`
- Create: `servermanage/templates/report_executive.txt.j2`

**Step 1: Write the failing test**

```python
def test_render_executive_report_contains_summary_risk_and_ownership_sections():
    report = DailyReport(...)

    rendered = render_report(report, variant="executive")

    assert "风险摘要" in rendered.html_body
    assert "资源看板" in rendered.html_body
    assert "使用归属摘要" in rendered.html_body
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_report.py::test_render_executive_report_contains_summary_risk_and_ownership_sections" -v`
Expected: FAIL because only the technical variant exists

**Step 3: Write minimal implementation**

Extend `render_report()` with a `variant` parameter:

- `technical` keeps current behavior
- `executive` uses new templates and a dedicated summary context

The executive context should compute:

- health cards
- high-risk host list
- per-host compact resource summary
- top ownership signals from current process data

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_report.py::test_render_executive_report_contains_summary_risk_and_ownership_sections" -v`
Expected: PASS

**Step 5: Add anti-regression coverage**

Add a second test proving executive output does not contain large technical tables like `Top CPU Processes` and `GPU Processes`.

### Task 3: Add failing main-flow tests for dual email sending

**Files:**
- Modify: `tests/test_main.py`
- Modify: `servermanage/main.py`

**Step 1: Write the failing test**

```python
def test_run_app_sends_technical_and_executive_reports(tmp_path: Path):
    sent = []

    exit_code = run_app(
        ...,
        render_report_func=lambda report, variant="technical": RenderedReport(
            subject=f"{variant}-subject",
            text_body=variant,
            html_body=f"<html>{variant}</html>",
        ),
        send_report_func=lambda smtp, report, to_addrs=None: sent.append((report.subject, to_addrs)),
    )

    assert exit_code == 0
    assert sent == [
        ("technical-subject", None),
        ("executive-subject", ["leader@example.com"]),
    ]
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_main.py::test_run_app_sends_technical_and_executive_reports" -v`
Expected: FAIL because the app sends only one report today

**Step 3: Write minimal implementation**

Update `run_app()` so it:

- always renders and sends the technical report
- conditionally renders and sends the executive report
- returns non-zero if either enabled send fails

Keep default behavior unchanged when executive config is absent or disabled.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_main.py::test_run_app_sends_technical_and_executive_reports" -v`
Expected: PASS

**Step 5: Add fallback behavior coverage**

Add a test proving configs without executive settings still send only one report.

### Task 4: Allow sending with per-report recipient overrides

**Files:**
- Modify: `tests/test_mailer.py`
- Modify: `servermanage/mailer.py`

**Step 1: Write the failing test**

```python
def test_send_report_uses_explicit_recipient_override():
    fake = FakeSMTP("smtp.example.com", 465)

    send_report(
        smtp,
        report,
        to_addrs=["leader@example.com"],
        smtp_ssl_factory=lambda host, port: fake,
    )

    assert fake.sent_message["To"] == "leader@example.com"
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_mailer.py::test_send_report_uses_explicit_recipient_override" -v`
Expected: FAIL because `send_report()` does not accept recipient overrides yet

**Step 3: Write minimal implementation**

Extend `build_message()` and `send_report()` with an optional `to_addrs` override while preserving current defaults.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_mailer.py::test_send_report_uses_explicit_recipient_override" -v`
Expected: PASS

### Task 5: Verify focused suites and then run the whole project

**Files:**
- Modify: `tests/test_config.py`
- Modify: `tests/test_main.py`
- Modify: `tests/test_mailer.py`
- Modify: `tests/test_report.py`

**Step 1: Run config tests**

Run: `pytest "tests/test_config.py" -v`
Expected: PASS

**Step 2: Run report tests**

Run: `pytest "tests/test_report.py" -v`
Expected: PASS

**Step 3: Run main and mailer tests**

Run: `pytest "tests/test_main.py" "tests/test_mailer.py" -v`
Expected: PASS

**Step 4: Run full suite**

Run: `pytest -v`
Expected: PASS with no regressions

**Step 5: Review example config**

Confirm `config.yaml.example` clearly documents the executive report block and that the example remains minimal and readable.
