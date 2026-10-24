"""Independent adjudication of reviewer-raised observable-behavior gaps."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.citations import evidence_addresses, normalize_references
from engine.model_runtime import invoke_opencode
from engine.queue import DurableQueue
from engine.worker import parse_answer
from model_config import get_model


def gap_items(review: dict) -> list[dict]:
    return [{"kind": kind, "index": index, "description": description}
            for kind in ("missing_behavior", "unresolved")
            for index, description in enumerate(review["answer"].get(kind, []))]


def validate_gap_answer(answer: dict, review: dict, evidence: dict,
                        probe_cases: list[dict]) -> list[str]:
    if not isinstance(answer, dict) or not isinstance(answer.get("items"), list):
        return ["gap answer needs an items array"]
    expected = {(item["kind"], item["index"]) for item in gap_items(review)}
    actual = set()
    errors = []
    addresses = evidence_addresses(evidence)
    case_ids = {item["case_id"] for item in probe_cases}
    if len(answer["items"]) != len(expected):
        errors.append("gap answer must classify every review item exactly once")
    for item in answer["items"]:
        if not isinstance(item, dict):
            errors.append("gap item must be an object")
            continue
        key = (item.get("kind"), item.get("index"))
        if key not in expected or key in actual:
            errors.append(f"unknown or duplicate gap item {key}")
        actual.add(key)
        if item.get("decision") not in {"nonblocking", "blocking", "uncertain"}:
            errors.append(f"gap item {key} has invalid decision")
        if not isinstance(item.get("reason"), str) or not item["reason"].strip():
            errors.append(f"gap item {key} needs a reason")
        refs = item.get("evidence_addresses")
        probes = item.get("probe_case_ids")
        if not isinstance(refs, list) or any(
                not isinstance(value, str) or value not in addresses for value in refs):
            errors.append(f"gap item {key} cites invalid evidence")
        if not isinstance(probes, list) or any(
                not isinstance(value, str) or value not in case_ids for value in probes):
            errors.append(f"gap item {key} cites invalid probe case")
        if item.get("decision") == "nonblocking" and not (refs or probes):
            errors.append(f"nonblocking gap item {key} needs evidence")
    if actual != expected:
        errors.append("gap answer omits or duplicates review items")
    return errors


def select_original_cases(store, report: dict, binary_sha256: str,
                          target: str | None) -> list[dict]:
    if (report.get("schema") != 1 or not isinstance(report.get("results"), list) or
            not target):
        return []
    selected = []
    for item in report["results"]:
        if (item.get("target") != target or
                item.get("binary_sha256") != binary_sha256 or
                item.get("execution_mode") != "original" or
                item.get("outcome") != "agreement"):
            continue
        try:
            original = json.loads(store.get(item["artifact"]))
        except (ValueError, KeyError, TypeError, FileNotFoundError):
            return []
        if any(original.get(key) != item.get(key) for key in
               ("case_id", "target", "binary_sha256", "input", "observed",
                "outcome", "execution_mode", "runner_sha256", "adapter_sha256")):
            return []
        selected.append({"case_id": item["case_id"], "input": item["input"],
                         "observed": item["observed"], "artifact": item["artifact"]})
    return selected


def matching_original_cases(queue: DurableQueue, task: dict, report: dict,
                            scope: dict) -> list[dict]:
    names = {item["entry"]: item["name"] for item in scope["included"]}
    with queue._connect() as conn:
        campaign = conn.execute("SELECT binary_sha256 FROM decomp_campaigns WHERE id = %s",
                                (task["campaign_id"],)).fetchone()
    if campaign is None:
        return []
    return select_original_cases(queue.store, report, campaign["binary_sha256"],
                                 names.get(task["subject"]))


class GapAdjudicator:
    def __init__(self, engine: GhidraAnalysis, queue: DurableQueue, opencode: Path,
                 *, timeout: int = 180, env_file: Path | None = None):
        self.engine = engine
        self.queue = queue
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[2] / ".env"

    def run(self, task_id: str, probe_report_artifact: str, *, model: str | None = None,
            model_role: str = "legal_verification") -> dict:
        task = self.queue.task(task_id)
        if task is None or task["state"] != "needs_reconciliation":
            raise ValueError("gap adjudication requires a reviewed reconciliation task")
        draft = json.loads(self.engine.store.get(task["result_artifact"]))
        review = json.loads(self.engine.store.get(task["review_artifact"]))
        evidence = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        scope = json.loads(self.engine.store.get(draft["scope_artifact"]))
        report = json.loads(self.engine.store.get(probe_report_artifact))
        cases = matching_original_cases(self.queue, task, report, scope)
        items = gap_items(review)
        if (not cases or not items or review.get("state") != "reviewed" or
                review.get("draft_artifact") != task["result_artifact"] or
                draft["campaign"] != task["campaign_id"] or
                evidence["entry"] != task["subject"]):
            raise ValueError("matching original cases and current reviewed gaps required")
        resolved_model = get_model(model_role, explicit=model)
        if resolved_model == review.get("model"):
            raise ValueError("gap adjudicator must use a different model from the reviewer")
        raw = {"entry": evidence["entry"], "name": evidence.get("name"),
               "instructions": evidence.get("instructions", []),
               "references": evidence.get("references", []),
               "decompilation": evidence.get("decompilation")}
        prompt = (
            "Independently adjudicate each reviewer comment about this native function. "
            "The draft and review comments can be wrong. Use the raw instructions and "
            "original-execution observations. Mark an item nonblocking only if it adds no "
            "missing observable behavior needed for the declared scope. An unproven path "
            "or consequential uncertainty is blocking or uncertain. Register bookkeeping "
            "is not an observable effect unless it changes an output or state. Do not infer "
            "untested behavior from probes alone. Return one JSON object with items array; "
            "each item has kind, index, decision (nonblocking, blocking, uncertain), reason, "
            "evidence_addresses, probe_case_ids. Classify every listed item once. Cite exact "
            "raw addresses or matching probe case IDs for nonblocking decisions. No markdown.\n" +
            json.dumps({"claims": draft["answer"]["claims"],
                        "review_items": items, "original_cases": cases,
                        "raw_evidence": raw}, separators=(",", ":")))
        attempt_id = uuid.uuid4().hex
        folder = self.engine.root / "gap-adjudications" / attempt_id
        folder.mkdir(parents=True)
        (folder / "prompt.txt").write_text(prompt)
        base = {"schema": 1, "attempt_id": attempt_id,
                "campaign": task["campaign_id"], "task_id": task_id,
                "draft_artifact": task["result_artifact"],
                "review_artifact": task["review_artifact"],
                "evidence_artifact": draft["evidence_artifact"],
                "probe_report_artifact": probe_report_artifact,
                "probe_case_ids": [case["case_id"] for case in cases],
                "model": resolved_model, "model_role": model_role,
                "prompt_version": 1}
        (folder / "checkpoint.json").write_text(json.dumps({**base, "state": "running"},
                                                           indent=2) + "\n")
        self.engine._emit(task["campaign_id"], "gap_adjudication_started",
                          attempt_id=attempt_id, task_id=task_id)
        started = time.monotonic()
        try:
            reply = invoke_opencode(self.opencode, folder, prompt, model=resolved_model,
                                    timeout=self.timeout, env_file=self.env_file,
                                    agent_name="gap-adjudication",
                                    agent_instruction="Challenge review gaps against raw and original evidence. Return JSON only.")
            answer = parse_answer(reply["text"])
            corrections = []
            for index, item in enumerate(answer.get("items", [])):
                if not isinstance(item, dict):
                    continue
                refs, changes = normalize_references(
                    item.get("evidence_addresses"), evidence_addresses(evidence))
                item["evidence_addresses"] = refs
                corrections.extend({"item_index": index, **change} for change in changes)
            errors = validate_gap_answer(answer, review, evidence, cases)
            result = {**base, "state": "reviewed" if not errors else "rejected",
                      "answer": answer, "structural_errors": errors,
                      "citation_normalizations": corrections,
                      "usage": reply["usage"],
                      "opencode_version": reply["runtime_version"],
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        except Exception as error:
            result = {**base, "state": "failed", "error": str(error),
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        result["prompt_artifact"] = self.engine.store.put(prompt.encode())
        events = folder / "events.jsonl"
        if events.exists():
            result["transcript_artifact"] = self.engine.store.put(events.read_bytes())
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        (folder / "checkpoint.json").write_text(json.dumps(
            {**base, "state": result["state"], "result_artifact": artifact},
            indent=2) + "\n")
        self.engine._emit(task["campaign_id"], "gap_adjudication_finished",
                          attempt_id=attempt_id, task_id=task_id,
                          state=result["state"], artifact=artifact)
        return result
