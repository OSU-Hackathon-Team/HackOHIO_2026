"""Run an unassisted native subsystem analysis and report its real blockers.

No claims, reviews, or probe outcomes are synthesized by this driver. A draft
spec is useful for continuing work, but never counts as equivalence.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.dossier import persist_dossier
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.specification import persist_spec
from engine.validation.review import IndependentReviewer
from engine.worker import SemanticWorker


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--state", type=Path, default=Path("decomp-state"))
    parser.add_argument("--headless", type=Path,
                        default=Path("/opt/ghidra/support/analyzeHeadless"))
    parser.add_argument("--opencode", type=Path,
                        default=Path.home() / ".opencode/bin/opencode")
    parser.add_argument("--model")
    parser.add_argument("--review-model")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--max-functions", type=int, default=32)
    args = parser.parse_args()
    engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
    manifest = engine.analyze(args.binary)
    index = engine.index(manifest)
    candidates = [function for function in index["functions"]
                  if not function.get("thunk") and not function.get("external")
                  and not function["name"].startswith(("FUN_", "_", "~"))]
    if not candidates:
        raise SystemExit("no named seed functions found")
    selected = random.Random(args.seed).choice(candidates)
    scope = persist_scope(engine, manifest, ScopeRequest(
        mode="subsystem", query=f"Caller-visible behavior rooted at {selected['name']}",
        seeds=(selected["entry"],), max_functions=args.max_functions,
        max_depth=2, include_shared_data=False))
    worker = SemanticWorker(engine, args.opencode)
    reviewer = IndependentReviewer(engine, args.opencode)
    drafts, reviews, failures = [], [], []
    for function in scope["included"]:
        subject = function["entry"]
        result = worker.run(manifest, scope["artifact"], subject, model=args.model)
        if result["state"] != "unreviewed":
            failures.append({"subject": subject, "stage": "semantic",
                             "state": result["state"], "artifact": result["artifact"]})
            continue
        drafts.append(result["artifact"])
        review = reviewer.run(result["artifact"], model=args.review_model)
        if review["state"] == "reviewed":
            reviews.append(review["artifact"])
        else:
            failures.append({"subject": subject, "stage": "review",
                             "state": review["state"], "artifact": review["artifact"]})
    dossier = persist_dossier(engine, manifest, scope["artifact"], drafts, reviews, [])
    spec = persist_spec(engine.root, dossier["artifact"])
    print(json.dumps({"seed": selected["name"], "scope_artifact": scope["artifact"],
                      "included": len(scope["included"]),
                      "unresolved": len(scope["unresolved"]),
                      "drafts": len(drafts), "reviews": len(reviews),
                      "failures": failures, "dossier_artifact": dossier["artifact"],
                      "readiness": dossier["readiness"],
                      "blockers": dossier["blockers"], "spec_artifact": spec["artifact"],
                      "spec_status": spec["status"]}, indent=2))


if __name__ == "__main__":
    main()
