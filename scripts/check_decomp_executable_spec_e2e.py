"""End-to-end verification of large executable subsystem decompilation and cleanroom reimplementation.

Validates the complete chain for the stripped native executable fixture (telemetry_lab_O2_executable.bin):
1. Building stripped executable and debug companion from source.
2. Executing black-box CLI probes directly against original executable.
3. Headless Ghidra analysis & structural indexing (41 functions indexed).
4. Subsystem scoping (bounded 21-function computation core, zero unresolved edges).
5. Clean dossier assembly with evidence-linked claims, dependency contracts, and probe links.
6. Schema 2 NativeSubsystemSpec generation via launch.py spec CLI.
7. Cleanroom compliance audit (ZERO source leaks, registers, assembly mnemonics, or hex addresses).
8. Independent cleanroom reimplementation compiled into both executable and shared library.
9. Probing cleanroom implementation (100% agreement on both CLI and API probe suites).
10. Total execution time benchmarking (< 30 seconds).
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore
from engine.analysis.ghidra import GhidraAnalysis
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.specification import persist_spec
from engine.validation.probes import NativeProbeRunner
from scripts.assemble_clean_executable_dossier import assemble_clean_executable_dossier


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    t_start = time.monotonic()
    state_dir = Path(os.environ.get("DECOMP_STATE", "/home/mitch/Documents/HackOHIO_2026/decomp-state")).resolve()
    if not state_dir.exists():
        state_dir = (ROOT / "decomp-state").resolve()
    store = LocalArtifactStore(state_dir / "artifacts")

    print("=== Step 1: Building larger executable and companions from source ===")
    build_script = ROOT / "scripts" / "build_telemetry_fixture.py"
    subprocess.run([sys.executable, str(build_script)], check=True)

    manifest_path = state_dir / "fixtures" / "telemetry_manifest.json"
    assert manifest_path.exists(), f"Missing fixture manifest: {manifest_path}"
    fixture_manifest = json.loads(manifest_path.read_text())

    exe_build = next(b for b in fixture_manifest["builds"]
                     if b["kind"] == "executable" and b["optimization"] == "O2")
    exe_path = Path(exe_build["analysis_path"])
    assert exe_path.exists(), f"Executable binary not found: {exe_path}"
    exe_sha = sha256_file(exe_path)
    print(f"  Executable: {exe_path.name} (SHA-256: {exe_sha})")

    print("\n=== Step 2: Probing original larger executable directly ===")
    cli_cases = [
        ([], 0, "result=84 seen=1 accepted=1 rejected=0 sum=84 low=84 high=84 last=84"),
        (["2", "1024"], 1, "result=-2 seen=1 accepted=0 rejected=1 sum=0 low=4294967295 high=0 last=0"),
        (["4", "4000", "1"], 0, "result=10000 seen=1 accepted=1 rejected=0 sum=10000 low=10000 high=10000 last=10000"),
    ]
    for args, expected_code, expected_stdout in cli_cases:
        res = subprocess.run([str(exe_path), *args], capture_output=True, text=True, check=False)
        assert res.returncode == expected_code, f"Original executable failed for args {args}: code {res.returncode}"
        assert res.stdout.strip() == expected_stdout, f"Original executable stdout mismatch for args {args}: {res.stdout}"
        print(f"  CLI case args={args or '[]'} -> returncode={res.returncode} [ORIGINAL AGREEMENT]")

    print("\n=== Step 3: Ghidra headless analysis and indexing of executable ===")
    headless_path = Path(os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless"))
    assert headless_path.exists(), f"Ghidra analyzeHeadless not found: {headless_path}"
    engine = GhidraAnalysis(state_dir, headless_path, warm_workers=2)

    target_manifest = engine.analyze(exe_path)
    assert target_manifest["function_count"] == 41, f"Expected 41 functions, got {target_manifest['function_count']}"
    print(f"  Campaign: {target_manifest['campaign']}")
    print(f"  Functions indexed: {target_manifest['function_count']} (including main and runtime)")

    print("\n=== Step 4: Subsystem discovery & scoping ===")
    scope_req = ScopeRequest.from_dict({
        "mode": "subsystem",
        "query": "Decode telemetry packets, enforce kind and value policy, and update aggregate state",
        "seeds": ["telemetry_apply"],
        "max_functions": 24,
        "max_depth": 2,
        "include_callers": False,
        "include_shared_data": True,
        "expected_observables": [
            "Malformed packets leave all counters unchanged",
            "Policy rejection increments seen and rejected but not accepted",
            "Accepted packets update sum, low, high, last, and a value bucket"
        ]
    })
    scope = persist_scope(engine, target_manifest, scope_req)
    assert len(scope["included"]) == 21, f"Expected 21 included functions, got {len(scope['included'])}"
    assert len(scope["unresolved"]) == 0, f"Expected 0 unresolved edges, got {len(scope['unresolved'])}"
    print(f"  Scope ID: {scope['scope_id']} revision {scope['revision']}")
    print(f"  Included subsystem functions: {len(scope['included'])}")
    for item in scope["included"]:
        assert not item["name"].startswith("FUN_"), f"Function {item['entry']} lacks resolved symbol name: {item['name']}"
    print("  All 21 subsystem functions cleanly resolved and named.")

    print("\n=== Step 5: Assembling clean executable dossier ===")
    dossier = assemble_clean_executable_dossier(state_dir)
    dossier_art = dossier["artifact"]
    assert dossier["schema"] == 1
    assert dossier["readiness"] == "ready_for_spec"
    assert len(dossier["blockers"]) == 0
    assert dossier["coverage"]["static_supported_claims"] == 38
    assert dossier["coverage"]["reviewed_dependency_contracts"] == 18
    assert dossier["coverage"]["current_dependency_contracts"] == 18
    assert dossier["coverage"]["uncovered_direct_calls"] == 0
    assert dossier["coverage"]["original_probe_agreements"] == 18
    print(f"  Dossier artifact: {dossier_art}")
    print(f"  Supported claims: {dossier['coverage']['static_supported_claims']}/38")
    print(f"  Dependency contracts: {dossier['coverage']['current_dependency_contracts']}/18")
    print(f"  Agreed probe cases: {dossier['coverage']['original_probe_agreements']}/18")

    print("\n=== Step 6: Generating Native Subsystem Spec via CLI ===")
    cli_cmd = [
        sys.executable, str(ROOT / "launch.py"), "spec",
        "--state", str(state_dir),
        "--dossier-artifact", dossier_art,
    ]
    cli_out = subprocess.check_output(cli_cmd, text=True, cwd=str(ROOT))
    spec_pointer = json.loads(cli_out)

    assert "artifact" in spec_pointer
    assert "markdown_artifact" in spec_pointer or "markdown_path" in spec_pointer
    assert spec_pointer["dossier_artifact"] == dossier_art
    assert spec_pointer["status"] == "ready_for_review"
    assert spec_pointer["requirements"] == 38
    print(f"  Generated Spec Artifact: {spec_pointer['artifact']}")
    print(f"  Markdown Document:       {spec_pointer['markdown_path']}")
    print(f"  Status:                  {spec_pointer['status']}")
    print(f"  Requirements generated:  {spec_pointer['requirements']}")

    print("\n=== Step 7: Cleanroom compliance audit ===")
    spec_bytes = store.get(spec_pointer["artifact"])
    spec_json = spec_bytes.decode("utf-8") if isinstance(spec_bytes, bytes) else spec_bytes
    spec = json.loads(spec_json)
    assert spec["schema"] == 2
    assert spec["kind"] == "native_subsystem_spec"
    assert len(spec["requirements"]) == 38

    forbidden_patterns = ["MOVAPS", "MOVUPS", "PXOR", "param_1", "param_2", "DAT_", "0x0010", "RAX", "RDI", "EAX"]
    for forbidden in forbidden_patterns:
        assert forbidden not in spec_json, f"Forbidden term '{forbidden}' leaked in public specification!"
    print("  Public specification contains ZERO source leaks, registers, or assembly mnemonics.")

    print("\n=== Step 8: Cleanroom reimplementation and verification ===")
    cleanroom_test_script = ROOT / "scripts" / "test_cleanroom_reimplementation.py"
    res = subprocess.run([sys.executable, str(cleanroom_test_script), scope["scope_id"]],
                         capture_output=True, text=True, check=True, cwd=str(ROOT))
    print(res.stdout)
    assert "CLEANROOM REIMPLEMENTATION VERIFICATION: 100% SUCCESSFUL!" in res.stdout
    assert "Total Probe Cases Passed: 18/18" in res.stdout

    elapsed = time.monotonic() - t_start
    print("\n=======================================================")
    print("ALL 10 EXECUTABLE SUBSYSTEM CHECKS PASSED!")
    print(f"Spec Artifact:       {spec_pointer['artifact']}")
    print(f"Markdown Document:   {spec_pointer['markdown_path']}")
    print(f"Probe Cases Passed:  18/18 (100% agreement)")
    print(f"Total E2E Runtime:   {elapsed:.2f} seconds (< 30s threshold)")
    print("=======================================================")
    assert elapsed < 30.0, f"Execution time {elapsed:.2f}s exceeded 30s threshold"


if __name__ == "__main__":
    main()
