"""SettingsService facade (M5): composes the per-concern mixins."""

from __future__ import annotations

from servermanage.settings.admin import AdminMixin
from servermanage.settings.core import SettingsServiceBase
from servermanage.settings.hosts import HostsMixin
from servermanage.settings.sections import SectionsMixin
from servermanage.settings.silences import SilencesMixin


class SettingsService(
    HostsMixin,
    SectionsMixin,
    AdminMixin,
    SilencesMixin,
    SettingsServiceBase,
):
    """Writable settings store backed by the SQLite ``app_settings`` table.

    Behaviour is unchanged from the pre-M5 single class; the methods are
    grouped in mixins purely for navigation.  ``SettingsServiceBase`` defines
    ``__init__``/``load`` and must stay last in the MRO.
    """
