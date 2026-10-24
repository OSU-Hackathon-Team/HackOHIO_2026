"""Validate a persisted native dossier against the existing generator in memory."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.specification import generate_spec  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=ROOT / "decomp-state")
    parser.add_argument("--dossier-artifact", help="immutable dossier SHA-256")
    args = parser.parse_args()
    state = args.state.resolve()
    artifact = args.dossier_artifact
    if artifact is None:
        pointers = list((state / "dossiers").glob("*/latest.json"))
        if not pointers:
            parser.error("no dossier pointers found; provide --dossier-artifact")
        pointer = json.loads(max(pointers, key=lambda path: path.stat().st_mtime).read_text())
        artifact = pointer["artifact"]
    dossier = json.loads(LocalArtifactStore(state / "artifacts").get(artifact))
    handoff = generate_spec(dossier, artifact)
    assert handoff["provenance"]["dossier_artifact"] == artifact
    assert handoff["campaign"] == dossier["campaign"]
    assert handoff["coverage"] == dossier["coverage"]
    assert handoff["original_cases"] == dossier["probes"]
    assert handoff["blockers"][:len(dossier["blockers"])] == dossier["blockers"]
    assert len(handoff["function_descriptions"]) == len(dossier["functions"])
    supported = {(claim["subject"], claim["draft_artifact"], claim["claim_index"])
                 for claim in dossier["claims"] if claim["review_state"] == "supported_static"}
    assert all((item["subject"], item["draft_artifact"], item["claim_index"]) in supported
               for item in handoff["requirements"])
    print(json.dumps({"dossier_artifact": artifact,
                      "dossier_readiness": dossier["readiness"],
                      "handoff_status": handoff["status"],
                      "functions": len(handoff["function_descriptions"]),
                      "supported_requirements": len(handoff["requirements"]),
                      "unresolved_claims": len(handoff["unresolved_claims"]),
                      "blockers": len(handoff["blockers"])}))


if __name__ == "__main__":
    main()
