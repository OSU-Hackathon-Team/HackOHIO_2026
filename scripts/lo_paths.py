"""Preflight for the LibreOffice pipeline: what is installed, and will the names be real?

    python3 scripts/lo_paths.py [--json]

Reports the LibreOffice program directory, each target library's sha256 and symbol state
(.symtab, GNU build-id, separate debug file), whether LibreOffice's Python can import uno,
how REA would be launched, and whether Frida and Ghidra headless are present. Exit 1 when
anything the pipeline needs is missing.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.rea import rea_command  # noqa: E402
from engine.libreoffice import find_install  # noqa: E402


def check(command: list[str]) -> tuple[bool, str]:
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, str(error)
    return done.returncode == 0, (done.stdout or done.stderr).strip()[:200]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--uno-python", default=os.environ.get("LO_PYTHON", "/usr/bin/python3"))
    args = parser.parse_args()

    report: dict = {"problems": []}
    try:
        report["install"] = find_install()
    except FileNotFoundError as error:
        report["install"] = None
        report["problems"].append(str(error))
    for key, library in (report["install"] or {}).get("libraries", {}).items():
        if not library["symbols"]["named"]:
            report["problems"].append(
                f"{library['path']} has no symbols and no debug file (build-id "
                f"{library['symbols']['build_id']}); install the -dbgsym package or set "
                "DEBUGINFOD_URLS, or Ghidra names will be FUN_*")
    ok, detail = check([args.uno_python, "-c", "import uno; print('uno ok')"])
    report["uno"] = {"python": args.uno_python, "ok": ok, "detail": detail}
    if not ok:
        report["problems"].append("LibreOffice's Python cannot import uno (install python3-uno)")
    command = rea_command()
    report["rea"] = {"command": command, "found": bool(shutil.which(command[0]))}
    if not report["rea"]["found"]:
        report["problems"].append(f"REA launcher {command[0]} not on PATH")
    ok, detail = check([sys.executable, "-c", "import frida; print(frida.__version__)"])
    report["frida"] = {"ok": ok, "detail": detail}
    headless = Path(os.environ.get("GHIDRA_HEADLESS") or
                    Path(os.environ.get("GHIDRA_INSTALL_DIR", "/opt/ghidra")) / "support/analyzeHeadless")
    report["ghidra_headless"] = {"path": str(headless), "found": headless.is_file()}
    if not headless.is_file():
        report["problems"].append(f"Ghidra headless not found at {headless}")

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        install = report["install"]
        if install:
            print(f"LibreOffice {install['version']} at {install['program_dir']}")
            for key, lib in install["libraries"].items():
                sym = lib["symbols"]
                print(f"  {key:8} {lib['path']}  {lib['bytes'] / 1e6:.1f} MB  sha256 {lib['sha256'][:16]}…  "
                      f"symtab={sym['symtab']} debug_file={sym['debug_file'] or '-'}")
        print(f"uno: {'ok' if report['uno']['ok'] else 'MISSING'}   frida: "
              f"{report['frida']['detail'] if report['frida']['ok'] else 'MISSING'}   "
              f"REA: {' '.join(command)}   ghidra: {headless if headless.is_file() else 'MISSING'}")
        for problem in report["problems"]:
            print(f"  ✗ {problem}")
    return 1 if report["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
