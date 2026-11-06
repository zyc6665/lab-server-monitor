import sys
import pytest
from servermanage import security


def test_dpapi_roundtrip():
    if not security.dpapi_available():
        pytest.skip("DPAPI requires Windows")
    blob = security.protect_secret(b"top-secret")
    assert blob != b"top-secret"
    assert security.unprotect_secret(blob) == b"top-secret"


def test_dpapi_unavailable_on_non_windows(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    assert security.dpapi_available() is False
    with pytest.raises(security.SecurityError):
        security.protect_secret(b"x")


def test_hash_password_verifies_and_rejects_wrong():
    hashed, salt = security.hash_password("admin-pass", iterations=1000)
    assert security.verify_password("admin-pass", hashed, salt, 1000) is True
    assert security.verify_password("wrong", hashed, salt, 1000) is False


def test_machine_id_is_stable():
    assert security.current_machine_id() == security.current_machine_id()
    assert len(security.current_machine_id()) >= 16
