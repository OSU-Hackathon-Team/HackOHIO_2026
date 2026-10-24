"""Challenge an intentionally wrong native claim against real Ghidra evidence."""

import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.validation.review import IndependentReviewer, validate_review  # noqa: E402


def main() -> None:
    fixture = ROOT / "decomp-state" / "fixtures" / "native_lab_O2_shared.so"
    if not fixture.exists():
        raise SystemExit("Run python scripts/build_decomp_fixtures.py first")
    engine = GhidraAnalysis(ROOT / "decomp-state",
                            Path("/opt/ghidra/support/analyzeHeadless"))
    manifest = engine.analyze(fixture)
    candidates = [item for item in engine.index(manifest)["functions"]
                  if item["name"] == "read_total" and not item["thunk"]]
    assert len(candidates) == 1
    subject = candidates[0]["entry"]
    evidence = engine.function(manifest, subject)
    pointer = Path(manifest["project"]) / "functions" / (subject + ".json")
    evidence_artifact = json.loads(pointer.read_text())["artifact"]
    wrong = {"schema": 1, "state": "unreviewed", "campaign": manifest["campaign"],
             "subject": subject, "evidence_artifact": evidence_artifact,
             "test_seed": "deliberately false constant-return claim",
             "answer": {"claims": [{"statement": "read_total always returns the constant 7",
                                    "evidence_addresses": [subject],
                                    "assumptions": [], "alternatives": []}]}}
    draft_artifact = engine.store.put(json.dumps(wrong, sort_keys=True).encode())
    reviewer = IndependentReviewer(engine, Path(os.environ.get(
        "OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
    result = reviewer.run(draft_artifact, model=os.environ.get("DECOMP_REVIEW_CHECK_MODEL"))
    assert result["state"] == "reviewed", result
    outcome = result["answer"]["reviews"][0]["outcome"]
    assert outcome in {"contradicted", "uncertain"}, result
    tampered = {"reviews": [{"claim_index": 0, "outcome": "supported_static",
                             "reason": "wrong citation", "evidence_addresses": ["DEADBEEF"]}],
                "missing_behavior": [], "unresolved": []}
    assert validate_review(tampered, evidence, 1)
    print(json.dumps({"seeded_claim": wrong["answer"]["claims"][0]["statement"],
                      "outcome": outcome, "review_artifact": result["artifact"]}, indent=2))


if __name__ == "__main__":
    main()
