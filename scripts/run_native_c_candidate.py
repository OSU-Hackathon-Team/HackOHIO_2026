"""Generate C from a ready public spec and compare against held-out original cases."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.broker import Broker, model_responder
from engine.model_runtime import add_aws_env, invoke_opencode
from engine.validation.probes import NativeProbeRunner
from engine.workbench import (build_image, build_prompt, materialize_workspace,
                              run_workbench, validate_candidate_source)
from model_config import get_model


def extract_c(text: str, *, executable: bool = False) -> str:
    """The C translation unit in a model answer.

    executable=True for a candidate that is built into its own program: it reads the input
    file it is given and writes its own stdout, so file I/O is its interface rather than an
    escape. Both forms refuse to start another program.
    """
    match = re.search(r"```(?:c)?\s*\n(.*?)\n```", text, re.S | re.I)
    source = match.group(1) if match else text.strip()
    if not source.startswith("#include") and not source.startswith("/*"):
        raise ValueError("model did not return a C translation unit")
    if re.search(r"\b(?:dlopen|dlsym|system|popen|execve|fork)\s*\(", source):
        raise ValueError("candidate tries to invoke an external implementation")
    return validate_candidate_source(source, executable=executable)


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
    parser.add_argument("--workbench", action="store_true",
                        help="run the implementer in a public-only container with bash and self-tests")
    parser.add_argument("--workbench-image", default="splice-cleanroom-implementer:local")
    parser.add_argument("--workbench-runtime", default="podman")
    parser.add_argument("--workbench-timeout", type=int, default=900)
    parser.add_argument("--workbench-network", default=None)
    parser.add_argument("--build-workbench-image", action="store_true")
    parser.add_argument("--broker-model")
    parser.add_argument("--broker-quota", type=int, default=48)
    parser.add_argument("--auth-file", type=Path,
                        default=Path.home() / ".local/share/opencode/auth.json")
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
    if args.workbench_timeout < 1 or args.broker_quota < 0:
        raise ValueError("workbench timeout must be positive and broker quota nonnegative")
    if args.workbench and not args.opencode.is_file():
        raise FileNotFoundError(f"OpenCode executable not found: {args.opencode}")
    shared_examples = [example for example in spec.get("examples", [])
                       if example.get("observation_kind") == "shared"]
    public_cases = [{"case_id": example["name"], "input": example["input"],
                     "observed": example["expected_output"]}
                    for example in shared_examples]
    if args.workbench and not public_cases:
        raise ValueError("workbench needs public shared-library examples")
    broker = None
    workbench_env = {key: os.environ[key] for key in
                     ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                      "AWS_REGION", "AWS_DEFAULT_REGION") if key in os.environ}
    if args.workbench and not workbench_env.get("AWS_ACCESS_KEY_ID"):
        add_aws_env(workbench_env, ROOT / ".env")
    workbench_env.pop("AWS_PROFILE", None)
    if args.workbench:
        if args.build_workbench_image:
            build_image(runtime=args.workbench_runtime, image=args.workbench_image,
                        dockerfile=ROOT / "implementer.Dockerfile", context=ROOT)
        broker_folder = args.state / "cleanroom" / args.spec_artifact[:16] / "broker"
        broker_folder.mkdir(parents=True, exist_ok=True)
        private = {"claims": dossier.get("claims", []),
                   "dependency_contracts": dossier.get("dependency_contracts", []),
                   "pseudocode": dossier.get("pseudocode")}
        responder = model_responder(
            opencode=args.opencode, env_file=ROOT / ".env",
            model=get_model("cleanroom_broker", explicit=args.broker_model),
            folder=broker_folder, timeout=args.workbench_timeout)
        broker = Broker(
            responder,
            public_context=json.dumps({"spec": spec, "examples": shared_examples},
                                      sort_keys=True),
            private_context=json.dumps(private, sort_keys=True)[:120000],
            protected_texts=[str(dossier.get("pseudocode") or "")],
            quota=args.broker_quota, store=store, session_id=args.spec_artifact[:12],
            allowed_calls={*symbols, "token_array_run"})
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
        previous_source = None
        for revision in range(args.max_revisions + 1):
            prompt_text = prompt
            workbench_record = None
            if args.workbench:
                workspace = (args.state / "cleanroom" / args.spec_artifact[:16] /
                             f"attempt-{revision + 1}")
                try:
                    shutil.rmtree(workspace, ignore_errors=True)
                    materialized = materialize_workspace(
                        workspace, spec=spec, cases=public_cases,
                        contract=interface_contract,
                        adapter=Path(__file__).with_name(
                            "c_scalar_candidate_adapter.py" if args.interface == "scalar"
                            else "c_token_array_candidate_adapter.py"),
                        broker_client=ROOT / "scripts" / "cleanroom_broker_client.py",
                        candidate=previous_source)
                    prompt_text = prompt + "\n\n" + build_prompt(
                        contract=interface_contract, case_count=len(public_cases))
                    (workspace / "prompt.txt").write_text(prompt_text)
                    run = run_workbench(
                        workspace=workspace, broker=broker,
                        image=args.workbench_image, opencode=args.opencode,
                        model=resolved_model, auth_file=args.auth_file,
                        timeout=args.workbench_timeout,
                        runtime=args.workbench_runtime, env=workbench_env,
                        network=args.workbench_network,
                        private_markers=[dossier.get("binary_sha256"), args.spec_artifact,
                                         args.probe_report_artifact,
                                         str(args.state.resolve())],
                        immutable=materialized["files"],
                        audit_path=workspace.parent / "broker-audit.jsonl",
                        container_name=f"splice-native-{args.spec_artifact[:8]}-{revision + 1}")
                    source = run["candidate_source"]
                    failures = ([] if source is None else None)
                    if not run["immutable"]["ok"]:
                        source = None
                        failures = [{"tampering": run["immutable"]}]
                    elif source is None:
                        failures = [{"generation_error":
                                    f"workbench {run['status']}: " +
                                    (run.get("candidate_error") or "no candidate.c")}]
                    workbench_record = {key: run[key] for key in
                                        ("status", "exit_code", "timed_out",
                                         "immutable", "broker", "elapsed_seconds")}
                except Exception as exc:
                    source = None
                    failures = [{"generation_error": str(exc)}]
                    workbench_record = {"status": "error", "error": str(exc)}
            else:
                try:
                    reply = invoke_opencode(
                        args.opencode, folder, prompt, model=resolved_model, timeout=180,
                        env_file=ROOT / ".env",
                        agent_name="native-c-implementer",
                        agent_instruction="Return C code from the public spec only. Use no tools.")
                    source = extract_c(reply["text"])
                    failures = None
                except Exception as exc:
                    source = None
                    failures = [{"generation_error": str(exc)}]
            source_artifact = store.put(source.encode()) if source else None
            prompt_artifact = store.put(prompt_text.encode())
            if source is not None:
                source_path.write_text(source)
                built = subprocess.run(["cc", "-std=c11", "-O2", "-fPIC", "-shared",
                                        "-Wall", "-Wextra", "-o", str(library_path),
                                        str(source_path)], capture_output=True, text=True,
                                       timeout=30, check=False)
                failures = []
                if built.returncode:
                    failures = [{"compiler_error": built.stderr[-2000:]}]
                else:
                    for example in shared_examples:
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
                previous_source = source
            attempts.append({"prompt_artifact": prompt_artifact,
                             "source_artifact": source_artifact,
                             "public_failures": len(failures or []),
                             "workbench": workbench_record})
            if not failures:
                break
            if revision == args.max_revisions:
                raise RuntimeError("candidate did not satisfy public examples: " +
                                   json.dumps({"attempts": attempts,
                                               "failures": (failures or [])[:5]}))
            prompt = ("Revise this C11 implementation using only the public spec and "
                      "its public examples. Return the complete corrected C translation "
                      "unit.\nPublic spec: " + json.dumps(spec, sort_keys=True) +
                      "\nPrevious C source:\n" + (previous_source or "") +
                      "\nFailed public checks:\n" + json.dumps((failures or [])[:20]))
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
