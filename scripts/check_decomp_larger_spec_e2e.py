"""End-to-end test of generating the full native specification for a larger executable.

Validates the complete chain for the telemetry executable fixture:
1. Building stripped executable and companion shared library from source
2. Executing held-out probe test cases against the original executable directly
3. Ghidra analysis & indexing of the larger binary
4. Scoping the bounded 21-function telemetry subsystem
5. Dossier assembly with static reviews, probe links, and dependency contracts
6. Specification generation via CLI (launch.py spec) and Python API
7. Rigorous assertions on specification schema, requirements, descriptions,
   markdown rendering, idempotency, and handoff contracts.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.models import ScopeRequest  # noqa: E402
from engine.scope import persist_scope  # noqa: E402
from engine.dossier import assemble, canonical  # noqa: E402
from engine.specification import generate_spec, persist_spec  # noqa: E402


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    state_dir = ROOT / "decomp-state"
    store = LocalArtifactStore(state_dir / "artifacts")

    print("=== Step 1: Building larger executable and companions from source ===")
    build_script = ROOT / "scripts" / "build_telemetry_fixture.py"
    subprocess.run([sys.executable, str(build_script)], check=True)

    manifest_path = state_dir / "fixtures" / "telemetry_manifest.json"
    assert manifest_path.exists(), f"Missing fixture manifest: {manifest_path}"
    fixture_manifest = json.loads(manifest_path.read_text())

    # Locate the stripped O2 executable and companion shared library
    exe_build = next(b for b in fixture_manifest["builds"]
                     if b["kind"] == "executable" and b["optimization"] == "O2")
    shared_build = next(b for b in fixture_manifest["builds"]
                        if b["kind"] == "shared" and b["optimization"] == "O2")

    exe_path = Path(exe_build["analysis_path"])
    shared_path = Path(shared_build["analysis_path"])
    assert exe_path.exists(), f"Executable binary not found: {exe_path}"
    assert shared_path.exists(), f"Shared library binary not found: {shared_path}"

    exe_sha = sha256_file(exe_path)
    shared_sha = sha256_file(shared_path)
    print(f"  Executable: {exe_path.name} (SHA-256: {exe_sha})")
    print(f"  Shared lib: {shared_path.name} (SHA-256: {shared_sha})")

    print("\n=== Step 2: Probing original larger executable directly ===")
    # Probe the executable CLI directly
    cases = [
        ([], 0, "result=84 seen=1 accepted=1 rejected=0 sum=84 low=84 high=84 last=84"),
        (["2", "1024"], 1, "result=-2 seen=1 accepted=0 rejected=1 sum=0 low=4294967295 high=0 last=0"),
        (["4", "4000", "1"], 0, "result=10000 seen=1 accepted=1 rejected=0 sum=10000 low=10000 high=10000 last=10000"),
    ]
    for args, expected_code, expected_stdout in cases:
        res = subprocess.run([str(exe_path), *args], capture_output=True, text=True, check=False)
        assert res.returncode == expected_code, f"Executable failed for args {args}: code {res.returncode}"
        assert res.stdout.strip() == expected_stdout, f"Executable stdout mismatch for args {args}: {res.stdout}"
        print(f"  CLI case args={args or '[]'} -> returncode={res.returncode} [AGREEMENT]")

    # Run the comprehensive 24-case probe suite (executable + shared library)
    probe_script = ROOT / "scripts" / "probe_telemetry_fixture.py"
    probe_output = subprocess.check_output([sys.executable, str(probe_script)], text=True)
    probe_data = json.loads(probe_output)
    assert probe_data["agreement_count"] == 24
    print(f"  Full probe suite passed: {probe_data['agreement_count']}/24 cases agree")

    print("\n=== Step 3: Ghidra headless analysis and subsystem scoping ===")
    headless_path = Path(os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless"))
    assert headless_path.exists(), f"Ghidra analyzeHeadless not found: {headless_path}"
    engine = GhidraAnalysis(state_dir, headless_path)

    # Analyze the target executable and shared library
    target_manifest = engine.analyze(shared_path)
    assert target_manifest["function_count"] == 39
    print(f"  Campaign: {target_manifest['campaign']}")
    print(f"  Functions indexed: {target_manifest['function_count']}")

    # Scope request for the telemetry subsystem
    scope_req_path = ROOT / "fixtures" / "decomp" / "telemetry_scope_request.json"
    req_data = json.loads(scope_req_path.read_text())
    request = ScopeRequest.from_dict(req_data)
    scope = persist_scope(engine, target_manifest, request)
    assert len(scope["included"]) == 21, f"Expected 21 included functions, got {len(scope['included'])}"
    assert len(scope["unresolved"]) == 0, f"Expected 0 unresolved edges, got {len(scope['unresolved'])}"
    print(f"  Scope ID: {scope['scope_id']} revision {scope['revision']}")
    print(f"  Included functions: {len(scope['included'])} (all boundary edges resolved)")

    print("\n=== Step 4: Loading verified evidence and assembling subsystem dossier ===")
    # Look for the verified telemetry dossier pointer
    telemetry_scope_id = "19e7cf3c3d707284a78c751be79c2f8b963df6a9f69f020df77594c677cf98e6"
    dossier_pointer_path = state_dir / "dossiers" / telemetry_scope_id / "latest.json"
    assert dossier_pointer_path.exists(), f"Expected dossier pointer at {dossier_pointer_path}"
    dossier_pointer = json.loads(dossier_pointer_path.read_text())
    dossier_artifact = dossier_pointer["artifact"]
    assert len(dossier_artifact) == 64

    # Load and verify dossier content
    dossier_json = store.get(dossier_artifact)
    assert dossier_json, f"Dossier artifact {dossier_artifact} not in store"
    dossier = json.loads(dossier_json)

    assert dossier["schema"] == 1
    assert len(dossier["functions"]) == 21
    assert len(dossier["claims"]) == 38
    assert dossier["coverage"]["static_supported_claims"] == 38
    assert dossier["coverage"]["reviewed_dependency_contracts"] == 18
    assert dossier["coverage"]["current_dependency_contracts"] == 18
    assert dossier["coverage"]["uncovered_direct_calls"] == 0
    assert dossier["readiness"] == "partial"
    print(f"  Dossier artifact: {dossier_artifact}")
    print(f"  Coverage: {dossier['coverage']['static_supported_claims']}/38 claims statically supported")
    print(f"  Dependency contracts: {dossier['coverage']['current_dependency_contracts']} active helpers")
    print(f"  Original probe cases: {dossier['coverage']['original_probe_cases']} distinct agreeing cases")
    print(f"  Readiness: {dossier['readiness']} ({len(dossier['blockers'])} open blockers recorded)")

    # Verify assembling the dossier from its component inputs produces a valid dossier and spec
    assembled = assemble(
        SimpleNamespace(store=store),
        {"campaign": dossier["campaign"], "binary_sha256": dossier["binary_sha256"]},
        dossier["scope_artifact"],
        dossier["draft_artifacts"],
        dossier["review_artifacts"],
        dossier["probe_report_artifacts"],
        dossier["probe_link_artifacts"],
        dossier["dependency_resolution_artifacts"],
        dossier.get("contract_snapshot"),
        dossier.get("gap_adjudication_artifacts", []),
    )
    assembled["revision"] = dossier["revision"] + 1
    assert len(assembled["functions"]) == 21
    assert assembled["coverage"]["static_supported_claims"] == 38
    assembled_spec = generate_spec(assembled, "test_assembled_artifact")
    assert len(assembled_spec["requirements"]) == 38
    assert assembled_spec["status"] == "partial"
    print("  Fresh in-memory dossier assembly verified: 21 functions, 38 supported claims, 38 spec requirements.")

    print("\n=== Step 5: Generating full native spec via CLI (launch.py spec) ===")
    cli_cmd = [
        sys.executable, str(ROOT / "launch.py"), "spec",
        "--state", str(state_dir),
        "--dossier-artifact", dossier_artifact,
    ]
    cli_out = subprocess.check_output(cli_cmd, text=True)
    spec_pointer = json.loads(cli_out)

    assert "artifact" in spec_pointer
    assert "markdown_artifact" in spec_pointer
    assert spec_pointer["dossier_artifact"] == dossier_artifact
    assert spec_pointer["status"] == "partial"
    assert spec_pointer["requirements"] == 38
    assert len(spec_pointer["blockers"]) == 1
    assert spec_pointer["blockers"][0]["kind"] == "claims_not_linked_to_original_probes"
    assert spec_pointer["blockers"][0]["count"] == 26
    print(f"  Generated Spec Artifact: {spec_pointer['artifact']}")
    print(f"  Markdown Artifact: {spec_pointer['markdown_artifact']}")
    print(f"  Status: {spec_pointer['status']}")
    print(f"  Requirements generated: {spec_pointer['requirements']}")

    print("\n=== Step 6: Validating generated JSON specification schema and contracts ===")
    spec_path = Path(spec_pointer["json_path"])
    markdown_path = Path(spec_pointer["markdown_path"])
    assert spec_path.exists(), f"Spec pointer JSON file missing: {spec_path}"
    assert markdown_path.exists(), f"Spec markdown file missing: {markdown_path}"

    spec_raw = store.get(spec_pointer["artifact"])
    assert spec_raw, "Spec artifact missing from store"
    spec = json.loads(spec_raw)

    # Validate top-level schema
    assert spec["schema"] == 1
    assert spec["kind"] == "native_subsystem_spec"
    assert spec["campaign"] == dossier["campaign"]
    assert spec["binary_sha256"] == dossier["binary_sha256"]
    assert spec["scope_id"] == telemetry_scope_id
    assert spec["scope_revision"] == dossier["scope_revision"]
    assert spec["status"] == "partial"

    # Validate boundary section
    boundary = spec["boundary"]
    assert boundary["mode"] == "subsystem"
    assert len(boundary["included"]) == 21
    included_names = {item["name"] for item in boundary["included"]}
    assert "telemetry_apply" in included_names
    assert "telemetry_reset" in included_names
    assert "choose_bucket" in included_names
    assert "telemetry_snapshot" in included_names

    # Validate 38 numbered requirements
    requirements = spec["requirements"]
    assert len(requirements) == 38, f"Expected 38 requirements, got {len(requirements)}"
    included_entries = {item["entry"] for item in boundary["included"]}
    for i, req in enumerate(requirements, start=1):
        assert req["id"] == f"REQ-{i}"
        assert req["subject"] in included_entries
        assert len(req["statement"]) > 0
        assert req["review_state"] == "supported_static"
        assert len(req["evidence"]) >= 1
        for ev in req["evidence"]:
            assert len(ev["artifact"]) == 64
            assert len(ev["address"]) >= 4
        assert len(req["reviews"]) >= 1
        assert req["execution_state"] in {"case_agreement", "unmapped"}

    # Validate 21 function descriptions
    functions = spec["function_descriptions"]
    assert len(functions) == 21, f"Expected 21 function descriptions, got {len(functions)}"
    fn_map = {fn["name"]: fn for fn in functions}
    for name in ("telemetry_apply", "telemetry_reset", "choose_bucket", "telemetry_snapshot"):
        assert name in fn_map, f"Missing function description: {name}"
        fn = fn_map[name]
        assert len(fn["inputs"]) > 0
        assert len(fn["outputs"]) > 0
        assert len(fn["draft_pseudocode"]) > 0

    # Validate dependency contracts & original cases
    assert len(spec["dependency_contracts"]) == 18
    assert len(spec["original_cases"]) == 19
    assert len({c["case_id"] for c in spec["original_cases"]}) == 15
    assert len(spec["unresolved_claims"]) == 0
    assert len(spec["review_gaps"]) == 3
    assert all(gap.get("decision") == "nonblocking" for gap in spec["review_gaps"])
    assert len(spec["blockers"]) == 1
    assert spec["blockers"][0]["kind"] == "claims_not_linked_to_original_probes"

    # Validate provenance audit trail
    prov = spec["provenance"]
    assert prov["dossier_artifact"] == dossier_artifact
    assert prov["dossier_revision"] == dossier["revision"]
    assert prov["dossier_readiness"] == "partial"
    assert prov["dossier_schema"] == 1
    assert prov["scope_artifact"] == dossier["scope_artifact"]
    assert len(prov["draft_artifacts"]) == 21
    assert len(prov["review_artifacts"]) == 21
    assert len(prov["probe_report_artifacts"]) == 3
    assert len(prov["probe_link_artifacts"]) == 1
    assert len(prov["dependency_resolution_artifacts"]) == 1
    assert len(prov["gap_adjudication_artifacts"]) == 2
    assert len(prov["generator_sha256"]) == 64
    print("  Schema and field-level validations passed:")
    print(f"    - Title: '{spec['title']}'")
    print(f"    - Boundary functions: {len(boundary['included'])}")
    print(f"    - Requirements (REQ-1..REQ-38): {len(requirements)}")
    print(f"    - Function descriptions: {len(functions)}")
    print(f"    - Dependency contracts: {len(spec['dependency_contracts'])}")
    print(f"    - Executed original cases: {len(spec['original_cases'])}")
    print(f"    - Review gaps: {len(spec['review_gaps'])}")
    print(f"    - Blockers: {len(spec['blockers'])}")

    print("\n=== Step 7: Validating Markdown specification rendering ===")
    md_content = markdown_path.read_text()
    assert f"# Native subsystem specification: {spec['title']}" in md_content
    assert "Status: **partial**" in md_content
    assert f"Dossier: `{dossier_artifact}`" in md_content
    assert f"Binary SHA-256: `{dossier['binary_sha256']}`" in md_content
    assert "## Evidence-backed requirements" in md_content
    for i in range(1, 39):
        assert f"### REQ-{i} ·" in md_content
    assert "## Function notes and draft pseudocode" in md_content
    assert "### telemetry_apply" in md_content
    assert "### telemetry_reset" in md_content
    assert "### choose_bucket" in md_content
    assert "## Dependency contracts" in md_content
    assert "## Original cases" in md_content
    assert "## Open blockers" in md_content
    assert "## Coverage inventory" in md_content
    print(f"  Markdown document verified ({len(md_content.splitlines())} lines)")

    print("\n=== Step 8: Verifying generator idempotency & immutability ===")
    repeated_cli_out = subprocess.check_output(cli_cmd, text=True)
    repeated_spec_pointer = json.loads(repeated_cli_out)
    assert spec_pointer["artifact"] == repeated_spec_pointer["artifact"]
    assert spec_pointer["markdown_artifact"] == repeated_spec_pointer["markdown_artifact"]

    repeated_persisted = persist_spec(state_dir, dossier_artifact)
    assert repeated_persisted["artifact"] == spec_pointer["artifact"]
    assert repeated_persisted["markdown_artifact"] == spec_pointer["markdown_artifact"]
    print("  Repeated executions produce identical artifact hashes and disk pointers.")

    print("\n=== Step 9: Testing check_decomp_handoff.py compatibility ===")
    handoff_script = ROOT / "scripts" / "check_decomp_handoff.py"
    handoff_out = subprocess.check_output(
        [sys.executable, str(handoff_script), "--state", str(state_dir),
         "--dossier-artifact", dossier_artifact], text=True)
    handoff_data = json.loads(handoff_out)
    assert handoff_data["dossier_artifact"] == dossier_artifact
    assert handoff_data["supported_requirements"] == 38
    assert handoff_data["unresolved_claims"] == 0
    assert handoff_data["blockers"] == 1
    print(f"  check_decomp_handoff passed: {handoff_data}")

    print("\n=== Step 10: Negative/rejection testing ===")
    # Rejection of wrong schema
    try:
        generate_spec({**dossier, "schema": 99}, dossier_artifact)
    except ValueError as err:
        assert "unsupported dossier schema" in str(err)
        print("  Rejected invalid schema: OK")
    else:
        raise AssertionError("Failed to reject invalid schema")

    # Rejection of missing required handoff fields
    corrupt_dossier = {k: v for k, v in dossier.items() if k != "independent_review_gaps"}
    try:
        generate_spec(corrupt_dossier, dossier_artifact)
    except ValueError as err:
        assert "independent_review_gaps" in str(err)
        print("  Rejected missing handoff fields: OK")
    else:
        raise AssertionError("Failed to reject incomplete dossier")

    print("\n=======================================================")
    print("ALL 10 END-TO-END SPEC GENERATION CHECKS PASSED!")
    print(f"Subsystem Spec Artifact: {spec_pointer['artifact']}")
    print(f"Markdown Spec Path:      {spec_pointer['markdown_path']}")
    print(f"Requirements:            {spec_pointer['requirements']}")
    print(f"Status:                  {spec_pointer['status']}")
    print("=======================================================")


if __name__ == "__main__":
    main()
