"""Discover three Calc families and record live original behavior without expected answers.

This is intake evidence, not a reimplementation result. A passing comparison must
later run an independently generated implementation against these observations.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.validation.probes import NativeProbeRunner


FAMILIES = (
    ("formula compiler", ("CompileTokenArray", "Expression", "Factor"),
     "Parse and compile a Calc formula", 96),
    ("formula tokens", ("GetToken", "CreateStringFromTokenArray", "PopTokenArray"),
     "Read, manage, and render Calc formula tokens", 96),
    ("formula grammar", ("mapAPItoGrammar", "setEnglishBit", "isSupported"),
     "Map and validate spreadsheet grammar options", 32),
    ("vector references", ("VectorRefArray", "isValid"),
     "Construct and inspect vector formula references", 64),
)


def grammar_cases() -> list[dict]:
    rng = random.Random(71291)
    inputs = [
        ("mapAPItoGrammar", [bool(a), bool(b)])
        for a in range(2) for b in range(2)
    ]
    values = [0, 1, 65535, 65536, 16777216, 4294967295]
    values.extend(rng.getrandbits(32) for _ in range(16))
    inputs.extend(("setEnglishBit", [value, bit])
                  for value in values for bit in (False, True))
    inputs.extend(("isSupported", [value]) for value in values)
    return [{"id": f"grammar-{index:03d}", "kind": "shared",
             "target": symbol, "input": {"symbol": symbol, "args": args}}
            for index, (symbol, args) in enumerate(inputs)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path,
                        default=Path("/usr/lib/libreoffice/program/libforlo.so"))
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    args = parser.parse_args()
    engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
    manifest = engine.analyze(args.binary)
    scopes = []
    for name, seeds, query, budget in FAMILIES:
        scope = persist_scope(engine, manifest, ScopeRequest(
            mode="subsystem", query=query, seeds=seeds,
            max_functions=budget, max_depth=3, include_shared_data=False))
        scopes.append({"name": name, "artifact": scope["artifact"],
                       "included": len(scope["included"]),
                       "unresolved": len(scope["unresolved"])})
    runner = NativeProbeRunner(
        engine, Path(__file__).with_name("calc_grammar_probe_adapter.py"))
    observations = [runner.run_case(args.binary, case) for case in grammar_cases()]
    report = {"schema": 1, "campaign": manifest["campaign"],
              "scopes": scopes, "observations": [item["artifact"] for item in observations],
              "observation_count": sum(item["outcome"] == "observed" for item in observations),
              "execution_errors": [item["case_id"] for item in observations
                                   if item["outcome"] == "execution_error"],
              "status": "original_observed"}
    report["artifact"] = engine.store.put(json.dumps(report, sort_keys=True).encode())
    print(json.dumps({key: value for key, value in report.items()
                      if key != "observations"}, indent=2))
    if report["execution_errors"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
