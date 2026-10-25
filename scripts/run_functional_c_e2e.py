"""Derive a functional spec from original observations and test a clean C clone.

This is an operation-level path for interfaces whose C++ implementation graph
contains private ABI mechanics. The hidden original cases are never sent to a
model or used for repair. A passing public set alone is never called equivalent.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.behavior import is_observable_claim
from engine.model_runtime import invoke_opencode
from engine.observations import (derive_effects, derive_invariants, describe,
                                 describe_effects)
from engine.worker import parse_answer
from engine.watchdog import Watchdog
from engine.validation.probes import NativeProbeRunner
from model_config import get_model
from scripts.run_native_c_candidate import extract_c


STEP_CODES = {"add_opcode": 1, "add_double": 2, "clear": 3, "finalize": 4, "copy": 5}
SNAPSHOT_LABELS = ["nonempty", "has_references", "has_external_ref", "has_name"]
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


def _spec_answer(reply: str, known_invariants: list[str] | None = None,
                 required_invariants: list[str] | None = None,
                 required_effects: list[str] | None = None) -> dict:
    answer = parse_answer(reply)
    if set(answer) != {"purpose", "state", "rules", "uncertainties",
                       "evidence_rules", "effects"}:
        raise ValueError("functional spec has wrong fields")
    if not isinstance(answer["purpose"], str) or not answer["purpose"].strip():
        raise ValueError("functional spec needs a purpose")
    for field in ("state", "rules", "uncertainties"):
        if not isinstance(answer[field], list) or any(
                not isinstance(item, str) or not item.strip() for item in answer[field]):
            raise ValueError(f"functional spec {field} must be an array of strings")
    if not answer["rules"] or any(not is_observable_claim(rule) for rule in answer["rules"]):
        raise ValueError("functional rules must describe caller-visible behavior")
    cited = []
    for entry in answer["evidence_rules"]:
        if not isinstance(entry, dict) or set(entry) != {"invariant", "rule"}:
            raise ValueError("evidence_rule needs exactly invariant and rule")
        if not isinstance(entry["invariant"], str) or not entry["invariant"].strip():
            raise ValueError("evidence_rule needs an invariant id")
        if not isinstance(entry["rule"], str) or not entry["rule"].strip():
            raise ValueError("evidence_rule needs a rule sentence")
        if (len(entry["rule"]) > 400 or
                re.search(r"0x[0-9a-f]+|```|[{}]", entry["rule"], re.I)):
            raise ValueError("evidence_rule must be a short prose sentence")
        cited.append(entry["invariant"])
    if known_invariants is not None:
        unknown = sorted(set(cited) - set(known_invariants))
        if unknown:
            raise ValueError(f"evidence_rules cite unknown invariants {unknown}")
    if required_invariants is not None:
        missing = sorted(set(required_invariants) - set(cited))
        if missing or len(cited) != len(set(cited)):
            raise ValueError("evidence_rules must cite each supported invariant once; "
                             f"missing {missing}")
    stated = []
    for entry in answer["effects"]:
        if not isinstance(entry, dict) or set(entry) != {"effect", "rule"}:
            raise ValueError("effect needs exactly effect and rule")
        if not isinstance(entry["effect"], str) or not entry["effect"].strip():
            raise ValueError("effect needs an effect id")
        if not isinstance(entry["rule"], str) or not entry["rule"].strip():
            raise ValueError("effect needs a rule sentence")
        if (len(entry["rule"]) > 400 or
                re.search(r"0x[0-9a-f]+|```|[{}]", entry["rule"], re.I)):
            raise ValueError("effect rule must be a short prose sentence")
        stated.append(entry["effect"])
    if required_effects is not None:
        missing = sorted(set(required_effects) - set(stated))
        unknown = sorted(set(stated) - set(required_effects))
        if missing or unknown or len(stated) != len(set(stated)):
            raise ValueError("effects must state each observed effect once; "
                             f"missing {missing}, unknown {unknown}")
    return answer


def _transition(case: dict) -> dict:
    """Compact evidence row so a supervisor can read original transitions."""
    steps = [[STEP_CODES[step["op"]], step.get("value")]
             for step in case["input"]["steps"]]
    rows = [[int(snapshot["nonempty"]), int(snapshot["has_references"]),
             int(snapshot["has_external_ref"]), int(snapshot["has_name"]),
             *[int(value) for value in snapshot["has_opcode"]]]
            for snapshot in case["observed"]["snapshots"]]
    return {"id": case["case_id"], "opcodes": case["input"]["queries"],
            "labels": [*SNAPSHOT_LABELS,
                       *[f"opcode {value}" for value in case["input"]["queries"]]],
            "steps": steps, "rows": rows}


def _mismatch_sentences(case: dict, observed: object) -> list[str]:
    """Name each disagreement in the observation's own terms."""
    expected_rows = case["observed"]["snapshots"]
    candidate_rows = (observed or {}).get("snapshots") if isinstance(observed, dict) else None
    if not isinstance(candidate_rows, list):
        return [f"case {case['case_id']}: the candidate produced no snapshots"]
    names = [*SNAPSHOT_LABELS,
             *[f"opcode {value}" for value in case["input"]["queries"]]]
    sentences = []
    for index, expected in enumerate(expected_rows):
        if index >= len(candidate_rows):
            sentences.append(f"case {case['case_id']} step {index}: the candidate stopped "
                             f"before this snapshot")
            continue
        candidate = candidate_rows[index]
        values = [expected["nonempty"], expected["has_references"],
                  expected["has_external_ref"], expected["has_name"],
                  *expected.get("has_opcode", [])]
        other = [candidate["nonempty"], candidate["has_references"],
                 candidate["has_external_ref"], candidate["has_name"],
                 *candidate.get("has_opcode", [])]
        if values == other:
            continue
        changes = [f"{names[column]} is {int(bool(values[column]))} in the original and "
                   f"{int(bool(other[column]))} in the candidate"
                   for column in range(min(len(values), len(other), len(names)))
                   if bool(values[column]) != bool(other[column])]
        if changes:
            sentences.append(f"case {case['case_id']} step {index}: " + "; ".join(changes))
    return sentences


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
    parser.add_argument("--plateau-attempts", type=int, default=3,
                        help="attempts without improvement before re-deriving the spec")
    parser.add_argument("--max-spec-revisions", type=int, default=2)
    parser.add_argument("--opencode", type=Path,
                        default=Path.home() / ".opencode/bin/opencode")
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    args = parser.parse_args()
    if not 0 <= args.max_revisions <= 8:
        parser.error("--max-revisions must be between zero and eight")
    if args.plateau_attempts < 1 or not 0 <= args.max_spec_revisions <= 4:
        parser.error("--plateau-attempts must be positive and --max-spec-revisions "
                     "between zero and four")
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
    transitions = [_transition(case) for case in public]
    analysis = derive_invariants(transitions)
    effects = derive_effects(transitions)
    operation_names = {code: name for name, code in STEP_CODES.items()}
    invariant_lines = describe(analysis, operation_names, tiers=("supported",))
    effect_lines = describe_effects(effects, operation_names)
    supported_ids = [item["id"] for item in analysis["invariants"]
                     if item["tier"] == "supported"]
    effect_ids = [item["id"] for item in effects]
    uncovered_lines = [
        f"case {item['case']} step {item['step']}: operation {item['operation']} left "
        f"every reported value unchanged"
        for item in analysis["uncovered_no_effect"]]
    engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
    runner = NativeProbeRunner(engine, Path(__file__).with_name(interface["adapter"]))
    watchdog = Watchdog(engine, args.opencode)
    spec_model = get_model("spec_writer", explicit=args.spec_model)
    implementation_model = get_model("engine_writer", explicit=args.implementation_model)
    with TemporaryDirectory(prefix="splice-functional-c-") as temporary:
        folder = Path(temporary)
        def spec_prompt(note: str = "") -> str:
            return (
                "Infer a clean-room functional specification from immutable observations of "
                "an original native subsystem. The implementation language and object layout "
                "are irrelevant. Explain general rules for state transitions and queries. "
                "Do not restate each example as a lookup table. Do not invent rules "
                "unsupported by observations; list uncertainties separately. The derived "
                "invariants below were induced mechanically from the same observations and "
                "have no counterexample, so each supported invariant needs exactly one entry "
                "in evidence_rules. An invariant only says when an operation has no reported "
                "effect under that condition; it never licenses a blanket rule that the "
                "operation is inert, so describe each operation's normal effect as well. "
                "Explain the uncovered no-effect transitions in your rules or in "
                "uncertainties. Return one JSON object with exactly purpose (string), "
                "state (array of strings), rules (array of caller-visible sentences), "
                "uncertainties (array of strings), evidence_rules (array of objects with "
                "exactly invariant and rule, where invariant is the invariant id and rule is "
                "a caller-visible sentence), and effects (array of objects with exactly "
                "effect and rule, one per observed effect id, stating how that value normally "
                "changes). No rule may deny an observed effect. No markdown.\n" + note +
                f"Public operations found in native scope: {json.dumps(names)}\n"
                f"C interface contract: {interface['contract']}\n"
                f"Observed effects: {json.dumps(effect_lines)}\n"
                f"Derived invariants: {json.dumps(invariant_lines)}\n"
                f"No-effect transitions no invariant covers: {json.dumps(uncovered_lines)}\n"
                f"Observation format: {EVIDENCE_LEGEND}\n"
                f"Original observations: {json.dumps(transitions, separators=(',', ':'))}"
            )

        spec_runs = itertools.count()

        def write_spec(note: str = "") -> tuple[dict, str]:
            errors, prior_watchdog = [], None
            for _ in range(3):
                turn = folder / f"spec-{next(spec_runs)}"
                turn.mkdir()
                supervision = watchdog.inspect(
                    campaign=scope["campaign"], scope_artifact=args.scope_artifact,
                    subject=interface["target"], stage="spec",
                    snapshot={"public_case_count": len(public), "operations": names,
                              "effects": effect_lines,
                              "invariants": invariant_lines,
                              "uncovered_no_effect": uncovered_lines,
                              "plateau_note": note or None,
                              "prior_error": errors[-1] if errors else None},
                    previous_artifact=prior_watchdog)
                prior_watchdog = supervision["artifact"]
                guidance = supervision["intervention"]
                active_model = (get_model(guidance["model_role"])
                                if guidance["model_role"] else spec_model)
                prompt = spec_prompt(note) + (
                    "\nSupervisor focus (verify against observations): " + guidance["guidance"]
                    if guidance["guidance"] else "")
                if errors:
                    prompt += "\nPrior output failed: " + errors[-1]
                try:
                    reply = invoke_opencode(
                        args.opencode, turn, prompt, model=active_model, timeout=180,
                        env_file=Path(__file__).resolve().parents[1] / ".env",
                        agent_name="functional-spec-writer",
                        agent_instruction="Return evidence-grounded JSON only. Use no tools.")
                    written = _spec_answer(reply["text"], supported_ids, supported_ids,
                                           effect_ids)
                except Exception as exc:
                    errors.append(str(exc))
                    continue
                record = {"schema": 2, "status": "provisional",
                          "interface": args.interface,
                          "scope_artifact": args.scope_artifact,
                          "public_report_artifact": args.public_report_artifact,
                          "full_report_artifact": args.full_report_artifact,
                          "binary_sha256": next(iter(hashes)), "spec": written,
                          "public_examples": examples,
                          "public_case_artifacts": [row["artifact"] for row in public],
                          "invariants": analysis["invariants"],
                          "effects": effects,
                          "uncovered_no_effect": analysis["uncovered_no_effect"],
                          "model": active_model, "watchdog_artifact": prior_watchdog,
                          "plateau_note": note or None,
                          "revision": len(progress.get("spec_history", [])) + 1}
                artifact = store.put(json.dumps(record, sort_keys=True).encode())
                progress.setdefault("spec_history", []).append(
                    {"artifact": artifact, "model": active_model, "note": note or None,
                     "invariants": supported_ids})
                progress["spec_artifact"] = artifact
                save()
                return written, artifact
            raise RuntimeError("functional spec writer failed: " + json.dumps(errors))

        spec, spec_artifact = None, args.spec_artifact
        if spec_artifact:
            saved = json.loads(store.get(spec_artifact))
            if (saved.get("schema") == 2 and saved.get("status") == "provisional"
                    and saved.get("interface") == args.interface
                    and saved.get("scope_artifact") == args.scope_artifact
                    and saved.get("public_report_artifact") == args.public_report_artifact
                    and saved.get("full_report_artifact") == args.full_report_artifact
                    and saved.get("binary_sha256") == next(iter(hashes))
                    and saved.get("public_case_artifacts") == [row["artifact"]
                                                              for row in public]
                    and [item.get("id") for item in saved.get("invariants", [])]
                    == [item["id"] for item in analysis["invariants"]]
                    and [item.get("id") for item in saved.get("effects", [])]
                    == effect_ids):
                try:
                    spec = _spec_answer(json.dumps(saved["spec"]), supported_ids,
                                        supported_ids, effect_ids)
                except ValueError as exc:
                    progress.setdefault("spec_rejections", []).append(
                        {"artifact": spec_artifact, "reason": str(exc)[:300]})
                    save()
        if spec is None:
            # A spec without the current invariants is not resumable: it cannot
            # account for evidence that was already observed.
            spec, spec_artifact = write_spec()
        progress["spec_artifact"] = spec_artifact
        save()

        def implementation_prompt(active_spec: dict) -> str:
            return (
                "Implement this provisional functional specification in portable C11. The "
                "original binary is C++ but the C API and observable outcomes are the whole "
                "contract. Use ordinary C state and algorithms; no vtables, C++ layout, "
                "dynamic loading, input lookup tables, or external program calls. The "
                "original observations are normative: when the specification or the "
                "supervisor's focus conflicts with them, follow the observations. Every "
                "derived invariant was induced from the observations, so its condition must "
                "be implemented as part of the state machine, but an invariant only removes "
                "an effect under that condition and says nothing about behaviour outside it. "
                "Return one complete C "
                "translation unit only. Check every observation below before answering.\n"
                f"C interface: {interface['contract']}\n"
                f"Observation format: {EVIDENCE_LEGEND}\n"
                f"Observed effects: {json.dumps(effect_lines)}\n"
                f"Derived invariants: {json.dumps(invariant_lines)}\n"
                f"No-effect transitions no invariant covers: {json.dumps(uncovered_lines)}\n"
                f"Original observations: {json.dumps(transitions, separators=(',', ':'))}\n"
                f"Functional spec: {json.dumps(active_spec)}"
            )

        base_prompt = implementation_prompt(spec)
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
                                       "findings": _mismatch_sentences(
                                           row, comparison["observed"])[:6],
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
        if best is not None:
            # Re-evaluate the recorded best so its mismatches carry the current
            # plain-language findings instead of a stale diff-only record.
            refreshed = check(store.get(best["source_artifact"]).decode())
            if refreshed != best.get("failures"):
                best = {"source_artifact": best["source_artifact"],
                        "public_failures": len(refreshed), "failures": refreshed[:32]}
                progress["best"] = best
                save()
        supervision = progress.setdefault("supervision", [])
        revisions = []
        previous_watchdog = None
        stale, spec_revisions = 0, 0
        for number in range(args.max_revisions + 1):
            base = None
            if best is not None:
                sentences = [sentence for failure in best["failures"][:8]
                             for sentence in failure.get("findings", [])]
                base = (base_prompt + "\nA previous C implementation failed these reported "
                        "values. The original observation wins over the specification or a "
                        "derived invariant whenever they disagree. Return a complete "
                        "corrected translation unit.\nBest source so far:\n" +
                        store.get(best["source_artifact"]).decode() +
                        "\nDisagreements: " + json.dumps(sentences[:24]) +
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
                          "effects": effect_lines,
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
            stale = 0 if kept else stale + 1
            if stale >= args.plateau_attempts and spec_revisions < args.max_spec_revisions:
                # The implementation stopped improving: the rules, not the code,
                # are the remaining problem, so re-derive them from the evidence.
                note = ("A previous implementation plateaued at " +
                        (f"{best['public_failures']} mismatching cases" if best
                         else "every attempt") +
                        " without improving. Rewrite the rules so those transitions "
                        "follow from the state machine instead of an unexplained "
                        "exception, keeping every derived invariant. Mismatches: " +
                        json.dumps((best or {}).get("failures", [])[:8]))
                spec, spec_artifact = write_spec(note)
                base_prompt = implementation_prompt(spec)
                spec_revisions += 1
                stale = 0
                previous_watchdog = None
        if best is None or best["public_failures"]:
            raise RuntimeError("candidate failed public examples: " + json.dumps({
                "spec_artifact": spec_artifact,
                "spec_revisions": len(progress.get("spec_history", [])),
                "invariants": invariant_lines,
                "revisions": revisions,
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
