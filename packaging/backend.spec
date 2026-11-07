# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for the headless desktop backend sidecar.

Run via ``python -m PyInstaller --noconfirm --clean packaging/backend.spec``
from the project root (or use ``packaging/build-backend.ps1``).  The produced
bundle lives at ``dist/backend/servermonitor-backend/servermonitor-backend.exe``
and is shipped as ``resources/backend`` inside the desktop app.

All data paths are resolved from ``project_root`` (``SPECPATH`` is the
``packaging/`` directory), so the build never depends on the current working
directory.
"""

import os
from pathlib import Path

from PyInstaller.config import CONF

# ``SPECPATH`` is injected by PyInstaller.  In PyInstaller 6.x it is the
# *directory* containing the spec file (i.e. ``packaging/``), so the project
# root is one level up.  We resolve it by probing for the package marker so the
# spec keeps working even if PyInstaller changes ``SPECPATH`` to the spec file
# path (Path(SPECPATH).parent.parent case): the literal expression below is kept
# as one of the candidates.
project_root = next(
    (
        cand
        for cand in (
            Path(SPECPATH),                    # noqa: F821
            Path(SPECPATH).parent,             # noqa: F821
            Path(SPECPATH).parent.parent,      # noqa: F821
        )
        if (cand / "servermanage" / "__main__.py").is_file()
    ),
    Path(SPECPATH).parent,                     # noqa: F821
)

# The sidecar is a separate onedir layout from the classic green package:
# dist/backend/servermonitor-backend/servermonitor-backend.exe.  COLLECT derives
# its output directory from ``CONF['distpath']`` + the bundle name, so pin it
# here to keep ``python -m PyInstaller packaging/backend.spec`` reproducible.
CONF["distpath"] = str(project_root / "dist" / "backend")

datas = [
    (str(project_root / "servermanage" / "templates"), "servermanage/templates"),
    (str(project_root / "servermanage" / "web" / "templates"), "servermanage/web/templates"),
    (str(project_root / "servermanage" / "web" / "static"), "servermanage/web/static"),
]

a = Analysis(
    [str(project_root / "servermanage" / "__main__.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    hiddenimports=[
        "waitress",
        "jinja2.ext",
        "winotify",
        "tzdata",
        "pystray",
        "PIL.Image",
        "servermanage.settings",
        "servermanage.security",
        "servermanage.disk_capacity",
        "servermanage.host_import",
        "servermanage.runtime",
        "servermanage.tray",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # The build host's Anaconda environment contains a large scientific /
        # notebook stack that this app never imports.  Excluding it keeps the
        # bundle small and stops PyInstaller from traversing the whole site.
        "matplotlib", "numpy", "pandas", "scipy",
        "IPython", "ipykernel", "jupyter", "jupyter_client", "jupyter_core",
        "notebook", "nbformat", "nbconvert", "traitlets",
        "pytest", "_pytest", "docutils", "sphinx",
        "jedi", "parso",
        "tkinter", "PyQt5", "PyQt6", "PySide2", "PySide6",
        "lightrag",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="servermonitor-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="servermonitor-backend",
)
