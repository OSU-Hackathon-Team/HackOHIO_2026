"""Implement a command-line subsystem from its public spec and verify it on held-out cases.

The analysis fleet observes an original program through its own command line and publishes
a public native spec plus unlabelled original observations. This driver gives an
independent implementer that public package only: the declared program interface, the
spec, and the public observations. The implementer writes a complete C program, the driver
compiles and runs it against the public cases, and held-out original cases are executed
exactly once after the last revision, whatever the public set shows: a candidate that still
fails a public example is a result to measure, not a reason to hide the acceptance set.

Held-out inputs never enter a prompt and are never fed back. A passing public set is not
equivalence; the result records the public gate, and what the held-out campaign observed.

With --workbench the implementer is an agent in a public-only container instead of one
answer per revision: it gets bash, a compiler and a harness that builds candidate.c into a
program and runs the public cases. Its own exit is not the gate -- the host rebuilds the
candidate it left behind and reruns the public set before the single held-out pass.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.cli_target import cli_matches  # noqa: E402
from engine.model_runtime import (CONVERSE_MAX_TOKENS, effective_aws_env,  # noqa: E402
                                 invoke_opencode)
from engine.workbench import (build_image, build_prompt,  # noqa: E402
                             materialize_workspace, run_workbench)
from model_config import get_model  # noqa: E402
from scripts.run_native_c_candidate import extract_c  # noqa: E402

INTERFACE_CONTRACT = (
    "Deliverable: one C source file, built and run as\n"
    "    cc -std=gnu11 -O2 -o program source.c -lm\n"
    "    PROGRAM -q <script-file>\n"
    "It must read a program script from <script-file>, evaluate it, and write results to\n"
    "standard output exactly as the original program does. Standard error is compared too,\n"
    "and the exit status must match. The C library is the full POSIX one, so functions\n"
    "such as strdup, strndup and snprintf are available. Arguments other than -q and the\n"
    "script path need not be supported. Read nothing else from the file system and invoke\n"
    "no other program.\n"
)


def _report(store: LocalArtifactStore, artifact: str) -> dict:
    report = json.loads(store.get(artifact))
    if report.get("schema") != 1 or not isinstance(report.get("results"), list):
        raise ValueError("invalid original probe report")
    return report


def _report_binary(report: dict) -> str:
    hashes = {row.get("binary_sha256") for row in report["results"]}
    if len(hashes) != 1 or None in hashes:
        raise ValueError("probe report does not identify exactly one original binary")
    return hashes.pop()


def _load_cases(report: dict, binary_sha256: str, store: LocalArtifactStore) -> list[dict]:
    cases = []
    for row in report["results"]:
        if (row.get("execution_mode") != "original" or
                row.get("outcome") not in {"observed", "agreement"} or
                row.get("observed") is None or row.get("binary_sha256") != binary_sha256):
            continue
        stored = json.loads(store.get(row["artifact"]))
        if stored != {key: value for key, value in row.items() if key != "artifact"}:
            raise ValueError("probe report differs from its immutable case record")
        cases.append(row)
    return cases


def _script_text(case: dict) -> str | None:
    """The program text a case fed the original, read back from its immutable copy.

    The recorded input carries the program text itself; a case that only names a file falls
    back to the script argument when that file still exists.
    """
    recorded = (case.get("input") or {}).get("program_text")
    if isinstance(recorded, str) and recorded:
        return recorded
    for argument in reversed((case.get("input") or {}).get("args") or []):
        path = Path(str(argument))
        if path.is_file():
            return path.read_text()
    return None


def _examples(cases: list[dict]) -> list[dict]:
    examples = []
    for case in cases:
        text = _script_text(case)
        if text is None:
            raise ValueError(f"case {case['case_id']} has no readable program text")
        examples.append({"case_id": case["case_id"],
                         "program_text": text,
                         "expected_output": case["observed"]})
    return examples


def _spec_package(spec: dict, examples: list[dict], contract: str) -> dict:
    return {"interface": contract, "spec": spec, "public_examples": examples}


def _write_script(folder: Path, case: dict, text: str) -> Path:
    digest = hashlib.sha256(text.encode()).hexdigest()[:16]
    path = folder / f"{case['case_id'].replace('/', '_')}-{digest}.bc"
    path.write_text(text)
    return path


def _invocation(case: dict, script: Path) -> list[str]:
    """The candidate's argument list: the declared invocation, with the script file in place.

    Recorded inputs name the script through the suite's placeholder, so the driver supplies the
    file it just wrote instead of depending on a path that happens to exist in the state.
    """
    declared = list((case.get("input") or {}).get("args") or [])
    if not declared:
        return [str(script)]
    return [str(script) if str(argument) == "{script}" or Path(str(argument)).is_file()
            else argument for argument in declared]


def _run_candidate(program: Path, case: dict, script: Path, timeout: int = 15) -> dict:
    try:
        # A broken candidate can emit arbitrary bytes: decode leniently and record the
        # mismatch instead of failing the whole driver on the way to comparing output.
        done = subprocess.run([str(program), *_invocation(case, script)], capture_output=True,
                              stdin=subprocess.DEVNULL, timeout=timeout,
                              env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/bin:/bin"})
    except subprocess.TimeoutExpired:
        return {"stdout": "", "stderr": "", "exit_code": None,
                "error": f"timed out after {timeout} s"}
    def text(data: bytes) -> str:
        return data.decode("utf-8", errors="replace")
    return {"stdout": text(done.stdout), "stderr": text(done.stderr),
            "exit_code": done.returncode}


def _check(program: Path, cases: list[dict], folder: Path, timeout: int = 15) -> list[dict]:
    failures = []
    for case in cases:
        text = _script_text(case)
        script = _write_script(folder, case, text)
        observed = _run_candidate(program, case, script, timeout=timeout)
        if not cli_matches(case["observed"], observed):
            failures.append({"case_id": case["case_id"], "program_text": text,
                             "expected_output": case["observed"], "observed": observed})
    return failures


def _spec_prompt(package: dict, note: str = "") -> str:
    example_count = len(package["public_examples"])
    return (
        "Implement the original command-line program's observable behavior in portable C11.\n"
        "The specification below was recovered from the original binary by an analysis\n"
        "fleet; treat it as guidance and the observations as normative. Every public\n"
        "observation was produced by the original program and must be reproduced exactly:\n"
        "same standard output, same standard error, same exit status. Where the spec and an\n"
        "observation disagree, the observation wins.\n"
        "Derive the general rules (numeric representation, operator semantics, state,\n"
        "input/output base handling, builtins) instead of encoding the examples; an\n"
        "independent held-out set of original cases judges the result.\n"
        "Return one complete C11 translation unit, no prose, no build files.\n"
        f"{package['interface']}"
        f"There are {example_count} public observations.\n"
        + (note + "\n" if note else "") +
        "Public package: " + json.dumps(package, sort_keys=True)
    )


def _revision_prompt(package: dict, best_source: str | None, failures: list[dict],
                     note: str = "") -> str:
    return (
        _spec_prompt(package, note=note) +
        "\nA previous implementation failed these public observations. Return the complete\n"
        "corrected translation unit; every listed mismatch must be explained by the rules\n"
        "you implement, not special-cased.\n"
        "Best implementation so far:\n" + (best_source or "(none)") +
        "\nReported mismatches: " + json.dumps(
            [{key: value for key, value in failure.items() if key != "program_text"}
             for failure in failures[:10]], sort_keys=True) +
        "\nTheir program texts: " + json.dumps(
            [{"case_id": failure["case_id"], "program_text": failure["program_text"]}
             for failure in failures[:10]], sort_keys=True)
    )


def _compile(source: str, folder: Path) -> tuple[Path | None, str | None]:
    """Build the candidate exactly as the declared interface says it is built."""
    source_path = folder / "candidate.c"
    program = folder / "candidate"
    source_path.write_text(source)
    built = subprocess.run(["cc", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-o", str(program),
                            str(source_path), "-lm"],
                           capture_output=True, text=True, timeout=120, check=False)
    if built.returncode:
        return None, built.stderr[-4000:]
    return program, None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--spec-artifact", required=True)
    parser.add_argument("--public-report-artifact", required=True)
    parser.add_argument("--full-report-artifact", required=True)
    parser.add_argument("--model")
    parser.add_argument("--opencode", type=Path,
                        default=Path(os.environ.get("OPENCODE_BIN", "/run/opencode-bin")))
    parser.add_argument("--max-tokens", type=int, default=CONVERSE_MAX_TOKENS,
                        help="output budget for one implementation answer")
    parser.add_argument("--max-revisions", type=int, default=6)
    parser.add_argument("--plateau-attempts", type=int, default=2)
    parser.add_argument("--max-spec-revisions", type=int, default=1)
    parser.add_argument("--case-timeout", type=int, default=15)
    parser.add_argument("--workbench", action="store_true",
                        help="run the implementer in a public-only container with bash, a "
                             "compiler and its own public test harness")
    parser.add_argument("--workbench-image", default="splice-cleanroom-implementer:local")
    parser.add_argument("--workbench-runtime", default="podman")
    parser.add_argument("--workbench-timeout", type=int, default=1800)
    parser.add_argument("--workbench-network", default=None)
    parser.add_argument("--build-workbench-image", action="store_true")
    parser.add_argument("--restart", action="store_true")
    parser.add_argument("--allow-draft", action="store_true",
                        help="implement a draft spec; the run is then explicitly not an "
                             "approved implementation contract")
    args = parser.parse_args()
    state = args.state.resolve()
    store = LocalArtifactStore(state / "artifacts")
    spec_document = json.loads(store.get(args.spec_artifact))
    if spec_document.get("schema") != 2:
        raise ValueError("the public package requires a schema 2 native spec")
    if args.workbench_timeout < 1:
        raise ValueError("workbench timeout must be positive")
    if args.workbench and not args.opencode.is_file():
        raise FileNotFoundError(f"OpenCode executable not found: {args.opencode}")
    if spec_document.get("status") != "ready_for_review" and not args.allow_draft:
        raise ValueError("only a review-ready native spec is an implementation contract; "
                         f"this spec is {spec_document.get('status')!r}")
    public_report = _report(store, args.public_report_artifact)
    full_report = _report(store, args.full_report_artifact)
    binary_sha256 = _report_binary(public_report)
    if _report_binary(full_report) != binary_sha256:
        raise ValueError("public and full reports describe different binaries")
    public = _load_cases(public_report, binary_sha256, store)
    full = _load_cases(full_report, binary_sha256, store)
    if not public:
        raise ValueError("no public original cases")
    public_ids = {row["artifact"] for row in public}
    held_out = [row for row in full if row["artifact"] not in public_ids]
    if not held_out:
        raise ValueError("no held-out original cases")
    overlap = {json.dumps(row["input"], sort_keys=True) for row in public} & {
        json.dumps(row["input"], sort_keys=True) for row in held_out}
    if overlap:
        raise ValueError("held-out inputs must be disjoint from public inputs")
    examples = _examples(public)
    package = _spec_package(spec_document, examples, INTERFACE_CONTRACT)
    package_sha = hashlib.sha256(json.dumps(package, sort_keys=True).encode()).hexdigest()
    run_key = hashlib.sha256(json.dumps(
        {"spec": args.spec_artifact, "public": args.public_report_artifact,
         "full": args.full_report_artifact, "package": package_sha,
         **({"workbench": True} if args.workbench else {})},
        sort_keys=True).encode()).hexdigest()
    run_folder = state / "runs" / "executable-c" / run_key
    run_folder.mkdir(parents=True, exist_ok=True)
    checkpoint_path = run_folder / "progress.json"
    if args.restart and checkpoint_path.exists():
        attempt = 1
        while checkpoint_path.with_name(f"progress.{attempt}.json").exists():
            attempt += 1
        os.replace(checkpoint_path, checkpoint_path.with_name(f"progress.{attempt}.json"))
    progress = (json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else
                {"schema": 1, "run_key": run_key, "revisions": []})
    if progress.get("run_key") != run_key:
        raise ValueError("checkpoint belongs to another run")

    def save() -> None:
        pending = checkpoint_path.with_suffix(".tmp")
        pending.write_text(json.dumps(progress, indent=2) + "\n")
        os.replace(pending, checkpoint_path)

    model = get_model("engine_writer", explicit=args.model)
    workbench_env: dict = {}
    if args.workbench:
        if args.build_workbench_image:
            build_image(runtime=args.workbench_runtime, image=args.workbench_image,
                        dockerfile=ROOT / "implementer.Dockerfile", context=ROOT)
        # The container reaches the model provider itself, so it needs the credentials this
        # host resolves, which may live in a shared credentials file rather than the
        # environment. Only these keys cross into the sandbox.
        workbench_env.update(effective_aws_env())
        workbench_env.pop("AWS_PROFILE", None)
        if not workbench_env.get("AWS_ACCESS_KEY_ID"):
            raise ValueError("workbench runs need AWS credentials for the agent's model")
    work = run_folder / "work"
    work.mkdir(exist_ok=True)
    note = ""
    spec_revisions = 0
    for revision in range(args.max_revisions + 1):
        turn = work / f"attempt-{revision + 1}"
        turn.mkdir(exist_ok=True)
        best_source = progress.get("best_source")
        best_text = store.get(best_source).decode() if best_source else None
        # A resumed run starts from its best candidate, not from the spec again: the recorded
        # failures are the useful context, and regenerating from scratch discards them.
        if revision == 0 and best_text is None:
            prompt = _spec_prompt(package)
        else:
            prompt = _revision_prompt(package, best_text, progress.get("last_failures", []),
                                      note=note)
        errors, reply_artifact = None, None
        workbench_record = None
        if args.workbench:
            # The agent gets the public package and a harness that builds its program and runs
            # the public cases. Its exit is not the gate: the host rebuilds candidate.c and
            # reruns the public set below, then measures held-out cases once.
            workspace = state / "cleanroom" / "executable-c" / run_key / \
                f"attempt-{revision + 1}"
            try:
                shutil.rmtree(workspace, ignore_errors=True)
                materialized = materialize_workspace(
                    workspace,
                    spec={"schema": 2, "interface": "executable", "spec": spec_document,
                          "public_examples": examples},
                    cases=[{"case_id": row["case_id"], "input": row["input"],
                            "observed": row["observed"]} for row in public],
                    contract=INTERFACE_CONTRACT,
                    candidate=best_text, broker_enabled=False, executable=True)
                prompt = prompt + "\n\n" + build_prompt(
                    contract=INTERFACE_CONTRACT, case_count=len(public),
                    broker_enabled=False, executable=True)
                (workspace / "prompt.txt").write_text(prompt)
                run = run_workbench(
                    workspace=workspace, image=args.workbench_image,
                    opencode=args.opencode, model=model,
                    timeout=args.workbench_timeout, runtime=args.workbench_runtime,
                    env=workbench_env, network=args.workbench_network,
                    private_markers=[args.spec_artifact, args.public_report_artifact,
                                     args.full_report_artifact, binary_sha256,
                                     str(state.resolve())],
                    immutable=materialized["files"], executable=True,
                    container_name=f"splice-executable-{run_key[:8]}-{revision + 1}")
                source = run["candidate_source"]
                if not run["immutable"]["ok"]:
                    source, errors = None, f"tampered harness: {run['immutable']}"
                elif source is None:
                    errors = (f"workbench {run['status']}: " +
                              (run.get("candidate_error") or "no candidate.c"))
                workbench_record = {key: run[key] for key in
                                    ("status", "exit_code", "timed_out", "immutable",
                                     "broker", "elapsed_seconds")}
            except Exception as error:
                source, errors = None, f"{type(error).__name__}: {error}"
                workbench_record = {"status": "error", "error": str(error)}
        else:
            try:
                # A whole program does not fit the evidence-only budget: ask for the ceiling.
                reply = invoke_opencode(
                    args.opencode, turn, prompt, model=model, timeout=900,
                    env_file=ROOT / ".env", agent_name="native-c-implementer",
                    agent_instruction="Return one complete C11 program. Use no tools.",
                    max_tokens=args.max_tokens)
                # The raw answer is kept for audit even when it yields no candidate.
                reply_artifact = store.put(reply["text"].encode())
                source = extract_c(reply["text"], executable=True)
            except Exception as error:  # a revision that will not compile is a recorded failure
                source, errors = None, f"{type(error).__name__}: {error}"
        prompt_artifact = store.put(prompt.encode())
        source_artifact = store.put(source.encode()) if source else None
        machinery, failures = None, []
        if source is not None:
            program, machinery = _compile(source, turn)
            if program is not None:
                failures = _check(program, public, turn, timeout=args.case_timeout)
        failures = ([{"case_id": None, "program_text": None,
                      "expected_output": None, "observed": {"error": errors or machinery}}]
                    if source is None or machinery else failures)
        record = {"revision": revision + 1, "model": model, "prompt_artifact": prompt_artifact,
                  "reply_artifact": reply_artifact, "workbench": workbench_record,
                  "source_artifact": source_artifact, "public_failures": len(failures),
                  "failures": [{key: value for key, value in failure.items()
                                if key != "program_text"} for failure in failures[:10]],
                  "compiler_error": machinery, "generation_error": errors}
        progress["revisions"].append(record)
        progress["last_failures"] = failures[:10]
        # A revision that does not build is worse than one that builds and mismatches cases.
        rank = [source is None or machinery is not None, len(failures)]
        best_rank = progress.get("best_rank")
        if source_artifact and (best_rank is None or rank < best_rank):
            progress["best_source"] = source_artifact
            progress["best_public_failures"] = len(failures)
            progress["best_failures"] = failures[:10]
            progress["best_rank"] = rank
        save()
        print(f"[revision {revision + 1}] public failures {len(failures)} "
              f"(best {progress.get('best_public_failures')})", flush=True)
        if not failures:
            break
        if revision == args.max_revisions:
            # Stop revising; the best candidate is measured against the held-out cases below.
            print(json.dumps({"complete": False, "reason": "revision budget spent",
                              "revisions": len(progress["revisions"]),
                              "best_public_failures": progress.get("best_public_failures"),
                              "failures": progress.get("best_failures", [])[:6]}, indent=2))
            break
        if (progress.get("stale", 0) + 1 >= args.plateau_attempts and
                spec_revisions < args.max_spec_revisions):
            progress["stale"] = 0
            spec_revisions += 1
            note = ("The previous attempts stopped improving. Re-read every public observation "
                    "and state the general rules (representation, operator semantics, state, "
                    "bases, builtins) so the failing cases follow from them, then implement those "
                    "rules. Keep the interface and return the complete program.")
        else:
            progress["stale"] = progress.get("stale", 0) + 1
        save()

    if progress.get("best_source") is None:
        raise SystemExit("no compilable candidate was produced")
    final = work / "final"
    final.mkdir(parents=True, exist_ok=True)
    program, machinery = _compile(store.get(progress["best_source"]).decode(), final)
    if program is None:
        raise SystemExit(f"best candidate no longer compiles: {machinery}")
    public_failures = _check(program, public, final, timeout=args.case_timeout)
    # Held-out cases judge the result and are never fed back, so they are executed once here
    # whether or not the public set was satisfied; a public failure is recorded, not hidden.
    if public_failures:
        print(f"[final] the public set is not satisfied: {len(public_failures)} of "
              f"{len(public)} examples fail; measuring held-out cases anyway", flush=True)
    held_results = []
    for case in held_out:
        text = _script_text(case)
        script = _write_script(final, case, text)
        observed = _run_candidate(program, case, script, timeout=args.case_timeout)
        agreement = cli_matches(case["observed"], observed)
        held_results.append({"case_id": case["case_id"], "input": case["input"],
                             "program_text": text, "expected_output": case["observed"],
                             "observed": observed, "outcome": "agreement" if agreement
                             else "disagreement"})
    counts = {outcome: sum(row["outcome"] == outcome for row in held_results)
              for outcome in sorted({row["outcome"] for row in held_results})}
    result = {"schema": 1, "run_key": run_key, "spec_artifact": args.spec_artifact,
              "spec_status": spec_document.get("status"),
              "workbench": bool(args.workbench),
              "public_gate_met": not public_failures,
              "public_failures": [failure["case_id"] for failure in public_failures],
              "public_report_artifact": args.public_report_artifact,
              "full_report_artifact": args.full_report_artifact,
              "package_sha256": package_sha, "model": model,
              "source_artifact": progress["best_source"],
              "public_cases": len(public), "revisions": len(progress["revisions"]),
              "held_out_cases": len(held_results), "counts": counts,
              "held_out_results": held_results,
              "equivalent_on_held_out": bool(held_results) and
              counts == {"agreement": len(held_results)}}
    result["artifact"] = store.put(json.dumps(result, sort_keys=True).encode())
    progress["result_artifact"] = result["artifact"]
    progress["equivalent_on_held_out"] = result["equivalent_on_held_out"]
    save()
    print(json.dumps({key: value for key, value in result.items()
                      if key != "held_out_results"}, indent=2))
    if not result["equivalent_on_held_out"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
