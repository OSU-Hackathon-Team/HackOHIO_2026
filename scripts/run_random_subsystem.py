"""Run an unassisted native subsystem analysis and report its real blockers.

No claims, reviews, or probe outcomes are synthesized by this driver. A draft
spec is useful for continuing work, but never counts as equivalence.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from pathlib import Path
import random
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.dossier import persist_dossier
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.specification import persist_spec
from engine.validation.review import REVIEW_PROMPT_VERSION, IndependentReviewer
from engine.validation.probes import select_original_cases
from engine.validation.scalar_cases import matching_scalar_cases
from engine.validation.gap_direct import IndependentGapReviewer
from engine.worker import SEMANTIC_PROMPT_VERSION, SemanticWorker
from engine.watchdog import Watchdog
from model_config import get_model


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
    parser.add_argument("--gap-model")
    parser.add_argument("--seed", type=int)
    parser.add_argument("--max-functions", type=int, default=32)
    parser.add_argument("--scope-artifact", help="resume an existing discovered scope")
    parser.add_argument("--probe-report-artifact",
                        help="include immutable original observations in review")
    parser.add_argument("--max-revisions", type=int, default=2)
    parser.add_argument("--max-watchdog-retries", type=int, default=2)
    parser.add_argument("--no-watchdog", action="store_true")
    args = parser.parse_args()
    if args.max_revisions < 0:
        parser.error("--max-revisions must be nonnegative")
    if args.max_watchdog_retries < 0:
        parser.error("--max-watchdog-retries must be nonnegative")
    engine = GhidraAnalysis(args.state, args.headless, warm_workers=0)
    manifest = engine.analyze(args.binary)
    index = engine.index(manifest)
    if args.scope_artifact:
        scope = json.loads(engine.store.get(args.scope_artifact))
        if scope["campaign"] != manifest["campaign"]:
            raise ValueError("saved scope belongs to another binary campaign")
        scope["artifact"] = args.scope_artifact
        seed_name = ", ".join(scope["request"]["seeds"])
    else:
        candidates = [function for function in index["functions"]
                      if not function.get("thunk") and not function.get("external")
                      and not function["name"].startswith(("FUN_", "_", "~"))]
        if not candidates:
            raise SystemExit("no named seed functions found")
        selected = random.Random(args.seed).choice(candidates)
        seed_name = selected["name"]
        scope = persist_scope(engine, manifest, ScopeRequest(
            mode="subsystem", query=f"Caller-visible behavior rooted at {seed_name}",
            seeds=(selected["entry"],), max_functions=args.max_functions,
            max_depth=2, include_shared_data=False))
    checkpoint_path = engine.root / "runs" / scope["artifact"] / "progress.json"
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    progress = (json.loads(checkpoint_path.read_text()) if checkpoint_path.exists()
                else {"schema": 1, "campaign": manifest["campaign"],
                      "scope_artifact": scope["artifact"], "subjects": {}})
    if (progress["campaign"] != manifest["campaign"] or
            progress["scope_artifact"] != scope["artifact"]):
        raise ValueError("saved progress belongs to another scope")

    def save() -> None:
        pending = checkpoint_path.with_suffix(".tmp")
        pending.write_text(json.dumps(progress, indent=2) + "\n")
        os.replace(pending, checkpoint_path)

    worker = SemanticWorker(engine, args.opencode)
    reviewer = IndependentReviewer(engine, args.opencode)
    gap_reviewer = IndependentGapReviewer(engine, args.opencode)
    watchdog = None if args.no_watchdog else Watchdog(engine, args.opencode)
    probe_report = (json.loads(engine.store.get(args.probe_report_artifact))
                    if args.probe_report_artifact else None)

    def consult(stage: str, subject: str, saved: dict, cases: list,
                occupied: set[str] | None = None) -> tuple[dict, str | None]:
        if watchdog is None:
            return {"guidance": "", "model_role": None, "evidence_bytes": None}, None
        snapshot = {"function": next((item["name"] for item in scope["included"]
                                      if item["entry"] == subject), subject),
                    "last_failure": saved.get("last_failure"),
                    "revision_count": saved.get("revision_count", 0),
                    "original_cases": cases[:8]}
        if saved.get("last_failure", {}).get("artifact"):
            failed = json.loads(engine.store.get(saved["last_failure"]["artifact"]))
            snapshot["failed_attempt"] = {
                "state": failed.get("state"), "error": failed.get("error"),
                "structural_errors": failed.get("structural_errors"),
                "answer": failed.get("answer")}
        if saved.get("pending_revision_context"):
            context = json.loads(engine.store.get(saved["pending_revision_context"]))
            snapshot["revision_context"] = context
            for key in ("draft_artifact", "review_artifact"):
                if context.get(key):
                    prior = json.loads(engine.store.get(context[key]))
                    snapshot["revision_context"][key + "_answer"] = prior.get("answer")
        for key in ("draft_artifact", "review_artifact", "gap_artifact"):
            if saved.get(key):
                artifact = json.loads(engine.store.get(saved[key]))
                snapshot[key] = {"artifact": saved[key], "state": artifact.get("state"),
                                 "answer": artifact.get("answer"),
                                 "structural_errors": artifact.get("structural_errors"),
                                 "error": artifact.get("error")}
        records = saved.setdefault("watchdog", {})
        result = watchdog.inspect(campaign=manifest["campaign"],
                                  scope_artifact=scope["artifact"], subject=subject,
                                  stage=stage, snapshot=snapshot,
                                  previous_artifact=records.get(stage),
                                  occupied_models=occupied)
        records[stage] = result["artifact"]
        save()
        return result["intervention"], result["artifact"]

    drafts, reviews, failures = [], [], []
    for function in scope["included"]:
        subject = function["entry"]
        saved = progress["subjects"].setdefault(subject, {})
        cases = (select_original_cases(engine.store, probe_report,
                                       manifest["binary_sha256"], function["name"])
                 if probe_report else [])
        for _ in range(args.max_revisions + args.max_watchdog_retries * 2 + 1):
            draft_artifact = saved.get("draft_artifact")
            if draft_artifact:
                draft = json.loads(engine.store.get(draft_artifact))
                if (draft.get("state") != "unreviewed" or
                        draft.get("scope_artifact") != scope["artifact"] or
                        draft.get("subject") != subject):
                    raise ValueError("saved semantic artifact does not match task")
                if (draft.get("prompt_version", 0) < SEMANTIC_PROMPT_VERSION or
                        draft.get("probe_report_artifact") != args.probe_report_artifact):
                    saved.pop("draft_artifact", None)
                    saved.pop("review_artifact", None)
                    saved.pop("pending_revision_context", None)
                    saved["revision_count"] = 0
                    draft_artifact = None
                    save()
            if not draft_artifact:
                prior_artifact = saved.get("pending_revision_context")
                advice, advice_artifact = consult("semantic", subject, saved, cases)
                result = worker.run(manifest, scope["artifact"], subject,
                                    model=args.model or (get_model(advice["model_role"])
                                                         if advice["model_role"] else None),
                                    prior_artifact=prior_artifact,
                                    probe_report_artifact=args.probe_report_artifact,
                                    guidance=advice["guidance"],
                                    watchdog_artifact=advice_artifact,
                                    evidence_bytes=advice["evidence_bytes"])
                if result["state"] != "unreviewed":
                    saved["last_failure"] = {"stage": "semantic", "state": result["state"],
                                             "artifact": result["artifact"]}
                    save()
                    retries = saved.get("semantic_watchdog_retries", 0)
                    if retries < args.max_watchdog_retries:
                        saved["semantic_watchdog_retries"] = retries + 1
                        save()
                        continue
                    failures.append({"subject": subject, **saved["last_failure"]})
                    break
                draft_artifact = result["artifact"]
                saved["draft_artifact"] = draft_artifact
                saved.pop("pending_revision_context", None)
                saved.pop("last_failure", None)
                save()
            review_artifact = saved.get("review_artifact")
            if review_artifact:
                review = json.loads(engine.store.get(review_artifact))
                if (review.get("state") != "reviewed" or
                        review.get("draft_artifact") != draft_artifact):
                    raise ValueError("saved review artifact does not match draft")
                if (review.get("prompt_version", 0) < REVIEW_PROMPT_VERSION or
                        review.get("probe_report_artifact") != args.probe_report_artifact):
                    saved.pop("review_artifact", None)
                    review_artifact = None
                    save()
            if not review_artifact:
                draft_model = json.loads(engine.store.get(draft_artifact))["model"]
                advice, advice_artifact = consult("review", subject, saved, cases,
                                                  {draft_model})
                review = reviewer.run(draft_artifact, model=args.review_model,
                                      model_role=advice["model_role"] or "decomp_reviewer",
                                      probe_report_artifact=args.probe_report_artifact,
                                      guidance=advice["guidance"],
                                      watchdog_artifact=advice_artifact)
                if review["state"] != "reviewed":
                    saved["last_failure"] = {"stage": "review", "state": review["state"],
                                             "artifact": review["artifact"]}
                    save()
                    retries = saved.get("review_watchdog_retries", 0)
                    if retries < args.max_watchdog_retries:
                        saved["review_watchdog_retries"] = retries + 1
                        save()
                        continue
                    failures.append({"subject": subject, **saved["last_failure"]})
                    break
                review_artifact = review["artifact"]
                saved["review_artifact"] = review_artifact
                saved.pop("last_failure", None)
                save()
            needs_revision = (any(item["outcome"] == "contradicted"
                                  for item in review["answer"]["reviews"]) or
                              bool(review["answer"].get("missing_behavior")))
            if (cases and needs_revision and
                    saved.get("revision_count", 0) < args.max_revisions):
                context = {"campaign": manifest["campaign"], "subject": subject,
                           "scope_artifact": scope["artifact"],
                           "state": "revision_context", "draft_artifact": draft_artifact,
                           "review_artifact": review_artifact,
                           "reason": "Resolve review contradictions and omissions against original cases",
                           "probe_cases": cases}
                saved["pending_revision_context"] = engine.store.put(
                    json.dumps(context, sort_keys=True).encode())
                saved["revision_count"] = saved.get("revision_count", 0) + 1
                saved.pop("draft_artifact", None)
                saved.pop("review_artifact", None)
                save()
                continue
            break
        if saved.get("draft_artifact"):
            drafts.append(saved["draft_artifact"])
        if saved.get("review_artifact"):
            reviews.append(saved["review_artifact"])
    gap_artifacts = []
    if probe_report:
        for function in scope["included"]:
            saved = progress["subjects"].get(function["entry"], {})
            if not saved.get("review_artifact"):
                continue
            review = json.loads(engine.store.get(saved["review_artifact"]))
            if not any(review["answer"].get(field) for field in
                       ("missing_behavior", "unresolved")):
                continue
            existing = saved.get("gap_artifact")
            if existing:
                gap = json.loads(engine.store.get(existing))
                if (gap.get("state") != "reviewed" or
                        gap.get("review_artifact") != saved["review_artifact"] or
                        gap.get("probe_report_artifact") != args.probe_report_artifact):
                    saved.pop("gap_artifact", None)
                    existing = None
                    save()
            if not existing:
                draft_model = json.loads(engine.store.get(saved["draft_artifact"]))["model"]
                review_model = review["model"]
                occupied = {draft_model, review_model}
                gap_cases = select_original_cases(engine.store, probe_report,
                                                  manifest["binary_sha256"], function["name"])
                for _ in range(args.max_watchdog_retries + 1):
                    advice, advice_artifact = consult("gap", function["entry"], saved,
                                                      gap_cases, occupied)
                    role = advice["model_role"] or next(
                        role for role in ("decomp_adjudicator", "decomp_reviewer",
                                          "decomp_watchdog") if get_model(role) not in occupied)
                    gap = gap_reviewer.run(
                        manifest, saved["draft_artifact"], saved["review_artifact"],
                        args.probe_report_artifact, function["name"],
                        model=args.gap_model or get_model(role),
                        guidance=advice["guidance"], watchdog_artifact=advice_artifact)
                    if gap["state"] == "reviewed":
                        saved.pop("last_failure", None)
                        break
                    saved["last_failure"] = {"stage": "gap_review", "state": gap["state"],
                                             "artifact": gap["artifact"]}
                    save()
                if gap["state"] != "reviewed":
                    failures.append({"subject": function["entry"], **saved["last_failure"]})
                    continue
                existing = gap["artifact"]
                saved["gap_artifact"] = existing
                save()
            gap_artifacts.append(existing)
    links = []
    if probe_report:
        for function in scope["included"]:
            saved = progress["subjects"].get(function["entry"], {})
            if not saved.get("draft_artifact") or not saved.get("review_artifact"):
                continue
            draft = json.loads(engine.store.get(saved["draft_artifact"]))
            review = json.loads(engine.store.get(saved["review_artifact"]))
            cases = select_original_cases(engine.store, probe_report,
                                          manifest["binary_sha256"], function["name"])
            supported = {item["claim_index"] for item in review["answer"]["reviews"]
                         if item["outcome"] == "supported_static"}
            for index, claim in enumerate(draft["answer"]["claims"]):
                if index not in supported:
                    continue
                matches = matching_scalar_cases(claim["statement"], cases)
                agreeing = next((item for item in matches if item["agreement"]), None)
                if agreeing is not None and all(item["agreement"] for item in matches):
                    links.append({"draft_artifact": saved["draft_artifact"],
                                  "claim_index": index,
                                  "probe_report_artifact": args.probe_report_artifact,
                                  "case_id": agreeing["case_id"],
                                  "observed_pointer": "/return",
                                  "expected_observed": agreeing["expected"],
                                  "rationale": "Restricted scalar rule predicts the "
                                               "recorded original return for this input."})
    link_artifacts = ([engine.store.put(json.dumps(
        {"schema": 1, "links": links}, sort_keys=True).encode())] if links else [])
    dossier = persist_dossier(engine, manifest, scope["artifact"], drafts, reviews,
                              [args.probe_report_artifact] if probe_report else [],
                              link_artifacts, gap_adjudication_artifacts=gap_artifacts)
    spec = persist_spec(engine.root, dossier["artifact"])
    print(json.dumps({"seed": seed_name, "scope_artifact": scope["artifact"],
                      "included": len(scope["included"]),
                      "unresolved": len(scope["unresolved"]),
                      "drafts": len(drafts), "reviews": len(reviews),
                      "probe_links": len(links),
                      "gap_reviews": len(gap_artifacts),
                      "failures": failures, "dossier_artifact": dossier["artifact"],
                      "readiness": dossier["readiness"],
                      "blocker_counts": dict(Counter(item["kind"]
                                                      for item in dossier["blockers"])),
                      "spec_artifact": spec["artifact"],
                      "spec_status": spec["status"]}, indent=2))


if __name__ == "__main__":
    main()
