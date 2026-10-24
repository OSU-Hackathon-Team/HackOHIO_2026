"""Deterministic independent review for a narrow straight-line x86 store subset."""

from __future__ import annotations

import json
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.validation.memory_ranges import review_fixed_memory_claims
from engine.validation.review import validate_review
from engine.worker import validate_answer


class FixedMemoryReviewer:
    def __init__(self, engine: GhidraAnalysis):
        self.engine = engine

    def run(self, draft_artifact: str) -> dict:
        draft = json.loads(self.engine.store.get(draft_artifact))
        if draft.get("state") != "unreviewed":
            raise ValueError("fixed memory review needs a structurally valid draft")
        evidence = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        if evidence.get("entry") != draft.get("subject"):
            raise ValueError("draft and evidence subject differ")
        if validate_answer(draft["answer"], evidence):
            raise ValueError("draft fails current claim validation")
        answer = review_fixed_memory_claims(draft["answer"]["claims"], evidence)
        errors = validate_review(answer, evidence, len(draft["answer"]["claims"]))
        counts = {kind: sum(item["outcome"] == kind for item in answer["reviews"])
                  for kind in ("supported_static", "contradicted", "uncertain")}
        result = {"schema": 1, "review_id": uuid.uuid4().hex,
                  "campaign": draft["campaign"], "draft_artifact": draft_artifact,
                  "evidence_artifact": draft["evidence_artifact"],
                  "subject": draft["subject"],
                  "model": "deterministic/x86-fixed-memory-v1",
                  "review_method": "fixed_absolute_memory_stores",
                  "state": "reviewed" if not errors else "rejected",
                  "answer": answer, "structural_errors": errors,
                  "outcomes": {kind: count for kind, count in counts.items() if count},
                  "usage": {"input": 0, "output": 0, "reasoning": 0, "cost": 0}}
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        self.engine._emit(draft["campaign"], "review_finished",
                          review_id=result["review_id"], subject=draft["subject"],
                          status=result["state"], artifact=artifact,
                          method=result["review_method"])
        return result
