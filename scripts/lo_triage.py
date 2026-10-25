"""Find which LibreOffice functions run for each formula, before any decompilation.

    python3 scripts/lo_triage.py runtime [--module libsclo.so] [--pattern '*ScInterpreter*' ...]
    python3 scripts/lo_triage.py static --pattern 'ScInterpreter::Sc(Add|Mul)'

runtime: starts headless LibreOffice, attaches Frida through REA, evaluates each public case
         and records the functions entered (module offset, Ghidra entry, symbol, count).
static:  opens the library in REA's provider and searches procedure names. This runs REA's
         own Ghidra analysis of the library, so expect the first open to take a long time.
Writes JSON to --out (default decomp-state/lo_triage.json).
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.rea import ReaSession, static_triage  # noqa: E402
from engine.libreoffice import UnoDriver, find_install, load_cases, split_cases  # noqa: E402
from engine.lo_pipeline import DEFAULT_FRIDA_PATTERNS, runtime_triage  # noqa: E402

DEFAULT_CASES = ROOT / "fixtures/decomp/libreoffice/formula_cases.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("mode", choices=["runtime", "static"])
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--library", default="calc", choices=["calc", "formula"])
    parser.add_argument("--module", default=None, help="defaults to the library's file name")
    parser.add_argument("--pattern", action="append", help="Frida glob or REA regex; repeatable")
    parser.add_argument("--image-base", default="0x100000",
                        help="Ghidra image base for x86_64 shared objects (default 0x100000)")
    parser.add_argument("--uno-python", default=os.environ.get("LO_PYTHON", "/usr/bin/python3"))
    parser.add_argument("--out", type=Path, default=ROOT / "decomp-state" / "lo_triage.json")
    args = parser.parse_args()

    install = find_install()
    library = install["libraries"][args.library]
    module = args.module or Path(library["path"]).name
    if args.mode == "runtime":
        public, _ = split_cases(load_cases(args.cases)["cases"])
        with ReaSession.launch() as session, UnoDriver(install["soffice"], python=args.uno_python) as driver:
            result = runtime_triage(session, driver, public, module=module,
                                    patterns=args.pattern or DEFAULT_FRIDA_PATTERNS,
                                    image_base=int(args.image_base, 16))
        print(f"hooked {result['hooked']} functions in {module}")
        for case_id, observation in result["cases"].items():
            top = ", ".join(f"{h['name']}×{h['count']}" for h in observation["hits"][:5])
            print(f"  {case_id:24} {len(observation['hits']):4} functions  {top}")
    else:
        if not args.pattern:
            parser.error("static mode needs at least one --pattern")
        with ReaSession.launch() as session:
            result = static_triage(session, Path(library["path"]), procedure_patterns=args.pattern)
        print(f"REA opened {module} in {result['provider_open_seconds']}s; "
              f"{len(result['candidates'])} candidates")
        for candidate in result["candidates"][:40]:
            print(f"  {candidate['address']:>14}  {candidate['name']}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"library": library, "module": module, **result},
                                   indent=2, default=str) + "\n")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
