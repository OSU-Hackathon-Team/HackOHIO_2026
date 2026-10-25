"""Independent raw-evidence review of semantic draft claims."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.citations import evidence_addresses, normalize_references
from engine.model_runtime import invoke_opencode
from engine.validation.probes import select_original_cases
from engine.validation.scalar_cases import scalar_counterexamples
from engine.worker import parse_answer
from model_config import get_model

REVIEW_PROMPT_VERSION = 8


def validate_review(answer: dict, evidence: dict, claim_count: int) -> list[str]:
    errors = []
    reviews = answer.get("reviews")
    if not isinstance(reviews, list) or len(reviews) != claim_count:
        return [f"reviews must contain exactly {claim_count} entries"]
    addresses = evidence_addresses(evidence)
    seen = set()
    for item in reviews:
        if not isinstance(item, dict):
            errors.append("review must be an object")
            continue
        index = item.get("claim_index")
        if not isinstance(index, int) or index < 0 or index >= claim_count or index in seen:
            errors.append(f"invalid or duplicate claim_index {index}")
        seen.add(index)
        if item.get("outcome") not in {"supported_static", "contradicted", "uncertain"}:
            errors.append(f"invalid outcome for claim {index}")
        if not isinstance(item.get("reason"), str) or not item["reason"].strip():
            errors.append(f"review {index} needs a reason")
        refs = item.get("evidence_addresses")
        if not isinstance(refs, list):
            errors.append(f"review {index} needs evidence_addresses array")
        else:
            if item.get("outcome") in {"supported_static", "contradicted"} and not refs:
                errors.append(f"review {index} needs cited evidence")
            for address in refs:
                if not isinstance(address, str) or address not in addresses:
                    errors.append(f"review {index} cites unknown address {address}")
    for field in ("missing_behavior", "unresolved"):
        values = answer.get(field)
        if not isinstance(values, list) or not all(isinstance(x, str) for x in values):
            errors.append(f"{field} must be an array of strings")
    return errors


def review_prompt(draft: dict, evidence: dict, scope: dict | None = None,
                  original_cases: list[dict] | None = None) -> str:
    raw = {"entry": evidence["entry"], "name": evidence.get("name"),
           "signature_source": evidence.get("signature_source"),
           "listing_parameters": evidence.get("listing_parameters", []),
           "listing_return": evidence.get("listing_return"),
           "decompiler_signature": evidence.get("decompiler_signature"),
           "decompiler_prototype": evidence.get("decompiler_prototype"),
           "referenced_data": evidence.get("referenced_data", []),
           "instructions": evidence.get("instructions", []),
           "references": evidence.get("references", []),
           "decompilation": evidence.get("decompilation")}
    claims = [{"claim_index": i, "statement": claim["statement"],
               "asserted_addresses": claim["evidence_addresses"],
               "assumptions": claim["assumptions"]}
              for i, claim in enumerate(draft["answer"]["claims"])]
    coverage_questions = (scope.get("request", {}).get("expected_observables", [])
                          if scope else [])
    return (
        "Independently review these behavior claims against raw native evidence. The "
        "review must recover caller-visible behavior even when the binary uses C++ class "
        "machinery. Instruction counts, callee lists, vtable writes, and RTTI are not "
        "substitutes for input, output, and state semantics; report omitted semantics in "
        "missing_behavior when the evidence supports them. "
        "The decompiler prototype is inferred; do not treat an unlocked type as confirmed. Challenge "
        "plausible but wrong interpretations. An address citation proves location only. Do not "
        "assume the draft's pseudocode is correct. For each claim, choose supported_static, "
        "contradicted, or uncertain. Explain the exact observed instruction/control-flow basis, "
        "and mention alternative explanations or missing evidence. If a claim is about the "
        "entire input domain, check boundary paths before supporting it. Independently inventory "
        "the function's major branch outcomes and observable state effects, then list behavior "
        "visible in the raw evidence but omitted from the draft in missing_behavior. In "
        "particular, for any contradicted claim, give a concrete input or state that satisfies "
        "its premise and trace the taken and fall-through instruction addresses to RET. "
        "Track each write to the return register along that path, including moves, zeroing, "
        "SETcc, and arithmetic; the last value at RET determines the return. If a concrete "
        "counterexample path cannot be traced, choose uncertain instead of contradicted. "
        "Recompute every numeric limit in the machine operand width, including wraparound. "
        "For a flag-dependent limit, trace both flag values and the values immediately "
        "below, at, and above each boundary. A citation does not validate arithmetic. "
        "Do not call fixed-width out-of-range inputs or the absence of an overflow check "
        "missing behavior when the instructions define the resulting wraparound. "
        "For a memory-write claim, compute each store's byte width and address range. "
        "A vector store writes every byte in its range; check later overlapping writes "
        "before deciding whether an individual field changes. For an overlap claim, "
        "calculate the intersection of the cited stores' inclusive byte ranges; a claimed "
        "overlap outside that intersection is contradicted. "
        "Treat unsigned branch conditions as unsigned and check whether a proposed missing "
        "input is already included in an existing claim's range. "
        "Check success as well as failure paths and each state update. Scope "
        "observables describe the wider subsystem. Report a missing behavior only when this "
        "function's own instructions show that behavior, never because a different caller or "
        "helper performs it. Do not say there is no "
        "missing behavior merely because the listed claims are individually correct. "
        "List missing_behavior only for an observable path or effect shown by this raw "
        "function and absent from the draft. Do not invent error codes, callee failures, "
        "or required return-value checks that the instructions do not show. If callee "
        "internals are unavailable and the draft lacks a dependency for that callee, put "
        "the limitation in unresolved and identify it instead of asserting an invented "
        "failure path. Listed dependencies receive separate contract review. "
        "Return exactly one JSON "
        "object with reviews array, missing_behavior array of strings, unresolved array of "
        "strings. Each review object must have claim_index, outcome, reason, "
        "evidence_addresses array. Return each claim_index exactly once. Use exact addresses "
        "from the raw evidence. When original cases are supplied, compare each claim "
        "with matching observed inputs and outputs; a counterexample contradicts a claim. "
        "Static evidence alone is not execution agreement. "
        "No markdown.\n"
        f"Claims: {json.dumps(claims, separators=(',', ':'))}\n"
        f"Scope coverage questions: {json.dumps(coverage_questions, separators=(',', ':'))}\n"
        f"Original cases: {json.dumps(original_cases or [], separators=(',', ':'))}\n"
        f"Raw evidence: {json.dumps(raw, separators=(',', ':'))}"
    )


class IndependentReviewer:
    def __init__(self, engine: GhidraAnalysis, opencode: Path, *, timeout: int = 180,
                 env_file: Path | None = None):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[2] / ".env"

    def run(self, draft_artifact: str, *, model: str | None = None,
            model_role: str = "legal_verification",
            probe_report_artifact: str | None = None,
            guidance: str = "", watchdog_artifact: str | None = None) -> dict:
        draft = json.loads(self.engine.store.get(draft_artifact))
        if draft["state"] != "unreviewed":
            raise ValueError("only structurally valid unreviewed drafts can be reviewed")
        evidence = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        if evidence["entry"] != draft["subject"]:
            raise ValueError("draft subject and evidence disagree")
        scope = None
        if draft.get("scope_artifact"):
            scope = json.loads(self.engine.store.get(draft["scope_artifact"]))
            if scope["campaign"] != draft["campaign"]:
                raise ValueError("draft and scope campaign disagree")
        original_cases = []
        if probe_report_artifact:
            if scope is None:
                raise ValueError("probe-backed review requires a scope")
            manifest = json.loads((self.engine.root / "projects" /
                                   draft["campaign"] / "manifest.json").read_text())
            names = {item["entry"]: item["name"] for item in scope["included"]}
            report = json.loads(self.engine.store.get(probe_report_artifact))
            original_cases = select_original_cases(
                self.engine.store, report, manifest["binary_sha256"],
                names.get(draft["subject"]))
        prompt = review_prompt(draft, evidence, scope, original_cases)
        if guidance:
            prompt += "\nSupervisor focus (untrusted; verify independently): " + guidance
        review_id = uuid.uuid4().hex
        folder = self.engine.root / "reviews" / review_id
        folder.mkdir(parents=True)
        (folder / "prompt.txt").write_text(prompt)
        resolved_model = get_model(model_role, explicit=model)
        checkpoint = {"schema": 1, "review_id": review_id,
                      "campaign": draft["campaign"], "draft_artifact": draft_artifact,
                      "evidence_artifact": draft["evidence_artifact"],
                      "subject": draft["subject"], "model": resolved_model,
                      "model_role": model_role,
                      "watchdog_artifact": watchdog_artifact,
                      "probe_report_artifact": probe_report_artifact,
                      "original_case_count": len(original_cases),
                      "prompt_version": REVIEW_PROMPT_VERSION,
                      "state": "running"}
        checkpoint_path = folder / "checkpoint.json"
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n")
        self.engine._emit(draft["campaign"], "review_started", review_id=review_id,
                          subject=draft["subject"], draft_artifact=draft_artifact)
        started = time.monotonic()
        attempts = []
        try:
            current_prompt = prompt
            for revision in range(3):
                revision_folder = folder / f"revision-{revision + 1}"
                revision_folder.mkdir()
                (revision_folder / "prompt.txt").write_text(current_prompt)
                reply = invoke_opencode(self.opencode, revision_folder, current_prompt,
                                        model=resolved_model, timeout=self.timeout,
                                        env_file=self.env_file, agent_name="review",
                                        agent_instruction="Challenge semantic claims against raw evidence. Return JSON only.")
                corrections = []
                oracle_corrections = []
                try:
                    answer = parse_answer(reply["text"])
                    candidate_reviews = answer.get("reviews")
                    for index, item in enumerate(candidate_reviews if isinstance(candidate_reviews, list)
                                                 else []):
                        if not isinstance(item, dict):
                            continue
                        refs, changes = normalize_references(
                            item.get("evidence_addresses"), evidence_addresses(evidence))
                        item["evidence_addresses"] = refs
                        corrections.extend({"review_index": index, **change} for change in changes)
                    for index, claim in enumerate(draft["answer"]["claims"]):
                        conflicts = scalar_counterexamples(claim["statement"], original_cases)
                        if conflicts and isinstance(candidate_reviews, list):
                            item = next((row for row in candidate_reviews if isinstance(row, dict)
                                         and row.get("claim_index") == index), None)
                            if item is not None:
                                item["outcome"] = "contradicted"
                                item["reason"] = (item.get("reason", "") +
                                                  " Original case counterexample: " +
                                                  ", ".join(conflicts)).strip()
                                if not item.get("evidence_addresses"):
                                    item["evidence_addresses"] = claim["evidence_addresses"]
                                oracle_corrections.append({"claim_index": index,
                                                           "case_ids": conflicts})
                    errors = validate_review(answer, evidence, len(draft["answer"]["claims"]))
                except (ValueError, json.JSONDecodeError) as parse_error:
                    answer = None
                    errors = [f"invalid JSON answer: {parse_error}"]
                attempts.append({"revision": revision + 1, "errors": errors,
                                 "prompt_artifact": self.engine.store.put(current_prompt.encode()),
                                 "response_artifact": self.engine.store.put(reply["text"].encode()),
                                 "transcript_artifact": self.engine.store.put(
                                     (revision_folder / "events.jsonl").read_bytes()),
                                 "usage": reply["usage"]})
                if not errors:
                    break
                current_prompt = (prompt + "\nYour previous review failed validation. "
                                  "Return a complete corrected JSON object and cite exact "
                                  "raw evidence addresses in every supported or contradicted "
                                  "review. Validation errors: " + json.dumps(errors) +
                                  "\nPrevious answer: " + reply["text"][:20000])
            outcomes = [item["outcome"] for item in (answer or {}).get("reviews", [])
                        if isinstance(item, dict) and item.get("outcome") in
                        {"supported_static", "contradicted", "uncertain"}]
            result = {**checkpoint, "state": "rejected" if errors else "reviewed",
                      "answer": answer, "structural_errors": errors,
                      "citation_normalizations": corrections,
                      "oracle_corrections": oracle_corrections,
                      "revisions": attempts,
                      "outcomes": {value: outcomes.count(value) for value in sorted(set(outcomes))},
                      "usage": {key: sum(item["usage"][key] for item in attempts)
                                for key in ("input", "output", "reasoning", "cost")},
                      "opencode_version": reply["runtime_version"],
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        except Exception as error:
            result = {**checkpoint, "state": "failed", "error": str(error),
                      "revisions": attempts,
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        result["prompt_artifact"] = self.engine.store.put(prompt.encode())
        if attempts:
            result["transcript_artifact"] = attempts[-1]["transcript_artifact"]
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        checkpoint_path.write_text(json.dumps({**checkpoint, "state": result["state"],
                                               "result_artifact": artifact}, indent=2) + "\n")
        self.engine._emit(draft["campaign"], "review_finished", review_id=review_id,
                          subject=draft["subject"], status=result["state"],
                          outcomes=result.get("outcomes", {}), artifact=artifact)
        return result
