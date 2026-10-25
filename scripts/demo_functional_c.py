"""Demonstrate a generated C implementation against the original observations.

Runs a candidate library and the recorded original outcomes side by side, so a
demo shows the generated code's behaviour per step rather than a pass count. With
``--source-artifact`` the candidate is compiled from a stored model reply, which
keeps a demo reproducible from artifacts alone.

Exits non-zero when the candidate disagrees with any public case, so the same
script can gate a hand-off.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore
from engine.validation.probes import NativeProbeRunner
from scripts.run_functional_c_e2e import _cases
from scripts.run_native_c_candidate import extract_c


def _row(snapshot: dict, queries: list[int]) -> str:
    flags = "".join("1" if snapshot[key] else "0"
                    for key in ("nonempty", "has_references", "has_external_ref", "has_name"))
    present = "".join(str(int(value)) for value in snapshot["has_opcode"])
    return f"{flags} | {present}"


def _describe_mismatch(case: dict, observed: dict | None) -> list[str]:
    expected = case["observed"]["snapshots"]
    got = (observed or {}).get("snapshots") or []
    findings = []
    for index, before in enumerate(expected):
        after = got[index] if index < len(got) else None
        if after == before:
            continue
        if after is None:
            findings.append(f"case {case['case_id']} row {index}: candidate produced no row")
            continue
        for key in ("nonempty", "has_references", "has_external_ref", "has_name"):
            if before[key] != after[key]:
                findings.append(f"case {case['case_id']} row {index}: {key} is "
                                f"{int(before[key])} in the original and "
                                f"{int(after[key])} in the candidate")
        for query, want, have in zip(case["input"]["queries"], before["has_opcode"],
                                     after["has_opcode"]):
            if want != have:
                findings.append(f"case {case['case_id']} row {index}: opcode {query} is "
                                f"{int(want)} in the original and {int(have)} in the candidate")
    return findings[:6]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--public-report-artifact", required=True)
    parser.add_argument("--full-report-artifact", required=True)
    parser.add_argument("--adapter", type=Path,
                        default=Path(__file__).with_name("c_token_array_candidate_adapter.py"))
    parser.add_argument("--candidate", type=Path, help="built candidate library")
    parser.add_argument("--source-artifact", help="stored model reply to compile instead")
    parser.add_argument("--trace", help="case id to print row by row")
    parser.add_argument("--limit", type=int, default=0, help="only the first N public cases")
    args = parser.parse_args()
    if bool(args.candidate) == bool(args.source_artifact):
        parser.error("give exactly one of --candidate or --source-artifact")

    store = LocalArtifactStore(args.state / "artifacts")
    public = _cases(store, args.public_report_artifact)
    full = _cases(store, args.full_report_artifact)
    public_ids = {row["artifact"] for row in public}
    hidden = [row for row in full if row["artifact"] not in public_ids]
    if args.limit:
        public = public[:args.limit]

    folder = Path(tempfile.mkdtemp(prefix="splice-demo-"))
    if args.source_artifact:
        source = extract_c(store.get(args.source_artifact).decode())
        (folder / "candidate.c").write_text(source)
        library = folder / "candidate.so"
        built = subprocess.run(["cc", "-std=c11", "-O2", "-fPIC", "-shared",
                                "-o", str(library), str(folder / "candidate.c")],
                               capture_output=True, text=True)
        if built.returncode:
            raise SystemExit("candidate does not compile:\n" + built.stderr[:2000])
    else:
        library = args.candidate.resolve(strict=True)

    engine = GhidraAnalysis(args.state, Path("/opt/ghidra/support/analyzeHeadless"),
                            warm_workers=0)
    runner = NativeProbeRunner(engine, args.adapter)

    def difference(case: dict) -> dict | None:
        result = runner.run_case(library, {"id": case["case_id"], "kind": "shared",
                                           "target": case["target"], "input": case["input"]},
                                 execution_mode="candidate")
        if result.get("observed") == case["observed"]:
            return None
        return {"case": case["case_id"], "findings": _describe_mismatch(case, result.get("observed")),
                "error": result.get("error")}

    disagreements = [item for item in (difference(case) for case in public) if item]
    if args.trace:
        case = next((row for row in [*public, *hidden] if row["case_id"] == args.trace), None)
        if case is None:
            raise SystemExit(f"no case {args.trace}")
        result = runner.run_case(library, {"id": case["case_id"], "kind": "shared",
                                           "target": case["target"], "input": case["input"]},
                                 execution_mode="candidate")
        got = (result.get("observed") or {}).get("snapshots") or []
        queries = case["input"]["queries"]
        print(f"case {case['case_id']} queries {queries}")
        print(f"{'step':>5} {'operation':<28} {'original':<24} {'candidate':<24} match")
        for index, snapshot in enumerate(case["observed"]["snapshots"]):
            operation = ("(initial state)" if index == 0 else
                         json.dumps(case["input"]["steps"][index - 1], sort_keys=True))
            candidate = got[index] if index < len(got) else None
            print(f"{index:>5} {operation:<28} {_row(snapshot, queries):<24} "
                  f"{_row(candidate, queries) if candidate else '(missing)':<24} "
                  f"{'yes' if candidate == snapshot else 'NO'}")

    held_out = [item for item in (difference(case) for case in hidden) if item]
    print(json.dumps({"public_cases": len(public),
                      "public_agreement": len(public) - len(disagreements),
                      "held_out_cases": len(hidden),
                      "held_out_agreement": len(hidden) - len(held_out),
                      "disagreements": disagreements[:8]}, indent=2))
    raise SystemExit(1 if disagreements else 0)


if __name__ == "__main__":
    main()
