"""Blind claim-to-case links: predict an original case's result from a claim, then compare.

The linker sees reviewed claims and the inputs of cases that actually entered the claim's
function at runtime, never the observed results. A link agrees only when its prediction
matches what the original program produced, so agreement is execution evidence rather than
a model's say-so. Held-out cases must never be passed in.
"""

from __future__ import annotations

import json
from pathlib import Path
import time
from typing import Callable
import uuid

from engine.model_runtime import invoke_opencode
from engine.worker import parse_answer
from model_config import get_model

LINK_PROMPT_VERSION = 1


def link_prompt(claims: list[dict], cases: list[dict], observation_format: str) -> str:
    return (
        "You link behavior claims about one function of a native program to concrete test "
        "cases of the original program. Every listed case is known to have executed this "
        "function. For each claim, decide which cases have a result that the claim alone "
        "determines. For those cases only, predict the exact result the claim implies. Do not "
        "use general knowledge of the program to fill in what the claim does not state: if "
        "the claim does not determine the whole result of a case, do not link that case. A "
        "claim may link to no cases. "
        f"Results have this format: {observation_format} "
        "Return exactly one JSON object with a links array. Each link has claim_index, "
        "case_id, predicted (a result object in the format above) and rationale (one sentence "
        "saying how the claim determines that result). No markdown.\n"
        f"Claims: {json.dumps(claims, separators=(',', ':'))}\n"
        f"Cases: {json.dumps(cases, separators=(',', ':'))}"
    )


def validate_links(answer: dict, claim_indexes: set[int], case_ids: set[str]) -> list[str]:
    links = answer.get("links") if isinstance(answer, dict) else None
    if not isinstance(links, list):
        return ["links must be an array"]
    errors, seen = [], set()
    for item in links:
        if not isinstance(item, dict):
            errors.append("link must be an object")
            continue
        key = (item.get("claim_index"), item.get("case_id"))
        if item.get("claim_index") not in claim_indexes:
            errors.append(f"unknown claim_index {item.get('claim_index')!r}")
        if item.get("case_id") not in case_ids:
            errors.append(f"unknown case_id {item.get('case_id')!r}")
        if key in seen:
            errors.append(f"duplicate link {key}")
        seen.add(key)
        if not isinstance(item.get("predicted"), dict) or not item["predicted"]:
            errors.append(f"link {key} needs a predicted result object")
        if not isinstance(item.get("rationale"), str) or not item["rationale"].strip():
            errors.append(f"link {key} needs a rationale")
    return errors


def primary_key(observed: dict, predicted: dict) -> str:
    """The observation field a link is compared at; errors win over their display text."""
    for key in ("error", "value", "text"):
        if key in observed:
            return key
    return next(iter(observed), next(iter(predicted)))


class CaseLinker:
    def __init__(self, engine, opencode: Path, *, timeout: int = 180, env_file: Path | None = None):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[2] / ".env"

    def run(self, draft_artifact: str, review_artifact: str, cases: list[dict],
            observations: dict[str, dict], *, report_artifact: str,
            matches: Callable[[dict, dict], bool], observation_format: str,
            model_role: str = "decomp_worker") -> dict:
        """cases: [{id, input, description}] that entered the draft's function; public only."""
        draft = json.loads(self.engine.store.get(draft_artifact))
        review = json.loads(self.engine.store.get(review_artifact))
        if review.get("draft_artifact") != draft_artifact or review.get("state") != "reviewed":
            raise ValueError("case links need the draft's completed review")
        supported = {item["claim_index"] for item in review["answer"]["reviews"]
                     if item.get("outcome") == "supported_static"}
        claims = [{"claim_index": i, "statement": claim["statement"]}
                  for i, claim in enumerate(draft["answer"]["claims"]) if i in supported]
        usable = [case for case in cases
                  if isinstance((observations.get(case["id"]) or {}).get("observed"), dict)]
        base = {"schema": 1, "draft_artifact": draft_artifact, "review_artifact": review_artifact,
                "subject": draft["subject"], "prompt_version": LINK_PROMPT_VERSION,
                "case_ids": [case["id"] for case in usable], "links": []}
        if not claims or not usable:
            return {**base, "state": "skipped", "usage": None}
        # Observed results stay out of the prompt: predictions are made blind.
        prompt = link_prompt(claims, [{"case_id": c["id"], "input": c["input"],
                                       "description": c.get("description")} for c in usable],
                             observation_format)
        model = get_model(model_role)
        folder = self.engine.root / "case-links" / uuid.uuid4().hex
        folder.mkdir(parents=True)
        started, attempts, answer, errors = time.monotonic(), [], None, []
        current = prompt
        for revision in range(2):
            revision_folder = folder / f"revision-{revision + 1}"
            revision_folder.mkdir()
            reply = invoke_opencode(self.opencode, revision_folder, current, model=model,
                                    timeout=self.timeout, env_file=self.env_file,
                                    agent_name="case-linker",
                                    agent_instruction="Link claims to cases by blind prediction. Return JSON only.")
            try:
                answer = parse_answer(reply["text"])
                errors = validate_links(answer, supported, {c["id"] for c in usable})
            except (ValueError, json.JSONDecodeError) as error:
                answer, errors = None, [f"invalid JSON answer: {error}"]
            attempts.append({"revision": revision + 1, "errors": errors, "usage": reply["usage"],
                             "response_artifact": self.engine.store.put(reply["text"].encode())})
            if not errors:
                break
            current = (prompt + "\nYour previous answer failed validation: " + json.dumps(errors) +
                       "\nReturn a complete corrected JSON object.")
        links = []
        for item in ([] if errors else answer["links"]):
            observed = observations[item["case_id"]]["observed"]
            key = primary_key(observed, item["predicted"])
            agreement = matches(item["predicted"], observed)
            links.append({"draft_artifact": draft_artifact, "claim_index": item["claim_index"],
                          "probe_report_artifact": report_artifact, "case_id": item["case_id"],
                          "observed_pointer": "/" + key,
                          # The dossier compares observed[key] with expected_observed exactly; a
                          # prediction within the matcher's tolerance records the observed value.
                          "expected_observed": observed.get(key) if agreement else item["predicted"].get(key),
                          "predicted": item["predicted"], "rationale": item["rationale"].strip(),
                          "agreement": agreement})
        return {**base, "state": "rejected" if errors else "linked", "model": model,
                "model_role": model_role, "links": links, "structural_errors": errors,
                "prompt_artifact": self.engine.store.put(prompt.encode()),
                "revisions": attempts,
                "usage": {key: sum(a["usage"][key] for a in attempts)
                          for key in ("input", "output", "reasoning", "cost")},
                "elapsed_seconds": round(time.monotonic() - started, 3)}
