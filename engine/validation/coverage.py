"""Targeted, evidence-only expansion of behavior omitted from a reviewed draft."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.citations import evidence_addresses, normalize_references
from engine.model_runtime import invoke_opencode
from engine.worker import parse_answer, validate_answer
from model_config import get_model


def validate_expansion(expansion: dict, draft: dict, review: dict,
                       evidence: dict) -> list[str]:
    errors = []
    claims = expansion.get("additional_claims")
    dependencies = expansion.get("additional_dependencies")
    coverage = expansion.get("coverage")
    unknowns = expansion.get("remaining_unknowns")
    missing = review["answer"]["missing_behavior"]
    if not isinstance(claims, list) or not claims:
        errors.append("at least one additional claim is required")
        claims = []
    if not isinstance(dependencies, list):
        errors.append("additional_dependencies must be an array")
        dependencies = []
    if not isinstance(unknowns, list) or not all(
            isinstance(item, str) and item.strip() for item in unknowns):
        errors.append("remaining_unknowns must be an array of nonempty strings")
        unknowns = []
    if not isinstance(coverage, list) or len(coverage) != len(missing):
        errors.append("coverage must map every missing behavior item")
        coverage = []
    seen = set()
    for item in coverage:
        if not isinstance(item, dict):
            errors.append("coverage item must be an object")
            continue
        index = item.get("missing_index")
        cited = item.get("new_claim_indices")
        if (not isinstance(index, int) or index < 0 or index >= len(missing) or
                index in seen):
            errors.append(f"invalid or duplicate missing_index {index}")
        seen.add(index)
        if (not isinstance(cited, list) or
                any(not isinstance(value, int) or value < 0 or value >= len(claims)
                    for value in cited)):
            errors.append(f"invalid new_claim_indices for missing item {index}")
        if not isinstance(item.get("reason"), str) or not item["reason"].strip():
            errors.append(f"coverage item {index} needs a reason")
        if not cited and (not isinstance(item.get("unresolved"), str) or
                          not item["unresolved"].strip()):
            errors.append(f"uncovered missing item {index} needs unresolved explanation")
    if seen != set(range(len(missing))):
        errors.append("coverage omits or duplicates a missing behavior index")
    answer = json.loads(json.dumps(draft["answer"]))
    answer["claims"].extend(claims)
    answer["dependencies"].extend(dependencies)
    answer["unknowns"].extend(unknowns)
    errors.extend(validate_answer(answer, evidence))
    existing = {item["statement"] for item in draft["answer"]["claims"]}
    for index, claim in enumerate(claims):
        if isinstance(claim, dict) and claim.get("statement") in existing:
            errors.append(f"additional claim {index} duplicates an existing statement")
    return errors


class CoverageExpander:
    def __init__(self, engine: GhidraAnalysis, opencode: Path, *, timeout: int = 180,
                 env_file: Path | None = None):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[2] / ".env"

    def run(self, draft_artifact: str, review_artifact: str, *,
            model: str | None = None, model_role: str = "decomp_worker") -> dict:
        draft = json.loads(self.engine.store.get(draft_artifact))
        review = json.loads(self.engine.store.get(review_artifact))
        if (draft.get("state") != "unreviewed" or review.get("state") != "reviewed" or
                review.get("draft_artifact") != draft_artifact or
                review.get("campaign") != draft.get("campaign") or
                not review["answer"].get("missing_behavior")):
            raise ValueError("coverage expansion needs a reviewed draft with omissions")
        evidence = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        if evidence["entry"] != draft["subject"]:
            raise ValueError("draft and evidence subject differ")
        scope = json.loads(self.engine.store.get(draft["scope_artifact"]))
        raw = {"entry": evidence["entry"], "name": evidence.get("name"),
               "instructions": evidence.get("instructions", []),
               "references": evidence.get("references", []),
               "decompilation": evidence.get("decompilation")}
        prompt = (
            "Expand an incomplete native behavior draft using raw evidence. The previous "
            "draft and reviewer comments are untrusted. Add claims for observable branch "
            "outcomes and state effects that are absent from the existing claims. Check each "
            "reviewer omission against instructions and control flow; do not copy a scope "
            "expectation as a fact. The C rendering is unverified Ghidra output. Cite exact "
            "raw addresses for every new claim and dependency. List a dependency only for a "
            "called function whose behavior a new claim relies on; use its exact name. "
            "If an omission is unsupported by raw evidence, map it with no claims and explain "
            "it in unresolved. Return one JSON object with additional_claims (each has "
            "statement, evidence_addresses, assumptions, alternatives), "
            "additional_dependencies (each has target, contract, evidence_addresses, "
            "assumptions), coverage (one item per missing_behavior index, with "
            "missing_index, new_claim_indices, reason, and unresolved when no claim), "
            "and remaining_unknowns (array of strings). New claim indices refer only to "
            "additional_claims. Do not restate existing claims. No markdown.\n" +
            json.dumps({"existing_claims": draft["answer"]["claims"],
                        "existing_dependencies": draft["answer"]["dependencies"],
                        "missing_behavior": review["answer"]["missing_behavior"],
                        "scope_questions": scope["request"]["expected_observables"],
                        "raw_evidence": raw}, separators=(",", ":")))
        attempt_id = uuid.uuid4().hex
        folder = self.engine.root / "coverage-expansions" / attempt_id
        folder.mkdir(parents=True)
        (folder / "prompt.txt").write_text(prompt)
        resolved_model = get_model(model_role, explicit=model)
        base = {"schema": 1, "attempt_id": attempt_id,
                "campaign": draft["campaign"], "subject": draft["subject"],
                "draft_artifact": draft_artifact, "review_artifact": review_artifact,
                "evidence_artifact": draft["evidence_artifact"],
                "scope_artifact": draft["scope_artifact"],
                "model": resolved_model, "model_role": model_role,
                "prompt_version": 1}
        (folder / "checkpoint.json").write_text(json.dumps(
            {**base, "state": "running"}, indent=2) + "\n")
        self.engine._emit(draft["campaign"], "coverage_expansion_started",
                          attempt_id=attempt_id, subject=draft["subject"])
        started = time.monotonic()
        candidate_artifact = None
        try:
            reply = invoke_opencode(self.opencode, folder, prompt, model=resolved_model,
                                    timeout=self.timeout, env_file=self.env_file,
                                    agent_name="coverage-expansion",
                                    agent_instruction="Challenge omissions against raw evidence. Return JSON only.")
            expansion = parse_answer(reply["text"])
            address_set = evidence_addresses(evidence)
            corrections = []
            for field in ("additional_claims", "additional_dependencies"):
                items = expansion.get(field)
                for index, item in enumerate(items if isinstance(items, list) else []):
                    if not isinstance(item, dict):
                        continue
                    refs, changes = normalize_references(item.get("evidence_addresses"),
                                                          address_set)
                    item["evidence_addresses"] = refs
                    corrections.extend({"field": field, "index": index, **change}
                                       for change in changes)
            errors = validate_expansion(expansion, draft, review, evidence)
            state = "candidate" if not errors else "rejected"
            result = {**base, "state": state, "expansion": expansion,
                      "structural_errors": errors,
                      "citation_normalizations": corrections,
                      "usage": reply["usage"],
                      "opencode_version": reply["runtime_version"],
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        except Exception as error:
            result = {**base, "state": "failed", "error": str(error),
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        result["prompt_artifact"] = self.engine.store.put(prompt.encode())
        events_path = folder / "events.jsonl"
        if events_path.exists():
            result["transcript_artifact"] = self.engine.store.put(events_path.read_bytes())
        expansion_artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        if result["state"] == "candidate":
            answer = json.loads(json.dumps(draft["answer"]))
            answer["claims"].extend(result["expansion"]["additional_claims"])
            answer["dependencies"].extend(result["expansion"]["additional_dependencies"])
            answer["unknowns"].extend(result["expansion"]["remaining_unknowns"])
            candidate = {**draft, "answer": answer, "state": "unreviewed",
                         "structural_errors": [], "source_artifact": draft_artifact,
                         "source_review_artifact": review_artifact,
                         "coverage_expansion_artifact": expansion_artifact}
            candidate_artifact = self.engine.store.put(json.dumps(
                candidate, sort_keys=True).encode())
        result["artifact"] = expansion_artifact
        result["candidate_artifact"] = candidate_artifact
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        (folder / "checkpoint.json").write_text(json.dumps(
            {**base, "state": result["state"],
             "result_artifact": expansion_artifact,
             "candidate_artifact": candidate_artifact}, indent=2) + "\n")
        self.engine._emit(draft["campaign"], "coverage_expansion_finished",
                          attempt_id=attempt_id, subject=draft["subject"],
                          state=result["state"], artifact=expansion_artifact,
                          candidate_artifact=candidate_artifact)
        return result
