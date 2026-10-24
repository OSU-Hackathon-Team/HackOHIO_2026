"""Bounded evidence-only semantic attempt using the configured OpenCode model."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from model_config import get_model


AWS_KEYS = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"}


def add_aws_env(env: dict[str, str], env_file: Path) -> None:
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key not in AWS_KEYS or not value:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        env.setdefault(key, value)


def parse_answer(text: str) -> dict:
    answer = text.strip()
    if answer.startswith("```json") and answer.endswith("```"):
        answer = answer[7:-3].strip()
    value = json.loads(answer)
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
    addresses = {evidence["entry"], evidence.get("body_min"), evidence.get("body_max")}
    addresses.update(item["address"] for item in evidence.get("instructions", []))
    for item in evidence.get("references", []):
        addresses.update((item["from"], item["to"]))
    claims = answer.get("claims") if isinstance(answer.get("claims"), list) else []
    for i, claim in enumerate(claims):
        if not isinstance(claim, dict):
            errors.append(f"claim {i} must be an object")
            continue
        if not isinstance(claim.get("statement"), str) or not claim["statement"].strip():
            errors.append(f"claim {i} has no statement")
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


def prompt_for(task: dict, scope: dict, evidence: dict, *, max_evidence_bytes: int) -> tuple[str, bool]:
    relevant = {"schema": evidence["schema"], "entry": evidence["entry"],
                "name": evidence.get("name"), "signature": evidence.get("signature"),
                "body_min": evidence.get("body_min"), "body_max": evidence.get("body_max"),
                "status": evidence.get("status"),
                "instructions": evidence.get("instructions", []),
                "references": evidence.get("references", []),
                "decompilation": evidence.get("decompilation")}
    raw = json.dumps(relevant, separators=(",", ":"))
    truncated = len(raw.encode()) > max_evidence_bytes
    if truncated:
        raw = raw.encode()[:max_evidence_bytes].decode(errors="ignore")
    prompt = (
        "Analyze this native function for a behavioral specification. Use only the evidence "
        "below. The C rendering is Ghidra output, not verified source. Do not invent callback "
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
        "the evidence; a valid citation is not proof of correct interpretation. Scope expected "
        "observables are questions to investigate, not claims about this function. Describe "
        "uncertain widths, signedness, state mutation order, and indirect dispatch in unknowns. "
        "No markdown.\n"
        f"Scope query: {scope['request']['query']}\n"
        f"Expected observables to investigate, not assume true: "
        f"{json.dumps(scope['request']['expected_observables'])}\n"
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
            *, model: str | None = None, model_role: str = "decomp_worker") -> dict:
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
                                       max_evidence_bytes=self.max_evidence_bytes)
        attempt_id = uuid.uuid4().hex
        folder = self.engine.root / "attempts" / attempt_id
        folder.mkdir(parents=True)
        resolved_model = get_model(model_role, explicit=model)
        config = {"$schema": "https://opencode.ai/config.json", "model": resolved_model,
                  "permission": {"*": "deny"},
                  "agent": {"decomp": {"mode": "primary", "model": resolved_model,
                                       "prompt": "Return bounded evidence-backed analysis as JSON only.",
                                       "permission": {"*": "deny"}}}}
        (folder / "opencode.json").write_text(json.dumps(config, indent=2) + "\n")
        (folder / "prompt.txt").write_text(prompt)
        checkpoint = {"schema": 1, "attempt_id": attempt_id, "campaign": manifest["campaign"],
                      "scope_artifact": scope_artifact, "task_key": task["deduplication_key"],
                      "subject": subject, "evidence_artifact": evidence_artifact,
                      "model": resolved_model, "model_role": model_role,
                      "opencode_version": None, "prompt_version": 1,
                      "evidence_truncated": truncated, "state": "running"}
        checkpoint_path = folder / "checkpoint.json"
        checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n")
        self.engine._emit(manifest["campaign"], "semantic_started", attempt_id=attempt_id,
                          subject=subject, task_key=task["deduplication_key"])
        env = os.environ.copy()
        add_aws_env(env, self.env_file)
        env.update(OPENCODE_CONFIG=str(folder / "opencode.json"),
                   OPENCODE_DISABLE_AUTOUPDATE="true",
                   OPENCODE_DISABLE_EXTERNAL_SKILLS="true")
        started = time.monotonic()
        events_path = folder / "events.jsonl"
        stderr_path = folder / "stderr.log"
        try:
            checkpoint["opencode_version"] = subprocess.run(
                [str(self.opencode), "--version"], capture_output=True, text=True,
                check=True, timeout=10).stdout.strip()
            checkpoint_path.write_text(json.dumps(checkpoint, indent=2) + "\n")
            with events_path.open("w") as events, stderr_path.open("w") as stderr:
                completed = subprocess.run([str(self.opencode), "run", "--pure",
                                            "--agent", "decomp", "--model", resolved_model,
                                            "--format", "json", prompt], cwd=folder, env=env,
                                           stdout=events, stderr=stderr,
                                           timeout=self.timeout, check=False)
            rows = [json.loads(line) for line in events_path.read_text().splitlines()
                    if line.startswith("{")]
            if completed.returncode:
                failures = [row.get("error", {}) for row in rows if row.get("type") == "error"]
                message = failures[-1].get("data", {}).get("message", "") if failures else ""
                raise RuntimeError(f"OpenCode exited {completed.returncode}: {message}; see {stderr_path}")
            texts = [row.get("part", {}).get("text", "") for row in rows
                     if row.get("type") == "text"]
            if not texts:
                raise ValueError("model returned no text")
            answer = parse_answer(texts[-1])
            errors = validate_answer(answer, evidence)
            usage = {"input": 0, "output": 0, "reasoning": 0, "cost": 0.0}
            for row in rows:
                if row.get("type") == "step_finish":
                    part = row.get("part", {})
                    tokens = part.get("tokens") or {}
                    for key in ("input", "output", "reasoning"):
                        usage[key] += tokens.get(key, 0)
                    usage["cost"] += part.get("cost", 0)
            result = {**checkpoint, "state": "rejected" if errors else
                      ("partial" if truncated else "unreviewed"),
                      "answer": answer, "structural_errors": errors, "usage": usage,
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        except Exception as error:
            result = {**checkpoint, "state": "failed", "error": str(error),
                      "elapsed_seconds": round(time.monotonic() - started, 3)}
        result["prompt_artifact"] = self.engine.store.put(prompt.encode())
        if events_path.exists():
            result["transcript_artifact"] = self.engine.store.put(events_path.read_bytes())
        artifact = self.engine.store.put(json.dumps(result, sort_keys=True).encode())
        result["artifact"] = artifact
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        checkpoint_path.write_text(json.dumps({**checkpoint, "state": result["state"],
                                               "result_artifact": artifact}, indent=2) + "\n")
        self.engine._emit(manifest["campaign"], "semantic_finished", attempt_id=attempt_id,
                          subject=subject, status=result["state"], artifact=artifact)
        return result
