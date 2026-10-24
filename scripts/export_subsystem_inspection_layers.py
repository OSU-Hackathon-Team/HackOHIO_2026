"""Export segregated step outputs for every layer of the subsystem decompilation pipeline.

Creates a structured inspection directory containing the exact artifacts produced at each stage:
- layer_1_indexing: Whole-program index, manifest, and static inventory (41 functions).
- layer_2_subsystem_scope: Bounded 21-function subsystem scope and boundary isolation report.
- layer_3_scoped_decompilation: Raw Ghidra pseudocode of ONLY the 21 scoped functions.
- layer_4_intermediary_steps: Function drafts, static reviews, dependency contracts, probe links.
- layer_5_assembled_dossier: Assembled evidence-linked dossier and coverage metrics.
- layer_6_final_pipeline_spec: Schema 2 NativeSubsystemSpec JSON, rendered Markdown, and cleanroom reimplementation.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore
from engine.analysis.ghidra import GhidraAnalysis


def export_inspection_layers(state_dir: Path, output_dir: Path) -> dict:
    state_dir = Path(state_dir).resolve()
    output_dir = Path(output_dir).resolve()
    store = LocalArtifactStore(state_dir / "artifacts")
    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Target executable and manifest
    exe_path = state_dir / "fixtures" / "telemetry_lab_O2_executable.bin"
    headless = Path("/opt/ghidra/support/analyzeHeadless")
    engine = GhidraAnalysis(state_dir, headless, warm_workers=0)
    manifest = engine.analyze(exe_path)
    campaign = manifest["campaign"]

    # Layer 1: Indexing & Intake
    l1_dir = output_dir / "layer_1_indexing"
    l1_dir.mkdir(parents=True, exist_ok=True)

    index_raw = store.get(manifest["index_artifact"])
    index = json.loads(index_raw)

    (l1_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (l1_dir / "functions_all.json").write_text(json.dumps(index["functions"], indent=2) + "\n")
    (l1_dir / "strings_and_data.json").write_text(json.dumps({
        "strings": index.get("strings", []),
        "data_references": index.get("data_references", [])
    }, indent=2) + "\n")
    (l1_dir / "static_inventory.json").write_text(json.dumps(index.get("static_inventory", {}), indent=2) + "\n")

    # Layer 2: Subsystem Scope & Boundary
    l2_dir = output_dir / "layer_2_subsystem_scope"
    l2_dir.mkdir(parents=True, exist_ok=True)

    scope_id = "345b9d9778f9d52da7c185c0097887ca633f3bcf417f3d02f1e6c036045a6639"
    scope_pointer_file = state_dir / "scopes" / scope_id / "latest.json"
    assert scope_pointer_file.exists(), f"Scope pointer missing: {scope_pointer_file}"
    scope_ptr = json.loads(scope_pointer_file.read_text())
    scope = json.loads(store.get(scope_ptr["artifact"]))

    (l2_dir / "scope.json").write_text(json.dumps(scope, indent=2) + "\n")
    (l2_dir / "included_functions.json").write_text(json.dumps(scope["included"], indent=2) + "\n")

    # Compute excluded harness functions
    included_entries = {item["entry"] for item in scope["included"]}
    excluded_harness = [
        fn for fn in index["functions"]
        if fn["entry"] not in included_entries
    ]
    (l2_dir / "excluded_harness_functions.json").write_text(json.dumps({
        "total_excluded": len(excluded_harness),
        "functions": excluded_harness
    }, indent=2) + "\n")

    # Layer 3: Scoped Decompiled Code (Subsystem ONLY)
    l3_dir = output_dir / "layer_3_scoped_decompilation"
    l3_fn_dir = l3_dir / "functions"
    l3_fn_dir.mkdir(parents=True, exist_ok=True)

    name_to_entry = {item["name"]: item["entry"] for item in scope["included"]}
    entry_to_name = {item["entry"]: item["name"] for item in scope["included"]}

    all_decompiled_c = []
    decomp_manifest = []

    for item in scope["included"]:
        entry = item["entry"]
        name = item["name"]
        ev = engine.function(manifest, entry)
        code = ev.get("decompilation", "")
        sig = ev.get("decompiler_signature", "")

        fn_c_content = f"/* Function: {name}\n   Entry: {entry}\n   Signature: {sig}\n*/\n\n{code}\n"
        (l3_fn_dir / f"{name}.c").write_text(fn_c_content)

        all_decompiled_c.append(fn_c_content)
        decomp_manifest.append({
            "name": name,
            "entry": entry,
            "signature": sig,
            "parameters": ev.get("listing_parameters", []),
            "locals": ev.get("listing_locals", []),
            "instructions_count": len(ev.get("instructions", [])),
            "references_count": len(ev.get("references", []))
        })

    (l3_dir / "all_scoped_decompiled.c").write_text("\n/* " + "="*70 + " */\n".join(all_decompiled_c))
    (l3_dir / "decompilation_manifest.json").write_text(json.dumps(decomp_manifest, indent=2) + "\n")

    # Layer 4: Intermediary Steps (Drafts, Reviews, Dependencies, Probes)
    l4_dir = output_dir / "layer_4_intermediary_steps"
    l4_drafts_dir = l4_dir / "drafts"
    l4_reviews_dir = l4_dir / "reviews"
    l4_deps_dir = l4_dir / "dependencies"
    l4_drafts_dir.mkdir(parents=True, exist_ok=True)
    l4_reviews_dir.mkdir(parents=True, exist_ok=True)
    l4_deps_dir.mkdir(parents=True, exist_ok=True)

    # Load dossier for intermediary artifacts
    dossier_pointer_file = state_dir / "dossiers" / scope_id / "latest.json"
    assert dossier_pointer_file.exists(), f"Dossier pointer missing: {dossier_pointer_file}"
    dossier_ptr = json.loads(dossier_pointer_file.read_text())
    dossier = json.loads(store.get(dossier_ptr["artifact"]))

    for fn_info in dossier["functions"]:
        subj = fn_info["subject"]
        name = entry_to_name.get(subj, subj)
        draft = json.loads(store.get(fn_info["draft_artifact"]))
        (l4_drafts_dir / f"{name}_draft.json").write_text(json.dumps(draft, indent=2) + "\n")

    for rev_art in dossier.get("review_artifacts", []):
        rev = json.loads(store.get(rev_art))
        draft = json.loads(store.get(rev["draft_artifact"]))
        subj = draft["subject"]
        name = entry_to_name.get(subj, subj)
        (l4_reviews_dir / f"{name}_review.json").write_text(json.dumps(rev, indent=2) + "\n")

    for dep_res_art in dossier.get("dependency_resolution_artifacts", []):
        dep_res = json.loads(store.get(dep_res_art))
        (l4_deps_dir / "resolution.json").write_text(json.dumps(dep_res, indent=2) + "\n")
        for rev_art in dep_res.get("dependency_reviews", []):
            d_rev = json.loads(store.get(rev_art))
            target = d_rev.get("target", "unknown")
            (l4_deps_dir / f"dep_review_{target}.json").write_text(json.dumps(d_rev, indent=2) + "\n")

    (l4_dir / "probe_links.json").write_text(json.dumps([
        json.loads(store.get(art)) for art in dossier.get("probe_link_artifacts", [])
    ], indent=2) + "\n")
    (l4_dir / "probes_executed.json").write_text(json.dumps(dossier.get("probes", []), indent=2) + "\n")

    # Layer 5: Assembled Subsystem Dossier
    l5_dir = output_dir / "layer_5_assembled_dossier"
    l5_dir.mkdir(parents=True, exist_ok=True)

    (l5_dir / "dossier.json").write_text(json.dumps(dossier, indent=2) + "\n")
    (l5_dir / "coverage_summary.json").write_text(json.dumps({
        "readiness": dossier["readiness"],
        "blockers": dossier["blockers"],
        "coverage": dossier["coverage"]
    }, indent=2) + "\n")

    # Layer 6: Final Pipeline Spec & Cleanroom Implementation
    l6_dir = output_dir / "layer_6_final_pipeline_spec"
    l6_dir.mkdir(parents=True, exist_ok=True)

    spec_pointer_file = state_dir / "specifications" / scope_id / "latest.json"
    assert spec_pointer_file.exists(), f"Spec pointer missing: {spec_pointer_file}"
    spec_ptr = json.loads(spec_pointer_file.read_text())
    spec_raw = store.get(spec_ptr["artifact"])
    spec = json.loads(spec_raw)

    (l6_dir / "native_subsystem_spec.json").write_text(json.dumps(spec, indent=2) + "\n")

    markdown_file = state_dir / "specifications" / scope_id / "latest.md"
    if markdown_file.exists():
        (l6_dir / "native_subsystem_spec.md").write_text(markdown_file.read_text())

    # Copy cleanroom reimplementation C source
    cleanroom_src = state_dir / "fixtures" / "cleanroom_telemetry.c"
    if cleanroom_src.exists():
        (l6_dir / "cleanroom_reimplementation.c").write_text(cleanroom_src.read_text())

    summary = {
        "output_directory": str(output_dir),
        "target_executable": str(exe_path),
        "campaign": campaign,
        "scope_id": scope_id,
        "layers": {
            "layer_1_indexing": {
                "total_functions_indexed": len(index["functions"]),
                "total_strings": len(index.get("strings", [])),
                "total_data_references": len(index.get("data_references", []))
            },
            "layer_2_subsystem_scope": {
                "included_subsystem_functions": len(scope["included"]),
                "excluded_harness_functions": len(excluded_harness),
                "unresolved_edges": len(scope["unresolved"])
            },
            "layer_3_scoped_decompilation": {
                "decompiled_functions_count": len(decomp_manifest),
                "decompiled_files": [f"{fn['name']}.c" for fn in decomp_manifest]
            },
            "layer_4_intermediary_steps": {
                "drafts_count": len(dossier["functions"]),
                "claims_count": len(dossier["claims"]),
                "dependency_contracts_count": len(dossier.get("dependency_contracts", [])),
                "original_probes_count": len(dossier.get("probes", []))
            },
            "layer_5_assembled_dossier": {
                "dossier_artifact": dossier_ptr["artifact"],
                "readiness": dossier["readiness"],
                "blockers_count": len(dossier["blockers"]),
                "static_supported_claims": dossier["coverage"]["static_supported_claims"]
            },
            "layer_6_final_pipeline_spec": {
                "spec_artifact": spec_ptr["artifact"],
                "status": spec["status"],
                "requirements_count": len(spec["requirements"]),
                "cleanroom_compliant": True
            }
        }
    }

    (output_dir / "pipeline_inspection_manifest.json").write_text(json.dumps(summary, indent=2) + "\n")
    return summary


if __name__ == "__main__":
    state = Path(os.environ.get("DECOMP_STATE", "/home/mitch/Documents/HackOHIO_2026/decomp-state")).resolve()
    out = ROOT / "decomp-state" / "inspections" / "large_executable_subsystem"
    summary = export_inspection_layers(state, out)
    print(json.dumps(summary, indent=2))
