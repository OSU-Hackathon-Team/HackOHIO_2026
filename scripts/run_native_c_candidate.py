"""Generate C from a ready public spec and compare against held-out original cases."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.model_runtime import invoke_opencode
from engine.validation.probes import NativeProbeRunner
from model_config import get_model


def extract_c(text: str) -> str:
    match = re.search(r"```(?:c)?\s*\n(.*?)\n```", text, re.S | re.I)
    source = match.group(1) if match else text.strip()
    if not source.startswith("#include") and not source.startswith("/*"):
        raise ValueError("model did not return a C translation unit")
    if re.search(r"\b(?:dlopen|dlsym|system|popen|execve|fork)\s*\(", source):
        raise ValueError("candidate tries to invoke an external implementation")
    return source


def ready_dossier(state: Path, store: LocalArtifactStore, spec_artifact: str) -> dict:
    for path in (state / "specifications").glob("*/dossier-*-writer-*.json"):
        pointer = json.loads(path.read_text())
        if pointer.get("artifact") != spec_artifact:
            continue
        audit = json.loads(store.get(pointer["audit_artifact"]))
        dossier = json.loads(store.get(pointer["dossier_artifact"]))
        if (audit.get("spec_artifact") != spec_artifact or
                audit.get("dossier_artifact") != pointer["dossier_artifact"] or
                dossier.get("readiness") != "ready_for_spec" or
                dossier.get("revision") != pointer.get("dossier_revision")):
            raise ValueError("spec provenance is inconsistent or dossier is not ready")
        return dossier
    raise ValueError("spec has no persisted dossier and writer provenance")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--spec-artifact", required=True)
    parser.add_argument("--probe-report-artifact", required=True)
    parser.add_argument("--model")
    parser.add_argument("--interface", choices=("scalar", "token-array"), default="scalar")
    parser.add_argument("--max-revisions", type=int, default=3)
    parser.add_argument("--opencode", type=Path,
                        default=Path.home() / ".opencode/bin/opencode")
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    args = parser.parse_args()
    store = LocalArtifactStore(args.state / "artifacts")
    spec = json.loads(store.get(args.spec_artifact))
    if spec.get("schema") != 2 or spec.get("status") != "ready_for_review":
        raise ValueError("C generation requires a ready native spec")
    dossier = ready_dossier(args.state, store, args.spec_artifact)
    report = json.loads(store.get(args.probe_report_artifact))
    if report.get("schema") != 1 or not isinstance(report.get("results"), list):
        raise ValueError("invalid original probe report")
    public_examples = {json.dumps(item["input"], sort_keys=True)
                       for item in spec.get("examples", [])}
    held_out = [item for item in report["results"]
                if item.get("outcome") in {"observed", "agreement"} and
                item.get("execution_mode") == "original" and
                item.get("binary_sha256") == dossier["binary_sha256"] and
                json.dumps(item.get("input"), sort_keys=True) not in public_examples]
    if not held_out:
        raise ValueError("no held-out original cases outside public spec examples")
    symbols = sorted({item["input"]["symbol"] for item in held_out
                      if item.get("kind") == "shared" and
                      isinstance(item.get("input"), dict) and
                      isinstance(item["input"].get("symbol"), str)})
    if args.interface == "scalar" and not symbols:
        raise ValueError("no scalar C exports to implement")
    if args.interface == "token-array" and any(
            item.get("target") != "FormulaTokenArray" for item in held_out):
        raise ValueError("token-array interface requires token-array original cases")
    interface_contract = (
        "Export names: " + json.dumps(symbols) + ". Parameters are unsigned 32-bit "
        "integers except boolean inputs, which are _Bool; EVERY function must return "
        "uint32_t, including predicates. " if args.interface == "scalar" else
        "Export exactly this functional C API: int token_array_run(const uint8_t *ops, "
        "const uint16_t *opcodes, const double *numbers, uint32_t step_count, "
        "const uint16_t *queries, uint32_t query_count, uint8_t *output). "
        "Ops: 1 add opcode from opcodes[i], 2 add double from numbers[i], 3 clear, "
        "4 finalize, 5 copy current array to a fresh array with the same behavior. "
        "Write (step_count+1) consecutive snapshot rows to output, including the "
        "initial empty state. Each row has 4+query_count bytes: nonempty, "
        "has_references, has_external_ref, has_name, then has_opcode for each "
        "queries[j]. Values are 0 or 1. Return 0 on success. "
    )
    prompt = (
        "Implement the public native subsystem specification below in portable C11. " +
        interface_contract +
        "The public examples are normative: infer bit "
        "numbering and parameter order from their inputs and outputs. Check your rules "
        "against every public example before returning code. Use functional rules, "
        "not C++ object layout, vtables, dynamic loading, "
        "a table of example inputs, or external program calls. Return one C translation "
        "unit only.\nPublic spec: " +
        json.dumps(spec, sort_keys=True))
    resolved_model = get_model("engine_writer", explicit=args.model)
    if args.max_revisions < 0 or args.max_revisions > 8:
        raise ValueError("max revisions must be between zero and eight")
    with TemporaryDirectory(prefix="splice-c-candidate-") as temporary:
        folder = Path(temporary)
        source_path = folder / "candidate.c"
        library_path = folder / "candidate.so"
        engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
        runner = NativeProbeRunner(
            engine, Path(__file__).with_name(
                "c_scalar_candidate_adapter.py" if args.interface == "scalar" else
                "c_token_array_candidate_adapter.py"))
        attempts = []
        for revision in range(args.max_revisions + 1):
            reply = invoke_opencode(
                args.opencode, folder, prompt, model=resolved_model, timeout=180,
                env_file=Path(__file__).resolve().parents[1] / ".env",
                agent_name="native-c-implementer",
                agent_instruction="Return C code from the public spec only. Use no tools.")
            source = extract_c(reply["text"])
            source_artifact = store.put(source.encode())
            prompt_artifact = store.put(prompt.encode())
            source_path.write_text(source)
            built = subprocess.run(["cc", "-std=c11", "-O2", "-fPIC", "-shared",
                                    "-Wall", "-Wextra", "-o", str(library_path),
                                    str(source_path)], capture_output=True, text=True,
                                   timeout=30, check=False)
            failures = []
            if built.returncode:
                failures = [{"compiler_error": built.stderr[-2000:]}]
            else:
                for example in spec.get("examples", []):
                    if example.get("observation_kind") != "shared":
                        continue
                    check = runner.run_case(library_path, {
                        "id": example["name"], "kind": "shared",
                        "input": example["input"],
                        "expected": example["expected_output"]},
                        execution_mode="candidate")
                    if check["outcome"] != "agreement":
                        failures.append({"input": example["input"],
                                         "expected": example["expected_output"],
                                         "observed": check["observed"],
                                         "error": check["error"]})
            attempts.append({"prompt_artifact": prompt_artifact,
                             "source_artifact": source_artifact,
                             "public_failures": len(failures)})
            if not failures:
                break
            if revision == args.max_revisions:
                raise RuntimeError("candidate did not satisfy public examples: " +
                                   json.dumps({"attempts": attempts,
                                               "failures": failures[:5]}))
            prompt = ("Revise this C11 implementation using only the public spec and "
                      "its public examples. Return the complete corrected C translation "
                      "unit.\nPublic spec: " + json.dumps(spec, sort_keys=True) +
                      "\nPrevious C source:\n" + source +
                      "\nFailed public checks:\n" + json.dumps(failures[:20]))
        results = []
        for item in held_out:
            original = {**json.loads(store.get(item["artifact"])),
                        "artifact": item["artifact"]}
            results.append(runner.compare_case(library_path, original))
        counts = {outcome: sum(row["outcome"] == outcome for row in results)
                  for outcome in sorted({row["outcome"] for row in results})}
        record = {"schema": 1, "spec_artifact": args.spec_artifact,
                  "probe_report_artifact": args.probe_report_artifact,
                  "interface": args.interface,
                  "prompt_artifact": prompt_artifact,
                  "source_artifact": source_artifact,
                  "attempts": attempts,
                  "model": resolved_model, "cases": len(results), "counts": counts,
                  "result_artifacts": [row["artifact"] for row in results],
                  "complete": bool(results) and counts == {"agreement": len(results)}}
        record["artifact"] = store.put(json.dumps(record, sort_keys=True).encode())
        print(json.dumps({key: value for key, value in record.items()
                          if key != "result_artifacts"}, indent=2))
        if not record["complete"]:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
