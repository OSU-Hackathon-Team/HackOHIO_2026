"""Bounded evidence-only semantic attempt using the configured OpenCode model."""

from __future__ import annotations

import json
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.behavior import (is_observable_claim, normalize_input_names,
                             numeric_claim_errors)
from engine.citations import evidence_addresses, normalize_references
from engine.model_runtime import invoke_opencode
from engine.validation.probes import select_original_cases
from engine.validation.memory_ranges import overlap_claim_errors
from model_config import get_model

SEMANTIC_PROMPT_VERSION = 10


def _escape_controls(text: str) -> str:
    """Escape raw control characters that model output leaves inside strings."""
    escaped, in_string, out = False, False, []
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            elif ord(char) < 0x20:
                char = {10: "\\n", 13: "\\r", 9: "\\t"}.get(ord(char),
                                                           "\\u%04x" % ord(char))
        elif char == '"':
            in_string = True
        out.append(char)
    return "".join(out)


def parse_answer(text: str) -> dict:
    answer = text.strip()
    if answer.startswith("```"):
        answer = answer.split("\n", 1)[-1]
    try:
        value, _ = json.JSONDecoder().raw_decode(answer.lstrip())
    except json.JSONDecodeError:
        # A reply with an unescaped newline inside a string is still usable.
        value, _ = json.JSONDecoder().raw_decode(_escape_controls(answer.lstrip()))
    if not isinstance(value, dict):
        raise ValueError("model output must be a JSON object")
    return value


def validate_answer(answer: dict, evidence: dict) -> list[str]:
    errors = []
    for field in ("inputs", "outputs", "state", "side_effects", "errors",
                  "pseudocode"):
        if not isinstance(answer.get(field), str) or not answer[field].strip():
            errors.append(f"{field} must be a nonempty string")
    for field in ("claims", "dependencies", "unknowns", "evidence_requests"):
        if not isinstance(answer.get(field), list):
            errors.append(f"{field} must be an array")
    addresses = evidence_addresses(evidence)
    claims = answer.get("claims") if isinstance(answer.get("claims"), list) else []
    for i, claim in enumerate(claims):
        if not isinstance(claim, dict):
            errors.append(f"claim {i} must be an object")
            continue
        if not isinstance(claim.get("statement"), str) or not claim["statement"].strip():
            errors.append(f"claim {i} has no statement")
        elif not is_observable_claim(claim["statement"]):
            errors.append(f"claim {i} describes implementation structure rather than observable behavior")
        else:
            errors.extend(f"claim {i} {error}" for error in
                          numeric_claim_errors(claim["statement"]))
        refs = claim.get("evidence_addresses")
        if not isinstance(refs, list) or not refs:
            errors.append(f"claim {i} has no evidence addresses")
        else:
            for address in refs:
                if not isinstance(address, str) or address not in addresses:
                    errors.append(f"claim {i} cites unknown address {address}")
        for field in ("assumptions", "alternatives"):
            if not isinstance(claim.get(field), list):
                errors.append(f"claim {i} {field} must be an array")
        errors.extend(f"claim {i} {error}" for error in
                      overlap_claim_errors(claim, evidence))
    dependencies = answer.get("dependencies") if isinstance(answer.get("dependencies"), list) else []
    for i, dependency in enumerate(dependencies):
        if not isinstance(dependency, dict) or not isinstance(dependency.get("target"), str):
            errors.append(f"dependency {i} needs a target")
        elif not isinstance(dependency.get("contract"), str):
            errors.append(f"dependency {i} needs a contract")
        if isinstance(dependency, dict):
            refs = dependency.get("evidence_addresses")
            if not isinstance(refs, list) or not refs:
                errors.append(f"dependency {i} needs evidence addresses")
            else:
                for address in refs:
                    if not isinstance(address, str) or address not in addresses:
                        errors.append(f"dependency {i} cites unknown address {address}")
            if not isinstance(dependency.get("assumptions"), list):
                errors.append(f"dependency {i} assumptions must be an array")
    for field in ("unknowns", "evidence_requests"):
        values = answer.get(field) if isinstance(answer.get(field), list) else []
        for i, item in enumerate(values):
            if not isinstance(item, str) or not item.strip():
                errors.append(f"{field} item {i} must be a nonempty string")
    return errors


def normalize_answer_citations(answer: dict, evidence: dict) -> list[dict]:
    addresses = evidence_addresses(evidence)
    changes = []
    for kind in ("claims", "dependencies"):
        items = answer.get(kind)
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            refs, corrections = normalize_references(item.get("evidence_addresses"), addresses)
            item["evidence_addresses"] = refs
            changes.extend({"field": kind, "index": index, **correction}
                           for correction in corrections)
    return changes


def normalize_answer_text_items(answer: dict) -> list[dict]:
    changes = []
    for field in ("unknowns", "evidence_requests"):
        values = answer.get(field)
        if not isinstance(values, list):
            continue
        for index, item in enumerate(values):
            if (isinstance(item, dict) and set(item) == {"description"} and
                    isinstance(item["description"], str) and item["description"].strip()):
                values[index] = item["description"]
                changes.append({"field": field, "index": index,
                                "shape": "description_object_to_string"})
    return changes


def normalize_answer_claims(answer: dict) -> list[dict]:
    changes = []
    claims = answer.get("claims")
    if not isinstance(claims, list):
        return changes
    for index, claim in enumerate(claims):
        if not isinstance(claim, dict) or not isinstance(claim.get("statement"), str):
            continue
        old = claim["statement"]
        claim["statement"] = normalize_input_names(old)
        if claim["statement"] != old:
            changes.append({"index": index, "original": old,
                            "normalized": claim["statement"]})
    return changes


def prompt_for(task: dict, scope: dict, evidence: dict, *, max_evidence_bytes: int) -> tuple[str, bool]:
    relevant = {"schema": evidence["schema"], "entry": evidence["entry"],
                "name": evidence.get("name"), "signature": evidence.get("signature"),
                "signature_source": evidence.get("signature_source"),
                "listing_parameters": evidence.get("listing_parameters", []),
                "listing_return": evidence.get("listing_return"),
                "listing_locals": evidence.get("listing_locals", []),
                "decompiler_signature": evidence.get("decompiler_signature"),
                "decompiler_prototype": evidence.get("decompiler_prototype"),
                "decompiler_locals": evidence.get("decompiler_locals", []),
                "referenced_data": evidence.get("referenced_data", []),
                "body_min": evidence.get("body_min"), "body_max": evidence.get("body_max"),
                "status": evidence.get("status"),
                "instructions": evidence.get("instructions", []),
                "references": evidence.get("references", []),
                "decompilation": evidence.get("decompilation")}
    raw = json.dumps(relevant, separators=(",", ":"))
    truncated = len(raw.encode()) > max_evidence_bytes
    if truncated:
        raw = raw.encode()[:max_evidence_bytes].decode(errors="ignore")
    names = {item["entry"]: item["name"] for item in
             scope.get("included", []) + scope.get("boundaries", [])}
    direct_calls = [{"call_site": ref["from"], "target_entry": ref["to"],
                     "target_name": names.get(ref["to"])}
                    for ref in evidence.get("references", [])
                    if "CALL" in ref.get("type", "") and not ref.get("external")]
    prompt = (
        "Analyze this native function for a behavioral specification. Use only the evidence "
        "below. The C rendering and decompiler prototype are Ghidra inferences, not verified "
        "source or confirmed parameter types. Keep listing types and inferred types distinct. "
        "Do not invent callback "
        "targets or claim complete behavior from static evidence. Do not invent failures such "
        "as inaccessible memory unless the instructions show a relevant check. Return exactly "
        "one JSON object with this shape: "
        "{\"inputs\":\"No explicit parameters, or describe them\",\"outputs\":\"...\","
        "\"state\":\"...\",\"side_effects\":\"...\",\"errors\":\"No explicit error path, or describe it\","
        "\"pseudocode\":\"...\",\"claims\":[{\"statement\":\"...\","
        "\"evidence_addresses\":[\"exact address\"],\"assumptions\":[],\"alternatives\":[]}],"
        "\"dependencies\":[{\"target\":\"...\",\"contract\":\"...\","
        "\"evidence_addresses\":[\"exact address\"],\"assumptions\":[]}],"
        "\"unknowns\":[],\"evidence_requests\":[]}. "
        "Use [] for no dependencies, unknowns, or evidence requests. All six descriptive "
        "strings must be nonempty. Request specific missing evidence in evidence_requests. "
        "Put observable behavior only in claims. Every claim must cite actual addresses from "
        "the evidence. For C++ binaries, describe the operation a caller observes; class "
        "layout, offsets, pointer traversal, reference counts, vtable stores, RTTI, "
        "constructor mechanics, and the C++ ABI are not functional requirements. "
        "Name conceptual subsystem state and describe how public operations change "
        "and query it. Do not turn helper calls, loops, count fields, or resource "
        "cleanup into claims. For a query, say what inputs or conceptual state make "
        "its result true or false. For a mutation, say what caller-visible state "
        "changes. Do not mention buffers, pointers, fields, offsets, allocation, "
        "deallocation, scans, or bytes in claim statements. Those are implementation "
        "details, even if the reviewer previously accepted them. Express a public "
        "operation's logical rule in terms of tokens, values, and state. "
        "Put unsupported interpretation in unknowns. The behavior may be "
        "reimplemented in C or any other language. "
        "A valid citation is not proof of correct interpretation. Scope expected "
        "observables are questions to investigate, not claims about this function. Describe "
        "uncertain widths, signedness, state mutation order, and indirect dispatch in unknowns. "
        "For numeric conditions, state the concrete inclusive or exclusive boundary and "
        "recompute arithmetic modulo the machine operand width. Describe flag-dependent "
        "branches separately. Write claim statements as observable behavior with descriptive "
        "input names; keep registers (such as RAX, RDI, EAX, XMM), addresses (0x...), decompiler identifiers (such as param_1, _DAT_), and code syntax out "
        "of claim statements. Do not write vague statements like 'reads a value from memory', 'XORs with a constant', or 'predefined global variables'; "
        "state exact constants, bit widths, endianness, formulas, return codes, and conceptual state field names. "
        "Do not replace a visible numeric rule with 'computed limit'. "
        "For every listed dependency, cite the actual call instruction to that callee. "
        "Use the direct-call index below to bind each call site to its target name. "
        "Account for every direct call: add a dependency when the answer relies on the "
        "callee's behavior, or identify the unexamined call explicitly in unknowns. "
        "Memory locations, globals, input "
        "values, and field reads belong in state, assumptions, or unknowns, not dependencies. "
        "If the function makes no relevant call, return dependencies: []. "
        "No markdown.\n"
        f"Scope query: {scope['request']['query']}\n"
        f"Expected observables to investigate, not assume true: "
        f"{json.dumps(scope['request']['expected_observables'])}\n"
        f"Direct-call index: {json.dumps(direct_calls, separators=(',', ':'))}\n"
        f"Task: {task['question']}\n"
        f"Evidence was truncated: {str(truncated).lower()}\n"
        f"Evidence: {raw}"
    )
    return prompt, truncated


class SemanticWorker:
    def __init__(self, engine: GhidraAnalysis, opencode: Path, *, timeout: int = 180,
                 max_evidence_bytes: int = 60000, env_file: Path | None = None):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.max_evidence_bytes = max_evidence_bytes
        self.env_file = env_file or Path(__file__).resolve().parents[1] / ".env"

    def run(self, manifest: dict, scope_artifact: str, subject: str,
            *, model: str | None = None, model_role: str = "decomp_worker",
            prior_artifact: str | None = None,
            probe_report_artifact: str | None = None,
            guidance: str = "", watchdog_artifact: str | None = None,
            evidence_bytes: int | None = None) -> dict:
        scope = json.loads(self.engine.store.get(scope_artifact))
        if scope["campaign"] != manifest["campaign"]:
            raise ValueError("scope and campaign differ")
        tasks = [task for task in scope["tasks"] if task["subject"] == subject]
        if len(tasks) != 1:
            raise ValueError("subject is not a unique scope task")
        task = tasks[0]
        evidence = self.engine.function(manifest, subject)
        if evidence["status"] != "ok":
            raise ValueError(f"function evidence is {evidence['status']}")
        pointer = Path(manifest["project"]) / "functions" / (subject.replace(":", "_") + ".json")
        evidence_artifact = json.loads(pointer.read_text())["artifact"]
        prompt, truncated = prompt_for(task, scope, evidence,
                                       max_evidence_bytes=evidence_bytes or self.max_evidence_bytes)
        original_cases = []
        if probe_report_artifact:
            report = json.loads(self.engine.store.get(probe_report_artifact))
            names = {item["entry"]: item["name"] for item in scope["included"]}
            original_cases = select_original_cases(
                self.engine.store, report, manifest["binary_sha256"], names.get(subject))
            prompt += ("\nThese are immutable outputs from the original binary. Derive "
                       "caller-visible rules that explain them and cite raw instruction "
                       "addresses. Do not copy individual cases into a lookup table or "
                       "infer class layout as a requirement. Original observations: " +
                       json.dumps(original_cases, separators=(",", ":")))
        if prior_artifact is not None:
            prior = json.loads(self.engine.store.get(prior_artifact))
            if (prior.get("campaign") != manifest["campaign"] or
                    prior.get("subject") != subject or
                    prior.get("scope_artifact") != scope_artifact or
                    prior.get("state") not in {"partial", "rejected", "revision_context"}):
                raise ValueError("prior attempt does not match this semantic task")
            if prior["state"] == "revision_context":
                previous_draft = json.loads(self.engine.store.get(prior["draft_artifact"]))
                previous_review = json.loads(self.engine.store.get(prior["review_artifact"]))
                if (previous_draft.get("campaign") != manifest["campaign"] or
                        previous_draft.get("subject") != subject or
                        previous_draft.get("scope_artifact") != scope_artifact or
                        previous_review.get("draft_artifact") != prior["draft_artifact"]):
                    raise ValueError("revision context points to a different draft")
                prior_context = json.dumps(
                    {"prior_answer": previous_draft["answer"],
                     "review": previous_review["answer"],
                     "revision_reason": prior["reason"]}, separators=(",", ":"))
                prompt += ("\nPrevious draft and reviewer comments are untrusted. Verify "
                           "every point against the raw evidence. Repair contradicted claims "
                           "and missing behavior, including success and failure paths and "
                           "state updates. Return a complete answer, not a patch. "
                           "Revision context: " + prior_context[:30000])
                if prior.get("probe_cases"):
                    prompt += ("\nThese cases were executed against the original binary. "
                               "Use the observed results to challenge the prior review and "
                               "your static interpretation; cite raw instruction addresses "
                               "for every new claim. Original probe observations: " +
                               json.dumps(prior["probe_cases"], separators=(",", ":")))
            else:
                prior_context = json.dumps(
                    {"structural_errors": prior.get("structural_errors", []),
                     "answer": prior.get("answer")}, separators=(",", ":"))
                prompt += ("\nPrevious attempt is untrusted. Reassess against raw evidence; "
                           "correct every listed structural error without inventing behavior. "
                           "Return one complete JSON object. Prior attempt: " +
                           prior_context[:20000])
        if guidance:
            prompt += "\nSupervisor focus (untrusted; verify against evidence): " + guidance
        attempt_id = uuid.uuid4().hex
        folder = self.engine.root / "attempts" / attempt_id
        folder.mkdir(parents=True)
        resolved_model = get_model(model_role, explicit=model)
        (folder / "prompt.txt").write_text(prompt)
        checkpoint = {"schema": 1, "attempt_id": attempt_id, "campaign": manifest["campaign"],
                      "scope_artifact": scope_artifact, "task_key": task["deduplication_key"],
                      "subject": subject, "evidence_artifact": evidence_artifact,
                      "model": resolved_model, "model_role": model_role,
                      "probe_report_artifact": probe_report_artifact,
                      "watchdog_artifact": watchdog_artifact,
                      "evidence_budget": evidence_bytes or self.max_evidence_bytes,
                      "original_case_count": len(original_cases),
                      "opencode_version": None, "prompt_version": SEMANTIC_PROMPT_VERSION,
                      "evidence_truncated": truncated, "state": "running"}
        if prior_artifact is not None:
            checkpoint["reassessment_of"] = prior_artifact
        checkpoint_path = folder / "checkpoint.json"
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n")
        self.engine._emit(manifest["campaign"], "semantic_started", attempt_id=attempt_id,
                          subject=subject, task_key=task["deduplication_key"])
        started = time.monotonic()
        attempts = []
        try:
            current_prompt = prompt
            for revision in range(3):
                revision_folder = folder / f"revision-{revision + 1}"
                revision_folder.mkdir()
                (revision_folder / "prompt.txt").write_text(current_prompt)
                model_reply = invoke_opencode(
                    self.opencode, revision_folder, current_prompt, model=resolved_model,
                    timeout=self.timeout, env_file=self.env_file,
                    agent_name="decomp",
                    agent_instruction="Return bounded evidence-backed analysis as JSON only.")
                checkpoint["opencode_version"] = model_reply["runtime_version"]
                checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n")
                errors = []
                try:
                    answer = parse_answer(model_reply["text"])
                    citation_normalizations = normalize_answer_citations(answer, evidence)
                    text_item_normalizations = normalize_answer_text_items(answer)
                    claim_normalizations = normalize_answer_claims(answer)
                    errors = validate_answer(answer, evidence)
                except (ValueError, json.JSONDecodeError) as parse_error:
                    answer = None
                    citation_normalizations = []
                    text_item_normalizations = []
                    claim_normalizations = []
                    errors = [f"invalid JSON answer: {parse_error}"]
                attempts.append({
                    "revision": revision + 1, "errors": errors,
                    "prompt_artifact": self.engine.store.put(current_prompt.encode()),
                    "response_artifact": self.engine.store.put(model_reply["text"].encode()),
                    "transcript_artifact": self.engine.store.put(
                        (revision_folder / "events.jsonl").read_bytes()),
                    "usage": model_reply["usage"],
                })
                if not errors:
                    break
                current_prompt = (prompt + "\nYour previous answer failed validation. "
                                  "Return a complete corrected JSON object. Explain the "
                                  "general functional rules visible in original observations "
                                  "when they are provided, with static citations. If no "
                                  "observable behavior is evidenced, leave claims empty and "
                                  "explain that in unknowns and evidence_requests. "
                                  "Validation errors: " +
                                  json.dumps(errors) + "\nPrevious answer: " +
                                  model_reply["text"][:20000])
            suppressed_claims = []
            if (errors and isinstance(answer, dict) and
                    all("describes implementation structure" in error for error in errors)):
                # Preserve every model response in revisions, then publish only
                # claims that can become functional requirements. A structural
                # only function remains visibly incomplete in the dossier.
                suppressed_claims = [claim for claim in answer["claims"]
                                     if not is_observable_claim(claim["statement"])]
                answer["claims"] = [claim for claim in answer["claims"]
                                    if is_observable_claim(claim["statement"])]
                answer["unknowns"].append(
                    "The available evidence does not establish the caller-visible effects "
                    "of the omitted implementation mechanics.")
                answer["evidence_requests"].append(
                    "Inspect the called functions and execute original cases that expose "
                    "the returned value and state changes.")
                errors = validate_answer(answer, evidence)
            result = {**checkpoint, "state": "rejected" if errors else
                      ("partial" if truncated else "unreviewed"),
                      "answer": answer, "structural_errors": errors,
                      "citation_normalizations": citation_normalizations,
                      "text_item_normalizations": text_item_normalizations,
                      "claim_normalizations": claim_normalizations,
                      "suppressed_structural_claims": suppressed_claims,
                      "revisions": attempts,
                      "usage": {key: sum(item["usage"][key] for item in attempts)
                                for key in ("input", "output", "reasoning", "cost")},
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
        self.engine._emit(manifest["campaign"], "semantic_finished", attempt_id=attempt_id,
                          subject=subject, status=result["state"], artifact=artifact)
        return result
