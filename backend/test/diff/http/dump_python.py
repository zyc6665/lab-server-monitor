#!/usr/bin/env python
"""Drive the Python Flask application through a fixed HTTP request plan.

Used by ``http-diff.test.ts`` as the Python oracle of the cross-stack HTTP
golden diff.  A JSON *plan* (from ``--plan <file>``) lists the requests to make::

    {
      "auth": {"username": "admin", "password": "..."},
      "requests": [
        {"name": "overview", "method": "GET", "path": "/api/overview",
         "auth": false, "capture": "json"},
        {"name": "login", "method": "POST", "path": "/login",
         "auth": false, "capture": "none",
         "form": {"username": "admin", "password": "..."}}
      ]
    }

``capture`` is one of ``json`` (parse the JSON body), ``text`` (keep the raw
string body) or ``none`` (status / content-type / cookie presence only — used
for HTML pages and the login redirect).

For every request the script records ``{name, status, content_type, json, text,
set_cookie}`` and prints a single result line prefixed with
``@@HTTP_DIFF_RESULT@@`` so incidental stdout from the app is ignored by the
Node side.

The plan is executed against *one* Flask ``test_client`` for anonymous requests
and *one* logged-in client for authenticated requests; a successful ``POST
/login`` in the plan reuses that client for the rest of the authenticated sweep,
mirroring how the Node test shares a single ``supertest`` agent.
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path
from typing import Any

_REPO_ROOT = next(
    (p for p in Path(__file__).resolve().parents if (p / "servermanage").is_dir()),
    None,
)
if _REPO_ROOT is not None and str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

RESULT_PREFIX = "@@HTTP_DIFF_RESULT@@"


def _build_app(config_path: Path, db_path: Path, admin_user: str, admin_password: str):
    from servermanage.config import load_config
    from servermanage.settings import SettingsService
    from servermanage.web import create_app

    base = load_config(
        config_path,
        allow_empty_servers=True,
        allow_missing_secrets=True,
        allow_missing_file=True,
    )
    settings = SettingsService(config_path=config_path, db_path=db_path, base_config=base)
    effective = settings.load()
    # Each stack writes its own DPAPI-encrypted admin credential on its own copy,
    # so the diff never depends on cross-implementation ciphertext interop.
    settings.set_admin_password(None, admin_password, username=admin_user)
    app = create_app(config=effective, db_path=db_path, settings_service=settings)
    return app


def _response_record(name: str, resp, capture: str) -> dict[str, Any]:
    content_type = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
    record: dict[str, Any] = {
        "name": name,
        "status": resp.status_code,
        "content_type": content_type,
        "set_cookie": bool(resp.headers.getlist("Set-Cookie")),
        "json": None,
        "text": None,
    }
    if capture == "json":
        record["json"] = resp.get_json(silent=True)
    elif capture == "text":
        record["text"] = resp.get_data(as_text=True)
    return record


def run_plan(config_path: Path, db_path: Path, plan: dict[str, Any]) -> dict[str, Any]:
    auth = plan.get("auth") or {}
    app = _build_app(
        config_path,
        db_path,
        str(auth.get("username", "admin")),
        str(auth.get("password", "")),
    )
    anon_client = app.test_client()
    authed_client = None

    responses: list[dict[str, Any]] = []
    for spec in plan.get("requests", []):
        name = str(spec.get("name", ""))
        method = str(spec.get("method", "GET")).upper()
        path = str(spec.get("path", "/"))
        needs_auth = bool(spec.get("auth", False))
        capture = str(spec.get("capture", "none"))
        form = spec.get("form")
        try:
            if needs_auth:
                if authed_client is None:
                    authed_client = app.test_client()
                    authed_client.post("/login", data=auth)
                client = authed_client
            else:
                client = anon_client
            if method == "POST":
                resp = client.post(path, data=form or {})
            elif method == "PUT":
                resp = client.put(path, data=form or {})
            else:
                resp = client.get(path)
            record = _response_record(name, resp, capture)
            # A successful login request hands its cookie-bearing client to the
            # authenticated sweep (both stacks share one agent).
            if method == "POST" and path == "/login" and resp.status_code in (301, 302, 303) and authed_client is None:
                authed_client = client
                record["set_cookie"] = bool(resp.headers.getlist("Set-Cookie"))
            responses.append(record)
        except Exception:  # pragma: no cover - surfaced to the Node diff
            responses.append({"name": name, "error": traceback.format_exc()})
    return {"ok": True, "responses": responses}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--plan", required=True)
    args = parser.parse_args(argv)
    plan = json.loads(Path(args.plan).read_text(encoding="utf-8"))
    result = run_plan(Path(args.config), Path(args.db), plan)
    # ensure_ascii keeps the payload pure ASCII so it survives any stdout code
    # page on Windows; Node parses the escapes back to real unicode.
    sys.stdout.write(RESULT_PREFIX + json.dumps(result, ensure_ascii=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
