"""Derive a functional spec from original observations and test a clean C clone.

This is an operation-level path for interfaces whose C++ implementation graph
contains private ABI mechanics. The hidden original cases are never sent to a
model or used for repair. A passing public set alone is never called equivalent.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.behavior import is_observable_claim
from engine.model_runtime import invoke_opencode
from engine.worker import parse_answer
from engine.watchdog import Watchdog
from engine.validation.probes import NativeProbeRunner
from model_config import get_model
from scripts.run_native_c_candidate import extract_c


STEP_CODES = {"add_opcode": 1, "add_double": 2, "clear": 3, "finalize": 4, "copy": 5}
EVIDENCE_LEGEND = (
    "Each original case lists the query opcodes, its steps as [step code, argument] "
    "(1 append opcode argument, 2 append double argument, 3 clear, 4 finalize, 5 copy) "
    "and one row per observed snapshot, starting with the empty array. A row is "
    "[nonempty, has_references, has_external_ref, has_name, has_opcode for each query] "
    "with 0 or 1 values."
)


INTERFACES = {
    "token-array": {
        "target": "FormulaTokenArray",
        "adapter": "c_token_array_candidate_adapter.py",
        "contract": (
            "Export exactly int token_array_run(const uint8_t *ops, const uint16_t *opcodes, "
            "const double *numbers, uint32_t step_count, const uint16_t *queries, "
            "uint32_t query_count, uint8_t *output). Ops: 1 add opcode from opcodes[i], "
            "2 add double from numbers[i], 3 clear, 4 finalize, 5 copy the current array "
            "onto a second array and continue with that copy. Write step_count+1 consecutive "
            "snapshot rows, including the initial empty state. Each row has 4+query_count "
            "bytes: nonempty, has_references, has_external_ref, has_name, then has_opcode "
            "for each queries[j]. Values are 0 or 1. Return 0 on success."
        ),
    },
}


def _cases(store: LocalArtifactStore, artifact: str) -> list[dict]:
    report = json.loads(store.get(artifact))
    if report.get("schema") != 1 or not isinstance(report.get("results"), list):
        raise ValueError("invalid probe report")
    cases = []
    for row in report["results"]:
        stored = json.loads(store.get(row["artifact"]))
        if stored != {key: value for key, value in row.items() if key != "artifact"}:
            raise ValueError("probe report differs from immutable case")
        if (row.get("execution_mode") != "original" or row.get("outcome") != "observed"
                or row.get("expected") is not None or row.get("observed") is None):
            raise ValueError("probe report needs unlabelled successful original cases")
        cases.append(row)
    return cases


def _summary(case: dict) -> dict:
    return {"id": case["case_id"], "input": case["input"],
            "output": case["observed"]}


def _spec_answer(reply: str) -> dict:
    answer = parse_answer(reply)
    if set(answer) != {"purpose", "state", "rules", "uncertainties"}:
        raise ValueError("functional spec has wrong fields")
    if not isinstance(answer["purpose"], str) or not answer["purpose"].strip():
        raise ValueError("functional spec needs a purpose")
    for field in ("state", "rules", "uncertainties"):
        if not isinstance(answer[field], list) or any(
                not isinstance(item, str) or not item.strip() for item in answer[field]):
            raise ValueError(f"functional spec {field} must be an array of strings")
    if not answer["rules"] or any(not is_observable_claim(rule) for rule in answer["rules"]):
        raise ValueError("functional rules must describe caller-visible behavior")
    return answer


def _transition(case: dict) -> dict:
    """Compact evidence row so a supervisor can read original transitions."""
    steps = [[STEP_CODES[step["op"]], step.get("value")]
             for step in case["input"]["steps"]]
    rows = [[int(snapshot["nonempty"]), int(snapshot["has_references"]),
             int(snapshot["has_external_ref"]), int(snapshot["has_name"]),
             *[int(value) for value in snapshot["has_opcode"]]]
            for snapshot in case["observed"]["snapshots"]]
    return {"opcodes": case["input"]["queries"], "steps": steps, "rows": rows}


def _differences(expected: object, observed: object, path: str = "") -> list[dict]:
    if isinstance(expected, dict) and isinstance(observed, dict):
        return [difference for key in expected for difference in
                _differences(expected[key], observed.get(key), f"{path}/{key}")]
    if isinstance(expected, list) and isinstance(observed, list):
        return [difference for index, item in enumerate(expected) for difference in
                _differences(item, observed[index] if index < len(observed) else None,
                             f"{path}/{index}")]
    return [] if expected == observed else [{"path": path, "expected": expected,
                                            "observed": observed}]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--public-report-artifact", required=True)
    parser.add_argument("--full-report-artifact", required=True)
    parser.add_argument("--scope-artifact", required=True)
    parser.add_argument("--interface", choices=INTERFACES, default="token-array")
    parser.add_argument("--spec-model")
    parser.add_argument("--spec-artifact", help="resume a provisional spec from this exact public set")
    parser.add_argument("--implementation-model")
    parser.add_argument("--max-revisions", type=int, default=6)
    parser.add_argument("--opencode", type=Path,
                        default=Path.home() / ".opencode/bin/opencode")
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    args = parser.parse_args()
    if not 0 <= args.max_revisions <= 8:
        parser.error("--max-revisions must be between zero and eight")
    store = LocalArtifactStore(args.state / "artifacts")
    public = _cases(store, args.public_report_artifact)
    full = _cases(store, args.full_report_artifact)
    scope = json.loads(store.get(args.scope_artifact))
    interface = INTERFACES[args.interface]
    if not public or len(public) < 10 or not full:
        raise ValueError("functional pass requires substantial original observations")
    if any(row["target"] != interface["target"] for row in public + full):
        raise ValueError("probe target and requested interface differ")
    hashes = {row["binary_sha256"] for row in public + full}
    if len(hashes) != 1 or scope.get("campaign") is None:
        raise ValueError("original cases do not identify one binary campaign")
    manifest_path = args.state / "projects" / scope["campaign"] / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("binary_sha256") != next(iter(hashes)):
        raise ValueError("original cases and native scope refer to different binaries")
    full_by_artifact = {row["artifact"]: row for row in full}
    if len(full_by_artifact) != len(full):
        raise ValueError("full report repeats an original case")
    if any(row["artifact"] not in full_by_artifact for row in public):
        raise ValueError("public cases are not a subset of the full report")
    public_ids = {row["artifact"] for row in public}
    hidden = [row for row in full if row["artifact"] not in public_ids]
    if not hidden or {json.dumps(row["input"], sort_keys=True) for row in public} & {
            json.dumps(row["input"], sort_keys=True) for row in hidden}:
        raise ValueError("held-out inputs must be disjoint from public inputs")
    names = [item["name"] for item in scope["included"]]
    run_key = hashlib.sha256(json.dumps({
        "scope": args.scope_artifact, "public": args.public_report_artifact,
        "full": args.full_report_artifact, "interface": args.interface},
        sort_keys=True).encode()).hexdigest()
    checkpoint_path = args.state / "runs" / "functional-c" / run_key / "progress.json"
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    progress = json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {
        "schema": 1, "run_key": run_key, "revisions": []}
    if progress.get("run_key") != run_key:
        raise ValueError("functional C checkpoint belongs to another run")

    def save() -> None:
        pending = checkpoint_path.with_suffix(".tmp")
        pending.write_text(json.dumps(progress, indent=2) + "\n")
        os.replace(pending, checkpoint_path)

    if not args.spec_artifact:
        args.spec_artifact = progress.get("spec_artifact")
    examples = [_summary(row) for row in public]
    spec_prompt = (
        "Infer a clean-room functional specification from immutable observations of an "
        "original native subsystem. The implementation language and object layout are "
        "irrelevant. Explain general rules for state transitions and queries, including "
        "clear, copy, and finalize. Do not restate each example as a lookup table. Do not "
        "invent rules unsupported by observations; list uncertainties separately. Return "
        "one JSON object with exactly purpose (string), state (array of strings), rules "
        "(array of caller-visible sentences), uncertainties (array of strings). No markdown.\n"
        f"Public operations found in native scope: {json.dumps(names)}\n"
        f"C interface contract: {interface['contract']}\n"
        f"Original observations: {json.dumps(examples, separators=(',', ':'))}"
    )
    engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
    runner = NativeProbeRunner(engine, Path(__file__).with_name(interface["adapter"]))
    watchdog = Watchdog(engine, args.opencode)
    spec_model = get_model("spec_writer", explicit=args.spec_model)
    implementation_model = get_model("engine_writer", explicit=args.implementation_model)
    with TemporaryDirectory(prefix="splice-functional-c-") as temporary:
        folder = Path(temporary)
        if args.spec_artifact:
            spec_record = json.loads(store.get(args.spec_artifact))
            if any(spec_record.get(key) != value for key, value in {
                    "status": "provisional", "interface": args.interface,
                    "scope_artifact": args.scope_artifact,
                    "public_report_artifact": args.public_report_artifact,
                    "full_report_artifact": args.full_report_artifact,
                    "binary_sha256": next(iter(hashes)),
                    "public_case_artifacts": [row["artifact"] for row in public]}.items()):
                raise ValueError("saved provisional spec has different provenance")
            spec = _spec_answer(json.dumps(spec_record["spec"]))
            spec_artifact = args.spec_artifact
        else:
            spec_errors = []
            prior_spec_watchdog = None
            for number in range(3):
                turn = folder / f"spec-{number}"
                turn.mkdir()
                supervision = watchdog.inspect(
                    campaign=scope["campaign"], scope_artifact=args.scope_artifact,
                    subject=interface["target"], stage="spec",
                    snapshot={"public_case_count": len(public), "operations": names,
                              "prior_error": spec_errors[-1] if spec_errors else None},
                    previous_artifact=prior_spec_watchdog)
                prior_spec_watchdog = supervision["artifact"]
                guidance = supervision["intervention"]
                active_spec_model = (get_model(guidance["model_role"])
                                     if guidance["model_role"] else spec_model)
                try:
                    reply = invoke_opencode(
                        args.opencode, turn,
                        spec_prompt + ("\nSupervisor focus (verify against examples): " +
                                       guidance["guidance"] if guidance["guidance"] else "") +
                        ("\nPrior output failed: " + spec_errors[-1] if spec_errors else ""),
                        model=active_spec_model, timeout=180,
                        env_file=Path(__file__).resolve().parents[1] / ".env",
                        agent_name="functional-spec-writer",
                        agent_instruction="Return evidence-grounded JSON only. Use no tools.")
                    spec = _spec_answer(reply["text"])
                    break
                except Exception as exc:
                    spec_errors.append(str(exc))
            else:
                raise RuntimeError("functional spec writer failed: " + json.dumps(spec_errors))
            spec_record = {"schema": 1, "status": "provisional", "interface": args.interface,
                           "scope_artifact": args.scope_artifact,
                           "public_report_artifact": args.public_report_artifact,
                           "full_report_artifact": args.full_report_artifact,
                           "binary_sha256": next(iter(hashes)), "spec": spec,
                           "public_examples": examples,
                           "public_case_artifacts": [row["artifact"] for row in public],
                           "model": active_spec_model,
                           "watchdog_artifact": prior_spec_watchdog}
            spec_artifact = store.put(json.dumps(spec_record, sort_keys=True).encode())
        progress["spec_artifact"] = spec_artifact
        save()
        transitions = [_transition(case) for case in public]
        base_prompt = (
            "Implement this provisional functional specification in portable C11. The "
            "original binary is C++ but the C API and observable outcomes are the whole "
            "contract. Use ordinary C state and algorithms; no vtables, C++ layout, dynamic "
            "loading, input lookup tables, or external program calls. The original "
            "observations are normative: when the specification or the supervisor's focus "
            "conflicts with them, follow the observations. Derive each rule from the "
            "transitions, and treat an operation that leaves every reported value unchanged "
            "as a real outcome rather than an error. Return one complete C translation unit "
            "only. Check every observation below before answering.\n"
            f"C interface: {interface['contract']}\n"
            f"Observation format: {EVIDENCE_LEGEND}\n"
            f"Original observations: {json.dumps(transitions, separators=(',', ':'))}\n"
            f"Functional spec: {json.dumps(spec)}"
        )
        source_path, library_path = folder / "candidate.c", folder / "candidate.so"

        def check(candidate: str) -> list[dict]:
            source_path.write_text(candidate)
            built = subprocess.run(
                ["cc", "-std=c11", "-O2", "-fPIC", "-shared", "-Wall", "-Wextra",
                 "-o", str(library_path), str(source_path)],
                capture_output=True, text=True, timeout=30, check=False)
            if built.returncode:
                return [{"compiler_error": built.stderr[-2000:]}]
            mismatches = []
            for row in public:
                comparison = runner.compare_case(library_path, row)
                if comparison["outcome"] != "agreement":
                    mismatches.append({"case_id": row["case_id"], "input": row["input"],
                                       "differences": _differences(
                                           row["observed"], comparison["observed"])[:6],
                                       "error": comparison["error"]})
            return mismatches

        # Repair always starts from the best candidate so far, never from a
        # regression. Legacy checkpoints have no recorded best, so re-evaluate
        # their lowest-failure source against the same public cases.
        best = progress.get("best")
        if best:
            try:
                store.get(best.get("source_artifact") or "")
            except (ValueError, FileNotFoundError):
                best = None
        if best is None:
            stored = [row for row in progress["revisions"] if row.get("source_artifact")]
            if stored:
                seed = min(stored, key=lambda row: row["public_failures"])
                failures = check(store.get(seed["source_artifact"]).decode())
                best = {"source_artifact": seed["source_artifact"],
                        "public_failures": len(failures), "failures": failures[:32]}
                progress["best"] = best
                save()
        supervision = progress.setdefault("supervision", [])
        revisions = []
        previous_watchdog = None
        for number in range(args.max_revisions + 1):
            base = None
            if best is not None:
                base = (base_prompt + "\nA previous C implementation failed these public "
                        "cases. Return a complete corrected translation unit.\nBest source so "
                        "far:\n" + store.get(best["source_artifact"]).decode() +
                        "\nCompact transition mismatches: " +
                        json.dumps(best["failures"][:16]))
            turn = folder / f"implementation-{number}"
            turn.mkdir()
            advice_record = watchdog.inspect(
                campaign=scope["campaign"], scope_artifact=args.scope_artifact,
                subject=interface["target"], stage="implementation",
                snapshot={"spec": spec,
                          "attempt": number + 1,
                          "best_public_failures": best["public_failures"] if best else None,
                          "public_failures": (best["failures"] if best else [])[:12],
                          "public_case_count": len(public),
                          "evidence_legend": EVIDENCE_LEGEND,
                          "original_transitions": transitions,
                          "previous_advice": supervision[-4:]},
                previous_artifact=previous_watchdog)
            previous_watchdog = advice_record["artifact"]
            advice = advice_record["intervention"]
            active_model = (implementation_model if args.implementation_model else
                            get_model(advice["model_role"]) if advice["model_role"]
                            else implementation_model)
            # Advice that was applied and made the attempt worse than the best
            # candidate is not reapplied; the observations and spec carry the
            # next attempt instead.
            last = supervision[-1] if supervision else None
            regressed = bool(last and last.get("guidance_applied")
                             and last["failures_before"] is not None
                             and last["failures_after"] > last["failures_before"])
            applied = bool(advice["guidance"]) and not regressed
            prompt = base or base_prompt
            focused_prompt = prompt + ("\nSupervisor focus (verify against public cases): " +
                                       advice["guidance"] if applied else "")
            try:
                reply = invoke_opencode(
                    args.opencode, turn, focused_prompt, model=active_model, timeout=180,
                    env_file=Path(__file__).resolve().parents[1] / ".env",
                    agent_name="functional-c-implementer",
                    agent_instruction="Return portable C11 code only. Use no tools.")
                source = extract_c(reply["text"])
                failures = check(source)
            except Exception as exc:
                source = None
                failures = [{"generation_error": str(exc)}]
            revisions.append({"number": number + 1,
                              "prompt_artifact": store.put(focused_prompt.encode()),
                              "watchdog_artifact": advice_record["artifact"],
                              "model": active_model,
                              "source_artifact": store.put(source.encode()) if source else None,
                              "public_failures": len(failures)})
            before = best["public_failures"] if best else None
            kept = bool(source and (best is None or len(failures) < best["public_failures"]))
            if kept:
                best = {"source_artifact": revisions[-1]["source_artifact"],
                        "public_failures": len(failures), "failures": failures[:32]}
                progress["best"] = best
            supervision.append({"attempt": number + 1,
                                "model": active_model,
                                "guidance": advice["guidance"][:500],
                                "guidance_applied": applied,
                                "failures_before": before,
                                "failures_after": len(failures),
                                "kept": kept})
            progress["revisions"].append(revisions[-1])
            progress["last_public_failures"] = failures[:32]
            save()
            if not failures:
                break
        if best is None or best["public_failures"]:
            raise RuntimeError("candidate failed public examples: " + json.dumps({
                "spec_artifact": spec_artifact, "revisions": revisions,
                "best": {key: value for key, value in (best or {}).items()
                         if key != "failures"},
                "failures": (best or {}).get("failures", [])[:8]}))
        source_path.write_text(store.get(best["source_artifact"]).decode())
        built = subprocess.run(
            ["cc", "-std=c11", "-O2", "-fPIC", "-shared", "-Wall", "-Wextra",
             "-o", str(library_path), str(source_path)],
            capture_output=True, text=True, timeout=30, check=False)
        if built.returncode:
            raise RuntimeError("best candidate no longer compiles: " + built.stderr[-2000:])
        hidden_results = [runner.compare_case(library_path, row) for row in hidden]
        counts = {outcome: sum(item["outcome"] == outcome for item in hidden_results)
                  for outcome in sorted({item["outcome"] for item in hidden_results})}
        result = {"schema": 1, "spec_artifact": spec_artifact,
                  "public_report_artifact": args.public_report_artifact,
                  "full_report_artifact": args.full_report_artifact,
                  "interface": args.interface, "source_artifact": best["source_artifact"],
                  "revisions": revisions, "hidden_cases": len(hidden), "counts": counts,
                  "hidden_result_artifacts": [item["artifact"] for item in hidden_results],
                  "equivalent_on_heldout": counts == {"agreement": len(hidden)}}
        result["artifact"] = store.put(json.dumps(result, sort_keys=True).encode())
        progress["result_artifact"] = result["artifact"]
        progress["equivalent_on_heldout"] = result["equivalent_on_heldout"]
        save()
        print(json.dumps({key: value for key, value in result.items()
                          if key != "hidden_result_artifacts"}, indent=2))
        if not result["equivalent_on_heldout"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
