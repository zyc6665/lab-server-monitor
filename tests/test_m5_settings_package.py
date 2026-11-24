"""M5: settings.py split into schema / mixins / facade.

``settings.py`` was 2 110 lines with one 1 530-line ``SettingsService`` class.
It is now a package: ``schema.py`` holds the pure helpers and secret-name
constants, ``service.py`` composes per-concern mixins, and ``__init__.py``
re-exports the historical surface (``SettingsService``, ``SettingsError`` and
the ``SECRET_*`` constants tests import).
"""

from __future__ import annotations

from pathlib import Path

from servermanage.settings import (
    SECRET_ADMIN,
    SECRET_SESSION,
    SECRET_SMTP_PASSWORD,
    SECRET_WEBHOOK_URL,
    SettingsError,
    SettingsService,
)

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "servermanage" / "settings"

MODULES = {
    "schema.py": ["def _coerce_like", "def _flat", "SECRET_ADMIN"],
    "core.py": ["class SettingsServiceBase", "def __init__", "def load"],
    "hosts.py": ["class HostsMixin", "def upsert_host", "def import_hosts"],
    "sections.py": ["class SectionsMixin", "def public_settings", "def save_section"],
    "admin.py": ["class AdminMixin", "def verify_admin"],
    "silences.py": ["class SilencesMixin", "def add_silence"],
    "service.py": ["class SettingsService(", "HostsMixin,", "SectionsMixin,", "SettingsServiceBase"],
}


def test_package_layout():
    assert PACKAGE.is_dir(), "settings must be a package after M5"
    assert not (ROOT / "servermanage" / "settings.py").exists()
    for name, markers in MODULES.items():
        source = (PACKAGE / name).read_text(encoding="utf-8")
        for marker in markers:
            assert marker in source, f"{name} missing {marker}"


def test_facade_keeps_historical_imports():
    assert issubclass(SettingsError, Exception)
    assert SECRET_ADMIN and SECRET_SESSION and SECRET_SMTP_PASSWORD and SECRET_WEBHOOK_URL
    assert isinstance(SettingsService, type)


def test_service_composes_all_mixins():
    mro = SettingsService.__mro__
    names = {cls.__name__ for cls in mro}
    for expected in ("HostsMixin", "SectionsMixin", "AdminMixin", "SilencesMixin",
                     "SettingsServiceBase"):
        assert expected in names, f"{expected} missing from MRO"
    # base 必须最后，保证 __init__/load 解析到基类
    assert SettingsService.__mro__[-2].__name__ in ("SettingsServiceBase", "object")


def test_method_count_preserved():
    service = SettingsService
    methods = {
        name for name in dir(service)
        if not name.startswith("__") and callable(getattr(service, name))
    }
    # 拆分前 55 个方法（含 __init__）；去掉双下划线后 54 个，逐个抽查关键方法
    assert len(methods) >= 54, len(methods)
    for name in ("load", "public_settings", "save_section", "upsert_host",
                 "import_hosts", "copy_host", "verify_admin", "add_silence"):
        assert name in methods, name


def test_no_oversized_module():
    for path in PACKAGE.glob("*.py"):
        lines = len(path.read_text(encoding="utf-8").splitlines())
        assert lines < 1000, f"{path.name} is {lines} lines"
