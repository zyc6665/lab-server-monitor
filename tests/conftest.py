from __future__ import annotations

import os
import sys
from pathlib import Path


# Tests deliberately point the settings probes at private/loopback addresses
# (e.g. 10.0.0.9) and monkeypatch the real dial-out, so the SSRF guard must be
# disabled for the test suite. Individual tests re-enable it explicitly when
# they assert the guard itself.
os.environ.setdefault("SSRF_ALLOW_PRIVATE", "1")

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
