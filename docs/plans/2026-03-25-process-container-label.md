# Process Container Label Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the daily server report so Docker-hosted processes can be distinguished by container label in `Top CPU Processes`, `Top Memory Processes`, and `Proc By User`, even when the in-container Linux user is `root`.

**Architecture:** Keep the existing collection pipeline, but add two Docker-aware inputs: a `container_id -> container_name` map from `docker ps --no-trunc` and a `pid -> container_id` map from `/proc/<pid>/cgroup`. Parsing will enrich process rows and process-count aggregations with container metadata, and the report layer will render `container label | username` in the `USER` field while falling back to a short container ID when the name is unavailable.

**Tech Stack:** Python 3.11+, Paramiko SSH collection, Jinja2 templating, pytest

---

> 注：主人未要求 Git 提交，本计划保留 TDD 与验证步骤，不包含 `git commit` 步骤喵～

### Task 1: Add failing parser coverage for Docker container mappings

**Files:**
- Modify: `tests/test_parsers.py`
- Modify: `servermanage/parsers.py`

**Step 1: Write the failing test**

```python
from servermanage.parsers import (
    parse_docker_container_names,
    parse_pid_container_map,
)


def test_parse_docker_container_names_maps_full_id_to_name():
    output = "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\tzhangz-train\n"

    mapping = parse_docker_container_names(output)

    assert mapping["3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10"] == "zhangz-train"


def test_parse_pid_container_map_extracts_container_id_from_cgroup_lines():
    output = (
        "123\t12:devices:/docker/3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10\n"
        "456\t0::/system.slice/docker-a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8.scope\n"
    )

    mapping = parse_pid_container_map(output)

    assert mapping[123] == "3fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e103fa4c1b92e10"
    assert mapping[456] == "a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8a7b9c2d4e6f8"
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_parsers.py::test_parse_docker_container_names_maps_full_id_to_name" "tests/test_parsers.py::test_parse_pid_container_map_extracts_container_id_from_cgroup_lines" -v`
Expected: FAIL because the Docker parser helpers do not exist yet

**Step 3: Write minimal implementation**

Implement in `servermanage/parsers.py`:

- `parse_docker_container_names(output: str) -> dict[str, str]`
- `parse_pid_container_map(output: str) -> dict[int, str]`

Requirements:

- accept tab-separated command output
- preserve full container IDs internally
- recognize both `/docker/<id>` and `docker-<id>.scope` patterns
- ignore malformed lines

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_parsers.py::test_parse_docker_container_names_maps_full_id_to_name" "tests/test_parsers.py::test_parse_pid_container_map_extracts_container_id_from_cgroup_lines" -v`
Expected: PASS

### Task 2: Add container fields to models and enrich parsed process data

**Files:**
- Modify: `servermanage/models.py`
- Modify: `servermanage/parsers.py`
- Modify: `tests/test_parsers.py`

**Step 1: Write the failing test**

```python
from servermanage.models import CommandResult, HostConfig
from servermanage.parsers import parse_host_metrics


def test_parse_host_metrics_attaches_container_name_to_top_process_rows():
    host = HostConfig(name="gpu-01", host="10.0.0.1", port=22, username="root", auth=...)
    results = {
        "top_cpu": CommandResult("root 123 80.0 10.0 00:10 python train.py\n", "", 0),
        "top_memory": CommandResult("root 123 80.0 10.0 00:10 python train.py\n", "", 0),
        "pid_user_map": CommandResult("123 root python train.py\n", "", 0),
        "docker_containers": CommandResult("3fa4...<64 chars>\tzhangz-train\n", "", 0),
        "pid_container_map": CommandResult("123\t12:devices:/docker/3fa4...<64 chars>\n", "", 0),
    }

    metrics = parse_host_metrics(results, host)

    assert metrics.top_cpu_processes[0].container_name == "zhangz-train"
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_parsers.py::test_parse_host_metrics_attaches_container_name_to_top_process_rows" -v`
Expected: FAIL because process rows do not carry container metadata yet

**Step 3: Write minimal implementation**

Update `servermanage/models.py`:

- add `container_id: str | None = None`
- add `container_name: str | None = None`

Apply the same extension to both:

- `ProcessRow`
- `UserProcessCount`

Update `servermanage/parsers.py` so `parse_host_metrics()`:

- parses `docker_containers`
- parses `pid_container_map`
- enriches each top process row using PID
- rebuilds `process_counts_by_user` from `pid_user_map`, grouped by `(container_id/container_name, username)`

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_parsers.py::test_parse_host_metrics_attaches_container_name_to_top_process_rows" -v`
Expected: PASS

**Step 5: Add one more failing test for fallback short ID**

```python
def test_parse_host_metrics_keeps_full_container_id_when_name_lookup_fails():
    ...
    assert metrics.top_cpu_processes[0].container_id == "3fa4c1..."
    assert metrics.top_cpu_processes[0].container_name is None
```

Run: `pytest "tests/test_parsers.py::test_parse_host_metrics_keeps_full_container_id_when_name_lookup_fails" -v`
Expected: PASS after minimal fallback support is added

### Task 3: Add Docker-aware collection stages and verify graceful degradation

**Files:**
- Modify: `servermanage/commands.py`
- Modify: `servermanage/collectors.py`
- Modify: `tests/test_collectors.py`

**Step 1: Write the failing test**

```python
from servermanage.commands import build_command_map


def test_build_command_map_includes_docker_container_stages():
    command_map = build_command_map()

    assert "docker_containers" in command_map
    assert "pid_container_map" in command_map
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_collectors.py::test_build_command_map_includes_docker_container_stages" -v`
Expected: FAIL because the stages are not defined

**Step 3: Write minimal implementation**

Update `servermanage/commands.py`:

- add stage constants for Docker container name collection and PID container mapping
- add remote commands that:
  - list running containers with full IDs
  - iterate current PIDs and emit `pid<TAB>cgroup line` data or `pid<TAB>container_id` data

Update `servermanage/collectors.py` only as needed so failures in these new stages are recorded as partial errors, not host-level SSH failures.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_collectors.py::test_build_command_map_includes_docker_container_stages" -v`
Expected: PASS

**Step 5: Add graceful degradation coverage**

Write and run a second test proving:

- `docker_containers` exits non-zero
- host collection still returns `success is True`
- top process data still renders without container labels

Run: `pytest "tests/test_collectors.py::test_collect_host_report_tolerates_docker_mapping_failure" -v`
Expected: PASS

### Task 4: Render `container label | username` in the report layer

**Files:**
- Modify: `servermanage/report.py`
- Modify: `servermanage/templates/report.html.j2`
- Modify: `servermanage/templates/report.txt.j2`
- Modify: `tests/test_report.py`

**Step 1: Write the failing test**

```python
from datetime import datetime, timezone

from servermanage.models import DailyReport, HostMetrics, HostReport, ProcessRow, UserProcessCount
from servermanage.report import render_report


def test_render_report_shows_container_label_in_user_columns():
    report = DailyReport(
        generated_at=datetime(2026, 3, 25, 9, 0, tzinfo=timezone.utc),
        subject_prefix="[Daily]",
        reports=[
            HostReport(
                host_name="gpu-01",
                host="10.0.0.1",
                success=True,
                metrics=HostMetrics(
                    top_cpu_processes=[
                        ProcessRow(
                            username="root",
                            pid=123,
                            cpu_percent=80.0,
                            mem_percent=10.0,
                            elapsed="00:10",
                            command="python train.py",
                            container_name="zhangz-train",
                        )
                    ],
                    process_counts_by_user=[
                        UserProcessCount(username="root", count=12, container_name="zhangz-train")
                    ],
                ),
            )
        ],
    )

    rendered = render_report(report)

    assert "zhangz-train | root" in rendered.text_body
    assert "zhangz-train | root" in rendered.html_body
```

**Step 2: Run test to verify it fails**

Run: `pytest "tests/test_report.py::test_render_report_shows_container_label_in_user_columns" -v`
Expected: FAIL because the report currently renders only raw usernames

**Step 3: Write minimal implementation**

Update `servermanage/report.py`:

- add a helper that formats a display label from `container_name`, `container_id`, and `username`
- shorten fallback container IDs to 12 characters only at render time
- expose formatted values for:
  - top CPU process rows
  - top memory process rows
  - process count summary rows

Update templates to use the formatted display label in the `USER` column and `Proc By User` text.

**Step 4: Run test to verify it passes**

Run: `pytest "tests/test_report.py::test_render_report_shows_container_label_in_user_columns" -v`
Expected: PASS

**Step 5: Add fallback ID coverage**

Write and run a second test that passes `container_id="3fa4c1b92e103fa4..."` with no `container_name`, then assert the rendered text contains:

```text
3fa4c1b92e10 | root
```

Run: `pytest "tests/test_report.py::test_render_report_uses_short_container_id_when_name_missing" -v`
Expected: PASS

### Task 5: Verify the full pipeline with focused and broad test runs

**Files:**
- Modify: `tests/test_collectors.py`
- Modify: `tests/test_parsers.py`
- Modify: `tests/test_report.py`

**Step 1: Run focused parser tests**

Run: `pytest "tests/test_parsers.py" -v`
Expected: PASS

**Step 2: Run focused collector tests**

Run: `pytest "tests/test_collectors.py" -v`
Expected: PASS

**Step 3: Run focused report tests**

Run: `pytest "tests/test_report.py" -v`
Expected: PASS

**Step 4: Run the whole suite**

Run: `pytest -v`
Expected: PASS with no regressions in config, report, SSH, and main flow tests

**Step 5: Perform a final code review pass**

Check these files for consistency and simplicity:

- `servermanage/commands.py`
- `servermanage/parsers.py`
- `servermanage/models.py`
- `servermanage/report.py`
- `servermanage/templates/report.html.j2`
- `servermanage/templates/report.txt.j2`

Confirm:

- no duplicate container-label formatting logic
- no template-only business rules
- no behavior change for non-container host processes
