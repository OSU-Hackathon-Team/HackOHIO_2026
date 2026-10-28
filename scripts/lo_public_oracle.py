"""Record only registered public Calc cases, without analysis or model calls."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.libreoffice import (UNO_DRIVER, UnoDriver, find_install, formula_input,  # noqa: E402
                                load_cases, split_cases)


def record_public(target_id, suite, driver, binary_sha256):
    cases = []
    for case in split_cases(suite["cases"])[0]:
        try:
            reply = driver.evaluate(case, diagnostics=True)
        except (RuntimeError, ValueError) as error:
            reply = {"observed": None, "error": str(error)}
        observed = reply.get("observed")
        item = {"id": case["id"], "input": formula_input(case), "observed": observed,
                "error": reply.get("error"), "outcome": "observed" if observed is not None else "execution_error"}
        if reply.get("diagnostics"):
            item["diagnostics"] = reply["diagnostics"]
        cases.append(item)
    return {"schema": 1, "target_id": target_id, "application_version": driver.ready.get("version"),
            "binary_sha256": binary_sha256,
            "driver_sha256": hashlib.sha256(UNO_DRIVER.read_bytes()).hexdigest(), "cases": cases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    from launch import check_container_guard
    check_container_guard("public-oracle")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{2,39}", args.target):
        raise ValueError("invalid target id")
    target = json.loads((ROOT / "fixtures/decomp/targets" / f"{args.target}.json").read_text())
    if target["id"] != args.target or target["driver"] != "uno":
        raise ValueError("public oracle recording requires a registered UNO target")
    suite = load_cases(ROOT / target["cases"])
    install = find_install()
    with UnoDriver(install["soffice"]) as driver:
        report = record_public(args.target, suite, driver, install["libraries"][target["library"]]["sha256"])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"[oracle] recorded {len(report['cases'])} public cases; no model calls", flush=True)
    return 0 if all(c["outcome"] == "observed" for c in report["cases"]) else 1


if __name__ == "__main__":
    sys.exit(main())
