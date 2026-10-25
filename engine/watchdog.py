"""Persistent model supervisor for native analysis attempts.

The watchdog may change the next agent's instructions, model, or evidence budget.
It cannot write a draft, alter observations, or grant readiness.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import uuid

from engine.model_runtime import invoke_opencode
from engine.worker import parse_answer
from model_config import get_model

STAGES = {"semantic", "review", "gap", "spec", "implementation"}
MAX_GUIDANCE = 1800
ALLOWED_ROLES = {
    "semantic": {"decomp_worker", "decomp_adjudicator", "decomp_watchdog"},
    "review": {"decomp_reviewer", "decomp_adjudicator", "decomp_watchdog"},
    "gap": {"decomp_adjudicator", "decomp_reviewer", "decomp_watchdog"},
    "spec": {"spec_writer", "decomp_watchdog"},
    "implementation": {"engine_writer", "decomp_watchdog"},
}


def _digest(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def _validate(answer: dict, stage: str, occupied_models: set[str]) -> dict:
    if set(answer) != {"diagnosis", "guidance", "model_role", "evidence_bytes"}:
        raise ValueError("watchdog response has wrong fields")
    diagnosis, guidance = answer["diagnosis"], answer["guidance"]
    if not isinstance(diagnosis, str) or not diagnosis.strip() or len(diagnosis) > 1000:
        raise ValueError("watchdog diagnosis must be a short nonempty string")
    if not isinstance(guidance, str) or len(guidance) > MAX_GUIDANCE:
        raise ValueError("watchdog guidance is too long")
    role = answer["model_role"]
    allowed = ALLOWED_ROLES[stage]
    if role is not None and (not isinstance(role, str) or role not in allowed):
        raise ValueError("watchdog selected an unsupported model role")
    if role and get_model(role) in occupied_models:
        raise ValueError("watchdog selected a model that saw the draft or review")
    budget = answer["evidence_bytes"] if stage == "semantic" else None
    if budget is not None and (not isinstance(budget, int)
                               or isinstance(budget, bool) or not 16000 <= budget <= 120000):
        raise ValueError("watchdog evidence budget is invalid")
    return {"diagnosis": diagnosis.strip(), "guidance": guidance.strip(),
            "model_role": role, "evidence_bytes": budget}


class Watchdog:
    def __init__(self, engine, opencode: Path, *, timeout: int = 180,
                 env_file: Path | None = None):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[1] / ".env"

    def inspect(self, *, campaign: str, scope_artifact: str, subject: str,
                stage: str, snapshot: dict, previous_artifact: str | None = None,
                occupied_models: set[str] | None = None) -> dict:
        if stage not in STAGES:
            raise ValueError("unknown watchdog stage")
        occupied = occupied_models or set()
        input_record = {"campaign": campaign, "scope_artifact": scope_artifact,
                        "subject": subject, "stage": stage, "snapshot": snapshot,
                        "occupied_models": sorted(occupied)}
        fingerprint = _digest(input_record)
        if previous_artifact:
            prior = json.loads(self.engine.store.get(previous_artifact))
            if prior.get("fingerprint") == fingerprint:
                prior["artifact"] = previous_artifact
                return prior
        default_role = {"semantic": "decomp_worker", "review": "decomp_reviewer",
                        "gap": "decomp_adjudicator", "spec": "spec_writer",
                        "implementation": "engine_writer"}[stage]
        fallback = {"diagnosis": "No valid watchdog intervention was available.",
                    "guidance": "", "model_role": None, "evidence_bytes": None}
        folder = self.engine.root / "watchdog" / uuid.uuid4().hex
        folder.mkdir(parents=True)
        prompt = (
            "Examine this native analysis checkpoint. Keep the analysis autonomous. "
            "Find the next concrete correction based on actual failure, review, and original "
            "observations. Favor caller-visible behavior; C++ layout and ABI are not required "
            "by a clean-room C implementation. You may tune prompt guidance, route the next "
            "agent to one of the allowed model roles, and for semantic work choose an evidence "
            "budget from 16000 to 120000 bytes. For every other stage, evidence_bytes must "
            "be null. You cannot change evidence, probe outcomes, "
            "claims, citations, or acceptance rules. Keep guidance short and specific. "
            "Respond with exactly one JSON object with keys diagnosis (string), guidance "
            "(string), model_role (allowed role string or null), evidence_bytes (integer or "
            "null). Null model_role keeps the default agent. Null evidence_bytes keeps its "
            "existing budget. Do not copy observed answers into guidance.\n"
            f"Stage: {stage}\nDefault role: {default_role}\n"
            f"Allowed model roles: {sorted(ALLOWED_ROLES[stage])}\n"
            f"Occupied models for independent review: {sorted(occupied)}\n"
            f"Checkpoint: {json.dumps(input_record, sort_keys=True, default=str)[:24000]}"
        )
        (folder / "prompt.txt").write_text(prompt)
        model = get_model("decomp_watchdog")
        try:
            reply = invoke_opencode(self.opencode, folder, prompt, model=model,
                                    timeout=self.timeout, env_file=self.env_file,
                                    agent_name="decomp-watchdog",
                                    agent_instruction="You are a supervisor of evidence-driven agents. Return only valid JSON.")
            intervention = _validate(parse_answer(reply["text"]), stage, occupied)
            state, error = "ready", None
        except Exception as exc:
            intervention = fallback
            state, error = "failed", str(exc)
        record = {"schema": 1, "fingerprint": fingerprint, "state": state,
                  "model": model, "input": input_record, "intervention": intervention,
                  "error": error}
        record["artifact"] = self.engine.store.put(json.dumps(record, sort_keys=True).encode())
        (folder / "result.json").write_text(json.dumps(record, indent=2) + "\n")
        return record
