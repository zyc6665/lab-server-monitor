# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller onedir spec for the Windows PC green package.

Run via ``python -m PyInstaller packaging/servermonitor.spec --noconfirm --clean``
from the project root (or use ``packaging/build.ps1``).  All data paths are
resolved from ``project_root`` (``SPECPATH`` is the ``packaging/`` directory) so
the build never depends on the current working directory.
"""

from pathlib import Path

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
            Path(SPECPATH).parent.parent,      # noqa: F821  (suggested in brief)
        )
        if (cand / "servermanage" / "__main__.py").is_file()
    ),
    Path(SPECPATH).parent,                     # noqa: F821
)

datas = [
    (str(project_root / "servermanage" / "web" / "templates"), "servermanage/web/templates"),
    (str(project_root / "servermanage" / "web" / "static"), "servermanage/web/static"),
    (str(project_root / "servermanage" / "templates"), "servermanage/templates"),
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
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="servermonitor",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="servermonitor",
)
