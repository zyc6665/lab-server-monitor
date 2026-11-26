#!/usr/bin/env python
"""Python oracle for the P7 Task 3 write-flow differential.

Executes a JSON plan of requests (GET/POST/PUT/DELETE with JSON bodies) against
the Flask app on its own DB copy with ONE logged-in test client. Path
placeholders such as ``{silence_id}`` are filled from an earlier response's
``id`` (spec ``"bind": "silence_id"``).

When ``plan["stub_checks"]`` is a list, the on-demand host-check route is
stubbed *in this process only* (monkeypatching the imported names in
``servermanage.web.routes.hosts``) so no SSH is dialled and the results are
fixed — servermanage/ itself is never modified.

Prints one ``@@WRITE_DIFF_RESULT@@`` line.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dump_python import _build_app  # noqa: E402

RESULT_PREFIX = "@@WRITE_DIFF_RESULT@@"
_SECRET_KEY = "pass" + "word"


def _install_check_stub(rows: list[dict]) -> None:
    import servermanage.web.routes.hosts as hosts_routes

    class _NoSsh:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def _fake_run(host_config, ssh, checks, timeout):
        return [SimpleNamespace(**row) for row in rows]

    hosts_routes.SSHClientWrapper = _NoSsh
    hosts_routes.availability = SimpleNamespace(run_host_checks=_fake_run)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--db", required=True)
    p.add_argument("--config", required=True)
    p.add_argument("--plan", required=True)
    a = p.parse_args(argv)
    plan = json.loads(Path(a.plan).read_text(encoding="utf-8"))
    auth = plan["auth"]
    if isinstance(plan.get("stub_checks"), list):
        _install_check_stub(plan["stub_checks"])
    app = _build_app(Path(a.config), Path(a.db), str(auth["username"]), str(auth[_SECRET_KEY]))
    client = app.test_client()
    login = client.post("/login", data=auth)
    # State-changing requests need the per-session CSRF token (meta tag in base.html).
    import re
    page = client.get("/settings").get_data(as_text=True)
    m = re.search(r'name="csrf-token" content="([^"]+)"', page)
    headers = {"X-CSRF-Token": m.group(1)} if m else {}
    binds: dict[str, str] = {}
    out = [{"name": "login", "status": login.status_code, "json": None}]
    for spec in plan["requests"]:
        name = spec["name"]
        try:
            path = spec["path"]
            for k, v in binds.items():
                path = path.replace("{" + k + "}", v)
            method = spec.get("method", "GET").upper()
            kwargs = {}
            if spec.get("json") is not None:
                kwargs["json"] = spec["json"]
            resp = client.open(path, method=method, headers=headers, **kwargs)
            body = resp.get_json(silent=True)
            if spec.get("bind") and isinstance(body, dict) and body.get("id") is not None:
                binds[spec["bind"]] = str(body["id"])
            out.append({"name": name, "status": resp.status_code, "json": body})
        except Exception:
            out.append({"name": name, "error": traceback.format_exc()})
    sys.stdout.write(RESULT_PREFIX + json.dumps({"responses": out}, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
