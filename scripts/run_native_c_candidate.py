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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--spec-artifact", required=True)
    parser.add_argument("--probe-report-artifact", required=True)
    parser.add_argument("--model")
    parser.add_argument("--opencode", type=Path,
                        default=Path.home() / ".opencode/bin/opencode")
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    args = parser.parse_args()
    store = LocalArtifactStore(args.state / "artifacts")
    spec = json.loads(store.get(args.spec_artifact))
    if spec.get("schema") != 2 or spec.get("status") != "ready_for_review":
        raise ValueError("C generation requires a ready native spec")
    report = json.loads(store.get(args.probe_report_artifact))
    if report.get("schema") != 1 or not isinstance(report.get("results"), list):
        raise ValueError("invalid original probe report")
    public_examples = {json.dumps(item["input"], sort_keys=True)
                       for item in spec.get("examples", [])}
    held_out = [item for item in report["results"]
                if item.get("outcome") in {"observed", "agreement"} and
                json.dumps(item.get("input"), sort_keys=True) not in public_examples]
    if not held_out:
        raise ValueError("no held-out original cases outside public spec examples")
    symbols = sorted({item["input"]["symbol"] for item in held_out
                      if item.get("kind") == "shared" and
                      isinstance(item.get("input"), dict) and
                      isinstance(item["input"].get("symbol"), str)})
    if not symbols:
        raise ValueError("no scalar C exports to implement")
    prompt = (
        "Implement the public native subsystem specification below in portable C11. "
        "Export plain C functions with the listed names. Parameters are unsigned 32-bit "
        "integers except boolean inputs, which are _Bool; returns are unsigned 32-bit "
        "integers. Use functional rules, not C++ object layout, vtables, dynamic loading, "
        "a table of example inputs, or external program calls. Return one C translation "
        "unit only. Export names: " + json.dumps(symbols) + "\nPublic spec: " +
        json.dumps(spec, sort_keys=True))
    resolved_model = get_model("engine_writer", explicit=args.model)
    with TemporaryDirectory(prefix="splice-c-candidate-") as temporary:
        folder = Path(temporary)
        reply = invoke_opencode(
            args.opencode, folder, prompt, model=resolved_model, timeout=180,
            env_file=Path(__file__).resolve().parents[1] / ".env",
            agent_name="native-c-implementer",
            agent_instruction="Return C code from the public spec only. Use no tools.")
        source = extract_c(reply["text"])
        source_artifact = store.put(source.encode())
        prompt_artifact = store.put(prompt.encode())
        source_path = folder / "candidate.c"
        library_path = folder / "candidate.so"
        source_path.write_text(source)
        built = subprocess.run(["cc", "-std=c11", "-O2", "-fPIC", "-shared",
                                "-Wall", "-Wextra", "-o", str(library_path),
                                str(source_path)], capture_output=True, text=True,
                               timeout=30, check=False)
        if built.returncode:
            raise RuntimeError("generated C failed compilation: " + built.stderr[-2000:])
        engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
        runner = NativeProbeRunner(
            engine, Path(__file__).with_name("c_scalar_candidate_adapter.py"))
        results = []
        for item in held_out:
            original = {**json.loads(store.get(item["artifact"])),
                        "artifact": item["artifact"]}
            results.append(runner.compare_case(library_path, original))
        counts = {outcome: sum(row["outcome"] == outcome for row in results)
                  for outcome in sorted({row["outcome"] for row in results})}
        record = {"schema": 1, "spec_artifact": args.spec_artifact,
                  "probe_report_artifact": args.probe_report_artifact,
                  "prompt_artifact": prompt_artifact,
                  "source_artifact": source_artifact,
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
