"""Inspect a persisted dossier's eligibility for cleanroom specification."""

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.specification import prepare_handoff  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=ROOT / "decomp-state")
    parser.add_argument("--dossier-artifact")
    args = parser.parse_args()
    state = args.state.resolve()
    artifact = args.dossier_artifact
    if artifact is None:
        pointers = list((state / "dossiers").glob("*/latest.json"))
        if not pointers:
            parser.error("no dossier pointers found; provide --dossier-artifact")
        artifact = json.loads(max(pointers, key=lambda p: p.stat().st_mtime).read_text())["artifact"]
    dossier = json.loads(LocalArtifactStore(state / "artifacts").get(artifact))
    try:
        handoff, _ = prepare_handoff(dossier, artifact)
        status, claims, reason = "ready", len(handoff["claims"]), None
    except ValueError as error:
        status, claims, reason = "not_ready", 0, str(error)
    print(json.dumps({"dossier_artifact": artifact, "dossier_readiness": dossier["readiness"],
                      "handoff_status": status, "supported_claims": claims,
                      "blockers": dossier["blockers"], "reason": reason}))


if __name__ == "__main__":
    main()
