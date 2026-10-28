"""Evaluate the case suite in a real headless LibreOffice and compare with the expectations.

    python3 scripts/lo_oracle.py [--cases fixtures/decomp/libreoffice/formula_cases.json]
    python3 scripts/lo_oracle.py --characterize decomp-state/lo_characterized.json

Default mode prints agreement per case and exits 1 on any disagreement or execution error.
--characterize writes what LibreOffice actually returned next to each expectation, for a
human to confirm or correct the suite. It never edits the suite or the probe records.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.libreoffice import (UnoDriver, find_install, is_held_out, load_cases,  # noqa: E402
                                matches, observe_cases)

DEFAULT_CASES = ROOT / "fixtures/decomp/libreoffice/formula_cases.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--uno-python", default=os.environ.get("LO_PYTHON", "/usr/bin/python3"))
    parser.add_argument("--characterize", type=Path, help="write observed results for review")
    args = parser.parse_args()

    install = find_install()
    suite = load_cases(args.cases)
    with UnoDriver(install["soffice"], python=args.uno_python) as driver:
        version = driver.ready.get("version")
        observations = observe_cases(driver, suite["cases"])
    print(f"LibreOffice {version}: {len(suite['cases'])} cases")
    failures, rows = 0, []
    agreements = observed_only = 0
    for case in suite["cases"]:
        reply = observations[case["id"]]
        observed = reply.get("observed")
        expected = case.get("expected")
        agreement = matches(expected, observed) if expected is not None and observed is not None else None
        ok = observed is not None and (expected is None or agreement)
        failures += not ok
        agreements += agreement is True
        observed_only += expected is None and observed is not None
        mark = "OBS" if expected is None and observed is not None else ("ok " if ok else ("ERR" if observed is None else "DIFF"))
        tags = ",".join(t for t, on in (("held-out", is_held_out(case)),
                                        ("unverified", case.get("confidence") == "unverified")) if on)
        display = case.get("formula") or (case.get("operation") or {}).get("type", "table operation")
        print(f"  {mark:4} {case['id']:24} {display:24} expected {json.dumps(expected)}"
              f"  observed {json.dumps(observed) if observed is not None else reply.get('error')}"
              f"{'  [' + tags + ']' if tags else ''}")
        rows.append({"id": case["id"], "formula": display, "expected": expected,
                     "observed": observed, "error": reply.get("error"), "agrees": agreement,
                     "confidence": case.get("confidence")})
    if args.characterize:
        args.characterize.parent.mkdir(parents=True, exist_ok=True)
        args.characterize.write_text(json.dumps({"lo_version": version, "soffice": install["soffice"],
                                                 "cases": rows}, indent=2) + "\n")
        print(f"wrote {args.characterize}; review it before changing any expectation")
        return 0
    print(f"{agreements}/{len(rows) - observed_only} expectations agree; "
          f"{observed_only} outputs recorded without expectations")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
