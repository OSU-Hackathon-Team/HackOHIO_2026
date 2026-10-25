"""Expand the original evidence with observations that cover weakly supported contexts.

The functional pass can only derive rules about transitions it has seen, so a
sparse public set caps what any specification can say. This script closes that
gap without human judgement: it reads the recorded public and held-out original
cases, proposes new sequences that reach operation contexts the public set
exercises too rarely, observes those sequences against the original binary, and
publishes a new public/full report pair in which the new cases are trainable and
the existing held-out inputs stay held out and disjoint.

Proposals reuse only operations, arguments, and queries already observed, and any
sequence already recorded anywhere (including the held-out set) is skipped, so
the expansion adds coverage rather than duplicating evaluation cases.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.expansion import (context_support, propose, propose_argument_isolation,
                             weak_contexts)
from engine.observations import SUPPORTED_OCCURRENCES, reset_operations
from engine.validation.probes import NativeProbeRunner
from scripts.run_functional_c_e2e import INTERFACES, STEP_CODES, _cases, _transition


def _encode(plan: list[list], op_names: dict[int, str], argument_keys: dict[str, set[str]],
            queries: list[int]) -> dict:
    steps = []
    for step in plan:
        operation = op_names[step[0]]
        encoded = {"op": operation}
        if len(step) > 1 and step[1] is not None:
            keys = sorted(argument_keys.get(operation, ()))
            if len(keys) != 1:
                raise ValueError(f"operation {operation} has no single observed argument")
            encoded[keys[0]] = step[1]
        steps.append(encoded)
    return {"steps": steps, "queries": queries}


def _coverage(cases: list[dict], resets: set[int]) -> dict:
    support = context_support(cases, resets)
    weak = weak_contexts(cases, resets)
    return {"contexts": len(support), "weak": len(weak),
            "weak_examples": [f"operation {code} after {list(since)}"
                              for code, since in sorted(weak)[:6]],
            "operations": len({code for code, _ in support})}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--scope-artifact", required=True)
    parser.add_argument("--public-report-artifact", required=True)
    parser.add_argument("--full-report-artifact", required=True)
    parser.add_argument("--interface", choices=INTERFACES, default="token-array")
    parser.add_argument("--adapter", type=Path, required=True,
                        help="original observation adapter for this interface")
    parser.add_argument("--count", type=int, default=24)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--max-length", type=int, default=8)
    parser.add_argument("--max-queries", type=int, default=16)
    parser.add_argument("--dry-run", action="store_true",
                        help="print the proposed coverage without observing it")
    args = parser.parse_args()

    store = LocalArtifactStore(args.state / "artifacts")
    public = _cases(store, args.public_report_artifact)
    full = _cases(store, args.full_report_artifact)
    scope = json.loads(store.get(args.scope_artifact))
    interface = INTERFACES[args.interface]
    if not public or not full:
        raise ValueError("evidence expansion needs original observations")
    if any(row["target"] != interface["target"] for row in public + full):
        raise ValueError("probe target and requested interface differ")
    if any(row["artifact"] not in {case["artifact"] for case in full} for row in public):
        raise ValueError("public cases are not a subset of the full report")

    documented = {row["artifact"]: row for row in full}
    public_ids = {row["artifact"] for row in public}
    hidden = [row for row in full if row["artifact"] not in public_ids]
    if not hidden:
        raise ValueError("expansion would leave no held-out cases")
    if ({json.dumps(row["input"], sort_keys=True) for row in public}
            & {json.dumps(row["input"], sort_keys=True) for row in hidden}):
        raise ValueError("held-out inputs must be disjoint from public inputs")

    public_transitions = [_transition(row) for row in public]
    observed_inputs = {json.dumps(row["input"], sort_keys=True) for row in public + full}
    op_names = {code: name for name, code in STEP_CODES.items()}
    argument_keys: dict[str, set[str]] = {}
    query_values: list[int] = []
    for row in public + full:
        for step in row["input"]["steps"]:
            argument_keys.setdefault(step["op"], set()).update(
                key for key in step if key != "op")
        for value in row["input"].get("queries", []):
            if value not in query_values:
                query_values.append(value)
    queries = sorted(query_values)[:args.max_queries]

    resets = reset_operations(public_transitions)
    before = _coverage(public_transitions, resets)
    hidden_transitions = [_transition(row) for row in hidden]
    # Arguments nobody observed on an empty state teach nothing about what they
    # imply, so they are isolated first; context coverage fills the rest.
    isolated = propose_argument_isolation(public_transitions)
    plans = isolated + propose(public_transitions, max(args.count - len(isolated), 0),
                               seed=args.seed, max_length=args.max_length,
                               avoid=[case["steps"] for case in hidden_transitions])
    encoded = [_encode(plan, op_names, argument_keys, queries) for plan in plans]
    encoded = [case for case in encoded
               if json.dumps(case, sort_keys=True) not in observed_inputs]
    if args.dry_run:
        projected = public_transitions + [
            {"id": f"proposal-{index}", "steps": plan, "rows": [], "labels": []}
            for index, plan in enumerate(plans)]
        print(json.dumps({"before": before, "proposed": encoded,
                          "after": _coverage(projected, resets)}, indent=2)[:6000])
        print(json.dumps({"proposed_cases": len(encoded)}, indent=2))
        return

    manifest_path = args.state / "projects" / scope["campaign"] / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    hashes = {row["binary_sha256"] for row in public + full}
    if len(hashes) != 1 or manifest.get("binary_sha256") != next(iter(hashes)):
        raise ValueError("cases, native scope, and binary campaign disagree")
    binary = Path(manifest["binary"])
    engine = GhidraAnalysis(args.state, Path("/opt/ghidra/support/analyzeHeadless"),
                            warm_workers=0)
    runner = NativeProbeRunner(engine, args.adapter)

    added, failures = [], []
    template = next(row for row in public if "targets" in row)
    for index, plan in enumerate(plans):
        encoded_case = _encode(plan, op_names, argument_keys, queries)
        if json.dumps(encoded_case, sort_keys=True) in observed_inputs:
            continue
        case = {"id": f"{template['case_id'].rsplit('-', 1)[0]}-expanded-{index:03d}",
                "kind": "shared", "target": interface["target"],
                "targets": template["targets"], "input": encoded_case}
        result = runner.run_case(binary, case)
        if result.get("outcome") != "observed":
            failures.append({"case_id": case["id"], "error": result.get("error")})
            continue
        added.append(result)
        observed_inputs.add(json.dumps(encoded_case, sort_keys=True))

    if failures:
        raise SystemExit(json.dumps({"failures": failures}, indent=2))

    expanded_public = store.put(json.dumps(
        {"schema": 1, "results": [*public, *added]}, sort_keys=True).encode())
    expanded_full = store.put(json.dumps(
        {"schema": 1, "results": [*full, *added]}, sort_keys=True).encode())
    after = _coverage([*public_transitions, *[_transition(row) for row in added]], resets)
    print(json.dumps({
        "schema": 1,
        "public_report_artifact": expanded_public,
        "full_report_artifact": expanded_full,
        "added": len(added),
        "added_case_ids": [row["case_id"] for row in added],
        "held_out_cases": len(hidden),
        "support_threshold": SUPPORTED_OCCURRENCES,
        "coverage_before": before,
        "coverage_after": after,
        "weak_contexts_remaining": after["weak"],
    }, indent=2))


if __name__ == "__main__":
    main()
