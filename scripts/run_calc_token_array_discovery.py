"""Discover Calc token-array behavior through live original method calls."""

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

SEEDS = ("HasOpCode", "HasReferences", "HasExternalRef", "HasNameOrColRowName",
         "AddOpCode", "AddDouble", "Clear", "FirstToken", "Assign", "Finalize")


def token_cases() -> list[dict]:
    rng = random.Random(91347)
    cases = []
    patterns = [
        [], [{"op": "add_opcode", "value": 0}],
        [{"op": "add_double", "value": 2.5}],
        [{"op": "add_opcode", "value": 21}, {"op": "copy"}],
        [{"op": "add_opcode", "value": 3}, {"op": "finalize"}],
        [{"op": "add_opcode", "value": 5}, {"op": "clear"}],
        [{"op": "add_opcode", "value": 7}, {"op": "clear"},
         {"op": "add_opcode", "value": 9}],
    ]
    values = [0, 1, 2, 3, 5, 7, 9, 20, 21, 22, 40, 70, 100, 140]
    for _ in range(64):
        steps = []
        for _ in range(rng.randint(1, 8)):
            action = rng.choices(("add_opcode", "add_double", "clear", "copy", "finalize"),
                                 weights=(6, 2, 1, 1, 1))[0]
            if action == "add_opcode":
                steps.append({"op": action, "value": rng.choice(values)})
            elif action == "add_double":
                steps.append({"op": action, "value": rng.choice((-3.25, 0.0, 1.5, 42.0))})
            else:
                steps.append({"op": action})
        patterns.append(steps)
    for index, steps in enumerate(patterns):
        opcodes = [step["value"] for step in steps if step["op"] == "add_opcode"]
        queries = sorted(set([0, 1, 21, 140, *opcodes]))[:16]
        targets = sorted({"HasOpCode", "FirstToken", "HasReferences",
                          "HasExternalRef", "HasNameOrColRowName",
                          *({"AddOpCode"} if opcodes else set()),
                          *({"AddDouble"} if any(x["op"] == "add_double" for x in steps) else set()),
                          *({"Clear"} if any(x["op"] == "clear" for x in steps) else set()),
                          *({"Assign"} if any(x["op"] == "copy" for x in steps) else set()),
                          *({"Finalize"} if any(x["op"] == "finalize" for x in steps) else set())})
        cases.append({"id": f"token-array-{index:03d}", "kind": "shared",
                      "target": "FormulaTokenArray", "targets": targets,
                      "input": {"steps": steps, "queries": queries}})
    return cases


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path,
                        default=Path("/usr/lib/libreoffice/program/libforlo.so"))
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    args = parser.parse_args()
    engine = GhidraAnalysis(args.state, Path("/opt/ghidra/support/analyzeHeadless"),
                            warm_workers=0)
    manifest = engine.analyze(args.binary)
    scope = persist_scope(engine, manifest, ScopeRequest(
        mode="subsystem", query="Manage and inspect Calc formula token arrays",
        seeds=SEEDS, max_functions=96, max_depth=3, include_shared_data=False))
    runner = NativeProbeRunner(
        engine, Path(__file__).with_name("calc_token_array_probe_adapter.py"))
    results = []
    for case in token_cases():
        result = runner.run_case(args.binary, case)
        results.append(result)
    report_artifact = engine.store.put(json.dumps({"schema": 1, "results": results},
                                                  sort_keys=True).encode())
    training_artifact = engine.store.put(json.dumps(
        {"schema": 1, "results": results[:32]}, sort_keys=True).encode())
    print(json.dumps({"scope_artifact": scope["artifact"],
                      "included": len(scope["included"]),
                      "unresolved": len(scope["unresolved"]),
                      "probe_report_artifact": report_artifact,
                      "training_report_artifact": training_artifact,
                      "observed": sum(x["outcome"] == "observed" for x in results),
                      "errors": [{"case_id": x["case_id"], "error": x["error"]}
                                 for x in results if x["outcome"] != "observed"]}, indent=2))
    if any(x["outcome"] != "observed" for x in results):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
