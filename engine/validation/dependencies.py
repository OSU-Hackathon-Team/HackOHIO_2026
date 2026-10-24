"""Independent review of a caller dependency against a pinned helper contract."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.model_runtime import invoke_opencode
from engine.queue import DurableQueue
from engine.worker import parse_answer
from model_config import get_model


def evidence_addresses(evidence: dict) -> set[str]:
    addresses = {evidence["entry"]}
    addresses.update(item["address"] for item in evidence.get("instructions", []))
    for item in evidence.get("references", []):
        addresses.update((item["from"], item["to"]))
    return addresses


def validate_dependency_review(answer: dict, caller: dict, callee: dict) -> list[str]:
    if not isinstance(answer, dict):
        return ["dependency review answer must be an object"]
    errors = []
    if answer.get("outcome") not in {"supported_static", "contradicted", "uncertain"}:
        errors.append("outcome must be supported_static, contradicted, or uncertain")
    if not isinstance(answer.get("reason"), str) or not answer["reason"].strip():
        errors.append("reason must be a nonempty string")
    missing = answer.get("missing_info")
    if not isinstance(missing, list) or not all(isinstance(x, str) for x in missing):
        errors.append("missing_info must be an array of strings")
    if answer.get("outcome") == "supported_static" and missing:
        errors.append("supported dependency cannot have missing_info")
    refs = answer.get("evidence_addresses")
    addresses = evidence_addresses(caller) | evidence_addresses(callee)
    if not isinstance(refs, list) or (answer.get("outcome") != "uncertain" and not refs):
        errors.append("review needs evidence_addresses")
    elif isinstance(refs, list):
        caller_addresses = evidence_addresses(caller)
        callee_addresses = evidence_addresses(callee)
        if answer.get("outcome") == "supported_static" and (
                not any(address in caller_addresses for address in refs) or
                not any(address in callee_addresses for address in refs)):
            errors.append("supported dependency must cite caller and callee evidence")
        for address in refs:
            if not isinstance(address, str) or address not in addresses:
                errors.append(f"unknown evidence address {address}")
    return errors


class IndependentDependencyReviewer:
    def __init__(self, engine: GhidraAnalysis, queue: DurableQueue, opencode: Path,
                 *, timeout: int = 180, max_evidence_bytes: int = 60000,
                 env_file: Path | None = None):
        self.engine = engine
        self.queue = queue
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.max_evidence_bytes = max_evidence_bytes
        self.env_file = env_file or Path(__file__).resolve().parents[2] / ".env"

    def run(self, task_id: str, dependency_index: int, *, model: str | None = None,
            model_role: str = "legal_verification") -> dict:
        task = self.queue.task(task_id)
        if task is None or task["state"] != "needs_reconciliation":
            raise ValueError("dependency review requires a task awaiting reconciliation")
        draft = json.loads(self.engine.store.get(task["result_artifact"]))
        dependencies = draft["answer"]["dependencies"]
        if dependency_index < 0 or dependency_index >= len(dependencies):
            raise ValueError("dependency index outside draft")
        dependency = dependencies[dependency_index]
        key = dependency["target"]
        with self.queue._connect() as conn:
            head = conn.execute("SELECT version, artifact, state FROM decomp_contract_heads "
                                "WHERE campaign_id = %s AND contract_key = %s",
                                (task["campaign_id"], key)).fetchone()
        if head is None or head["state"] != "active" or head["version"] < 1:
            raise ValueError(f"active helper contract unavailable: {key}")
        contract = json.loads(self.engine.store.get(head["artifact"]))
        if (contract["campaign"] != task["campaign_id"] or
                contract["contract_key"] != key):
            raise ValueError("helper contract identity mismatch")
        caller = json.loads(self.engine.store.get(draft["evidence_artifact"]))
        callee = json.loads(self.engine.store.get(contract["evidence_artifact"]))
        raw = {"caller": caller, "callee": callee, "dependency": dependency,
               "helper_contract": contract}
        encoded = json.dumps(raw, separators=(",", ":"))
        if len(encoded.encode()) > self.max_evidence_bytes:
            raise ValueError("dependency evidence exceeds review context budget")
        prompt = (
            "Independently check this caller's claimed dependency contract against raw "
            "caller and callee evidence and the separately accepted helper claim. The helper "
            "claim is static support, not a complete oracle. Decide supported_static, "
            "contradicted, or uncertain. Do not infer behavior absent from the instructions. "
            "Return one JSON object with outcome, reason, evidence_addresses, and "
            "missing_info (array of strings). Cite exact addresses from either function. "
            "A supported result means this particular dependency statement is compatible "
            "with the pinned helper evidence; it does not prove all subsystem behavior. "
            "No markdown.\n" + encoded)
        review_id = uuid.uuid4().hex
        folder = self.engine.root / "dependency-reviews" / review_id
        folder.mkdir(parents=True)
        (folder / "prompt.txt").write_text(prompt)
        resolved_model = get_model(model_role, explicit=model)
        base = {"schema": 1, "review_id": review_id,
                "campaign": task["campaign_id"], "task_id": task_id,
                "draft_artifact": task["result_artifact"],
                "dependency_index": dependency_index, "target": key,
                "contract_key": key, "contract_version": head["version"],
                "contract_artifact": head["artifact"],
                "caller_evidence_artifact": draft["evidence_artifact"],
                "callee_evidence_artifact": contract["evidence_artifact"],
                "model": resolved_model, "model_role": model_role}
        (folder / "checkpoint.json").write_text(json.dumps({**base, "state": "running"},
                                                           indent=2) + "\n")
        self.engine._emit(task["campaign_id"], "dependency_review_started",
                          review_id=review_id, task_id=task_id,
                          dependency_index=dependency_index)
        started = time.monotonic()
        try:
            reply = invoke_opencode(self.opencode, folder, prompt, model=resolved_model,
                                    timeout=self.timeout, env_file=self.env_file,
                                    agent_name="dependency-review",
                                    agent_instruction="Challenge caller contract against both raw functions. Return JSON only.")
            answer = parse_answer(reply["text"])
            errors = validate_dependency_review(answer, caller, callee)
            result = {**base, "state": "reviewed" if not errors else "rejected",
                      "answer": answer, "structural_errors": errors,
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
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        result["queue_recorded"] = self.queue.record_dependency_review(task_id, artifact)
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        (folder / "checkpoint.json").write_text(json.dumps(
            {**base, "state": result["state"], "result_artifact": artifact}, indent=2) + "\n")
        self.engine._emit(task["campaign_id"], "dependency_review_finished",
                          review_id=review_id, task_id=task_id,
                          dependency_index=dependency_index,
                          outcome=result.get("answer", {}).get("outcome"),
                          state=result["state"], artifact=artifact)
        return result
