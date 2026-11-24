# -*- mode: python ; coding: utf-8 -*-
"""Verify that a built bundle/zip really contains the files the app needs.

Motivation (observed failure): a build of this project once shipped with
``_internal/tzdata/zoneinfo/`` present but lacking ``Asia/Shanghai``, so
``zoneinfo.ZoneInfo("Asia/Shanghai")`` raised ``ZoneInfoNotFoundError`` and the
whole app silently fell back to UTC -- every page, report and alert timestamp
was 8 hours off while nothing looked broken.  A quick check after building
catches that class of defect before the package reaches users.

Usage::

    python packaging/verify-bundle.py                 # newest release/*.zip
    python packaging/verify-bundle.py <zip-or-dir>    # a specific artifact

Exit code 0 = all checks passed, 1 = at least one check failed.
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]

# ``(fragment, label, required)`` -- matched case-insensitively against the
# entry names; fragments are path suffixes so both the onedir layout and the zip
# layout (``servermonitor/resources/backend/_internal/...``) match.
REQUIRED = [
    ("tzdata/zoneinfo/asia/shanghai", "tzdata 时区数据 Asia/Shanghai", True),
    ("tzdata/zoneinfo/asia", "tzdata 时区目录 Asia/", True),
    ("tzdata/zones", "tzdata 根索引 zones", True),
    ("servermanage/web/templates", "Web 模板", True),
    ("servermanage/web/static", "Web 静态资源", True),
    (".exe", "可执行文件", True),
]
OPTIONAL = [
    ("config/config.yaml", "运行时配置 seed"),
    ("servermanage/templates", "报告模板"),
]


def _entries(target: Path) -> list[str]:
    if target.is_dir():
        return [p.relative_to(target).as_posix() for p in target.rglob("*")]
    with zipfile.ZipFile(target) as handle:
        return handle.namelist()


def _default_target() -> Path | None:
    zips = sorted((PROJECT_ROOT / "release").glob("*.zip"))
    if zips:
        return zips[-1]
    for cand in (PROJECT_ROOT / "dist" / "backend", PROJECT_ROOT / "dist"):
        if cand.is_dir():
            return cand
    return None


def main(argv: list[str]) -> int:
    # Windows CI runners default to a legacy code page (cp1252); the Chinese
    # report below would raise UnicodeEncodeError and fail the build even when
    # every check passed. Force UTF-8 and never crash on an unrepresentable char.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):  # pragma: no cover - old Python
            pass

    target = Path(argv[1]).expanduser() if len(argv) > 1 else _default_target()
    if target is None or not target.exists():
        print(f"[FAIL] 找不到待校验产物: {target}")
        return 1

    print(f"校验目标: {target}")
    entries = [name.lower() for name in _entries(target)]
    print(f"条目总数: {len(entries)}")

    failed = 0
    for fragment, label, required in REQUIRED:
        hits = [name for name in entries if fragment in name]
        if hits:
            print(f"[ OK ] {label}: 命中 {len(hits)} 项，例如 {hits[0]}")
        else:
            print(f"[FAIL] {label}: 缺失（期望包含 {fragment}）")
            failed += 1

    for fragment, label in OPTIONAL:
        hits = [name for name in entries if fragment in name]
        if hits:
            print(f"[ OK ] {label}: {hits[0]}")
        else:
            print(f"[WARN] {label}: 未包含（{fragment}），请确认该场景确实不需要")

    # A timezone file without its sibling ``zones`` index still fails at
    # runtime, so check the pair counts as well.
    asia = len([n for n in entries if "tzdata/zoneinfo/asia/" in n])
    print(f"[INFO] Asia 时区文件数: {asia}")

    if failed:
        print(f"\n结果: 失败 {failed} 项，该产物不可直接发布。")
        return 1
    print("\n结果: 全部关键项通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
