"""Controlled original-execution probes with immutable inputs and outcomes."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import tempfile
import time

from engine.analysis.ghidra import GhidraAnalysis, file_hash


def _limits() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (5, 6))
    resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))


class NativeProbeRunner:
    def __init__(self, engine: GhidraAnalysis, adapter: Path, *, timeout: int = 8):
        self.engine = engine
        self.adapter = Path(adapter).resolve(strict=True)
        self.timeout = timeout

    def run_case(self, binary: Path, case: dict, *, execution_mode: str = "original",
                 oracle_artifact: str | None = None) -> dict:
        if execution_mode not in {"original", "candidate"}:
            raise ValueError("unknown execution mode")
        binary = Path(binary).resolve(strict=True)
        if case["kind"] == "shared":
            command = [sys.executable, str(self.adapter), str(binary)]
            payload = json.dumps(case["input"], sort_keys=True)
        elif case["kind"] == "executable":
            command = [str(binary), *case.get("args", [])]
            payload = None
        else:
            raise ValueError(f"unknown probe kind {case['kind']}")
        identity = {"schema": 1, "case_id": case["id"], "kind": case["kind"],
                    "target": case.get("target"),
                    **({"targets": case["targets"]} if "targets" in case else {}),
                    "binary_sha256": file_hash(binary),
                    "runner_sha256": file_hash(Path(__file__)),
                    "adapter_sha256": file_hash(self.adapter) if case["kind"] == "shared" else None,
                    "input": case.get("input", case.get("args")),
                    "input_description": case.get("input_description"),
                    "expected": case.get("expected"), "timeout_seconds": self.timeout,
                    "oracle_artifact": oracle_artifact,
                    "environment": {"LANG": "C", "LC_ALL": "C",
                                    "cpu_seconds": 5, "address_space_bytes": 512 * 1024 * 1024}}
        probe_key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        progress_id = "probe:" + identity["binary_sha256"]
        self.engine._emit(progress_id, "probe_started", case_id=case["id"],
                          probe_key=probe_key)
        started = time.monotonic()
        try:
            with tempfile.TemporaryDirectory(prefix="decomp-probe-") as cwd:
                completed = subprocess.run(command, input=payload, capture_output=True,
                                           text=True, cwd=cwd, timeout=self.timeout,
                                           env={"PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                                                "LANG": "C", "LC_ALL": "C"},
                                           preexec_fn=_limits, check=False)
            if case["kind"] == "shared":
                observed = json.loads(completed.stdout)
                if completed.returncode:
                    raise RuntimeError(f"probe adapter exited {completed.returncode}: "
                                       f"{completed.stderr[-400:]}")
            else:
                observed = {"stdout": completed.stdout.strip(),
                            "exit_code": completed.returncode}
            outcome = ("observed" if "expected" not in case else
                       "agreement" if observed == case["expected"] else "disagreement")
            error = None
        except (subprocess.TimeoutExpired, OSError, ValueError, RuntimeError) as exc:
            observed = None
            outcome = "execution_error"
            error = str(exc)
        record = {**identity, "observed": observed, "outcome": outcome,
                  "error": error, "elapsed_seconds": round(time.monotonic() - started, 3),
                  "execution_mode": execution_mode}
        artifact = self.engine.store.put(json.dumps(record, sort_keys=True).encode())
        self.engine._emit(progress_id, "probe_finished", case_id=case["id"],
                          probe_key=probe_key,
                          outcome=outcome, artifact=artifact)
        return {**record, "artifact": artifact}

    def compare_case(self, candidate_binary: Path, original_case: dict) -> dict:
        """Run a candidate through this runner's adapter against a real oracle record."""
        original_artifact = original_case.get("artifact")
        if not isinstance(original_artifact, str):
            raise ValueError("original case needs an immutable artifact")
        stored = json.loads(self.engine.store.get(original_artifact))
        if stored != {key: value for key, value in original_case.items()
                      if key != "artifact"}:
            raise ValueError("original case differs from its stored artifact")
        if (original_case.get("execution_mode") != "original" or
                original_case.get("outcome") not in {"observed", "agreement"} or
                original_case.get("observed") is None):
            raise ValueError("comparison requires a successful original observation")
        case = {"id": original_case["case_id"], "kind": original_case["kind"],
                "target": original_case.get("target"),
                "expected": original_case["observed"]}
        if case["kind"] == "shared":
            case["input"] = original_case["input"]
        else:
            case["args"] = original_case["input"]
        return self.run_case(candidate_binary, case, execution_mode="candidate",
                             oracle_artifact=original_artifact)

    def run_suite(self, builds_manifest: Path, cases_file: Path) -> dict:
        builds = json.loads(Path(builds_manifest).read_text())["builds"]
        suite = json.loads(Path(cases_file).read_text())
        if suite.get("schema") != 1:
            raise ValueError("unknown probe suite schema")
        results = []
        for build in builds:
            binary = Path(build["analysis_path"])
            if file_hash(binary) != build["analysis_sha256"]:
                raise ValueError(f"fixture changed: {binary}")
            for case in suite["cases"]:
                if case["kind"] == build["kind"]:
                    results.append({"build": {"kind": build["kind"],
                                               "optimization": build["optimization"]},
                                    **self.run_case(binary, case)})
        counts = {outcome: sum(item["outcome"] == outcome for item in results)
                  for outcome in sorted({item["outcome"] for item in results})}
        report = {"schema": 1, "suite_sha256": file_hash(Path(cases_file)),
                  "results": results, "counts": counts,
                  "complete": len(results) > 0 and
                  counts.get("agreement", 0) + counts.get("observed", 0) == len(results)}
        artifact = self.engine.store.put(json.dumps(report, sort_keys=True).encode())
        return {**report, "artifact": artifact}


def select_original_cases(store, report: dict, binary_sha256: str,
                          target: str | None) -> list[dict]:
    """Load matching immutable original observations for a function."""
    if (report.get("schema") != 1 or not isinstance(report.get("results"), list) or
            not target):
        return []
    selected = []
    for item in report["results"]:
        if ((item.get("target") != target and
             target not in item.get("targets", [])) or
                item.get("binary_sha256") != binary_sha256 or
                item.get("execution_mode") != "original"):
            continue
        if item.get("outcome") not in {"agreement", "observed"}:
            return []
        try:
            original = json.loads(store.get(item["artifact"]))
        except (ValueError, KeyError, TypeError, FileNotFoundError):
            return []
        if any(original.get(key) != item.get(key) for key in
               ("case_id", "target", "targets", "binary_sha256", "input", "observed",
                "outcome", "execution_mode", "runner_sha256", "adapter_sha256")):
            return []
        selected.append({"case_id": item["case_id"], "input": item["input"],
                         "observed": item["observed"], "artifact": item["artifact"]})
    return selected
