"""Independent gap review from immutable artifacts without a queue lease."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.model_runtime import invoke_opencode
from engine.validation.gaps import gap_items, validate_gap_answer
from engine.validation.probes import select_original_cases
from engine.worker import parse_answer
from model_config import get_model


class IndependentGapReviewer:
    def __init__(self, engine: GhidraAnalysis, opencode: Path, *, timeout: int = 180):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout

    def run(self, manifest: dict, draft_artifact: str, review_artifact: str,
            probe_report_artifact: str, target: str, *, model: str | None = None,
            guidance: str = "", watchdog_artifact: str | None = None) -> dict:
        draft = json.loads(self.engine.store.get(draft_artifact))
        review = json.loads(self.engine.store.get(review_artifact))
        report = json.loads(self.engine.store.get(probe_report_artifact))
        evidence = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        cases = select_original_cases(self.engine.store, report,
                                      manifest["binary_sha256"], target)
        items = gap_items(review)
        if (not cases or not items or draft.get("campaign") != manifest["campaign"] or
                review.get("state") != "reviewed" or
                review.get("draft_artifact") != draft_artifact):
            raise ValueError("reviewed draft, gaps, and original cases required")
        resolved_model = get_model("decomp_adjudicator", explicit=model)
        if resolved_model in {review.get("model"), draft.get("model")}:
            raise ValueError("gap review needs a model independent of draft and review")
        prompt = (
            "Independently classify every reviewer gap as nonblocking, blocking, or "
            "uncertain for caller-visible behavior. Use raw instructions and original "
            "observations. The draft, reviewer comments, and decompilation can be wrong. "
            "A missing behavior is nonblocking only if it is already covered or does not "
            "change observable results. An unproven path remains blocking or uncertain. "
            "Return JSON {\"items\":[{\"kind\":\"missing_behavior or unresolved\","
            "\"index\":0,\"decision\":\"nonblocking or blocking or uncertain\","
            "\"reason\":\"...\",\"evidence_addresses\":[],\"probe_case_ids\":[]}]} "
            "with one item per reviewer gap. Nonblocking items need exact raw addresses "
            "or original case IDs. No markdown.\n" + json.dumps({
                "claims": draft["answer"]["claims"], "review_items": items,
                "original_cases": cases,
                "raw_evidence": {"entry": evidence["entry"],
                                 "instructions": evidence.get("instructions", []),
                                 "references": evidence.get("references", []),
                                 "decompilation": evidence.get("decompilation")}},
                separators=(",", ":")))
        if guidance:
            prompt += "\nSupervisor focus (untrusted; verify independently): " + guidance
        run_id = uuid.uuid4().hex
        folder = self.engine.root / "gap-adjudications" / run_id
        folder.mkdir(parents=True)
        (folder / "prompt.txt").write_text(prompt)
        base = {"schema": 1, "campaign": manifest["campaign"],
                "draft_artifact": draft_artifact, "review_artifact": review_artifact,
                "evidence_artifact": draft["evidence_artifact"],
                "probe_report_artifact": probe_report_artifact,
                "probe_case_ids": [case["case_id"] for case in cases],
                "watchdog_artifact": watchdog_artifact,
                "model": resolved_model, "prompt_version": 1}
        started = time.monotonic()
        revisions = []
        try:
            current_prompt = prompt
            for number in range(3):
                revision_folder = folder / f"revision-{number + 1}"
                revision_folder.mkdir()
                reply = invoke_opencode(
                    self.opencode, revision_folder, current_prompt, model=resolved_model,
                    timeout=self.timeout,
                    env_file=Path(__file__).resolve().parents[2] / ".env",
                    agent_name="native-gap-review",
                    agent_instruction="Return evidence-backed JSON only.")
                try:
                    answer = parse_answer(reply["text"])
                    errors = validate_gap_answer(answer, review, evidence, cases)
                except (ValueError, json.JSONDecodeError) as error:
                    answer = None
                    errors = [str(error)]
                revisions.append({"number": number + 1, "errors": errors,
                                  "response_artifact": self.engine.store.put(
                                      reply["text"].encode()),
                                  "transcript_artifact": self.engine.store.put(
                                      (revision_folder / "events.jsonl").read_bytes())})
                if not errors:
                    break
                current_prompt = (prompt + "\nRepair the full JSON answer using these "
                                  "validation errors: " + json.dumps(errors) +
                                  "\nPrevious answer: " + reply["text"][:16000])
            result = {**base, "state": "reviewed" if not errors else "rejected",
                      "answer": answer, "structural_errors": errors,
                      "revisions": revisions, "usage": reply["usage"],
                      "runtime_version": reply["runtime_version"]}
        except Exception as error:
            result = {**base, "state": "failed", "error": str(error),
                      "revisions": revisions}
        result["elapsed_seconds"] = round(time.monotonic() - started, 3)
        result["prompt_artifact"] = self.engine.store.put(prompt.encode())
        if revisions:
            result["transcript_artifact"] = revisions[-1]["transcript_artifact"]
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        return result
