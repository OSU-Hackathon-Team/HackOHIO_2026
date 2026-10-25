"""OpenCode investigator: answer a reviewer's open questions with read-only REA and Ghidra tools.

Runs only after an independent review lists missing behavior or unresolved points. The
agent may search, read pseudocode and follow references; it cannot rename, save, write
files, run shells, or start runtime instrumentation. Its notes become revision context
for the next SemanticWorker attempt, which must still cite raw instruction addresses.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
import uuid

from engine.analysis.ghidra import GhidraAnalysis
from engine.analysis.rea import rea_command
from engine.model_runtime import invoke_opencode
from model_config import get_model

REA_READ_ONLY = ("open_binary", "binary_overview", "search_procedures", "search_strings",
                 "procedure_info", "procedure_pseudo_code", "procedure_callers",
                 "procedure_callees", "procedure_references", "xrefs", "list_strings",
                 "resolve_containing_procedure", "close_binary")
# Same tool names agent_worker.opencode_config() allows, minus rename and save.
GHIDRA_READ_ONLY = ("ghidra_program_open", "ghidra_function_at", "ghidra_function_report",
                    "ghidra_decomp_function", "ghidra_program_close")


def mcp_servers(ghidra_dir: str | None = None) -> dict:
    ghidra_dir = ghidra_dir or os.environ.get("GHIDRA_INSTALL_DIR", "/opt/ghidra_12.1.3_PUBLIC")
    return {
        "rea": {"type": "local", "command": rea_command(), "enabled": True, "timeout": 600000,
                "environment": {"REA_MCP_INPUT_SCHEMA_PROFILE": "compact"}},
        "ghidra": {"type": "local", "enabled": True, "timeout": 120000,
                   "command": [os.environ.get("GHIDRA_MCP_BIN", "/opt/venv/bin/ghidra-headless-mcp"),
                               "--ghidra-install-dir", ghidra_dir]},
    }


def allowed_tools() -> tuple[str, ...]:
    return tuple(f"rea_{name}" for name in REA_READ_ONLY) + GHIDRA_READ_ONLY


def open_questions(draft: dict, review: dict) -> list[str]:
    answer = review.get("answer") or {}
    questions = [*answer.get("missing_behavior", []), *answer.get("unresolved", []),
                 *((draft.get("answer") or {}).get("evidence_requests", []))]
    return [q for q in questions if isinstance(q, str) and q.strip()]


def investigation_prompt(binary: str, subject: str, name: str | None, questions: list[str]) -> str:
    return (
        "You are investigating one function in a native library for a behavioral spec. "
        f"Open {binary} with the rea open_binary tool (or the ghidra tools, read-only). "
        f"The function is {name or subject} at entry {subject}. Answer each open question "
        "using only what the tools return: callers, callees, referenced strings and "
        "pseudocode of directly related functions. Do not guess. If the tools cannot answer "
        "a question, say so. Return exactly one JSON object, no markdown: "
        "{\"answers\":[{\"question\":\"...\",\"answer\":\"...\",\"resolved\":true,"
        "\"evidence\":[{\"tool\":\"...\",\"procedure\":\"...\",\"address\":\"...\"}]}]}.\n"
        f"Open questions: {json.dumps(questions)}"
    )


def parse_investigation(text: str) -> dict:
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("investigator returned no JSON object")
    value = json.loads(text[start:end + 1])
    if not isinstance(value.get("answers"), list):
        raise ValueError("investigator JSON has no answers array")
    return value


class Investigator:
    def __init__(self, engine: GhidraAnalysis, opencode: Path, *, timeout: int = 600,
                 env_file: Path | None = None, invoke=invoke_opencode):
        self.engine = engine
        self.opencode = Path(opencode)
        self.timeout = timeout
        self.env_file = env_file or Path(__file__).resolve().parents[1] / ".env"
        self.invoke = invoke

    def run(self, manifest: dict, draft_artifact: str, review_artifact: str, *,
            model: str | None = None, model_role: str = "decomp_worker") -> dict | None:
        """Investigation record, or None when the review left nothing open."""
        draft = json.loads(self.engine.store.get(draft_artifact))
        review = json.loads(self.engine.store.get(review_artifact))
        if review.get("draft_artifact") != draft_artifact:
            raise ValueError("review does not cover this draft")
        questions = open_questions(draft, review)
        if not questions:
            return None
        name = (draft.get("answer") or {}).get("name")
        prompt = investigation_prompt(manifest["binary"], draft["subject"], name, questions)
        folder = self.engine.root / "attempts" / ("investigate-" + uuid.uuid4().hex)
        folder.mkdir(parents=True)
        resolved_model = get_model(model_role, explicit=model)
        started = time.monotonic()
        record = {"schema": 1, "kind": "investigation", "campaign": manifest["campaign"],
                  "subject": draft["subject"], "draft_artifact": draft_artifact,
                  "review_artifact": review_artifact, "questions": questions,
                  "model": resolved_model, "allowed_tools": list(allowed_tools())}
        try:
            servers = mcp_servers()
            if manifest.get('analysis_options', {}).get('profile') == 'scoped':
                from engine.analysis.scoped import prepared_readers
                servers = prepared_readers(manifest, folder / 'readers',
                                           self.engine.headless.parent.parent)
                prompt += (' Global auto-analysis was skipped. REA reads a private copy of the '
                           'scoped baseline; do not infer behavior of unanalysed dependencies. '
                           f'For Ghidra open project_location={folder / "readers" / "ghidra"}, '
                           f'project_name=baseline, program_name={manifest["program_name"]}, '
                           'read_only=true, update_analysis=false.')
            reply = self.invoke(self.opencode, folder, prompt, model=resolved_model,
                                timeout=self.timeout, env_file=self.env_file,
                                agent_name="investigate",
                                agent_instruction="Investigate with read-only tools; answer as JSON only.",
                                mcp=servers, allow_tools=allowed_tools())
            record.update(state="answered", answer=parse_investigation(reply["text"]),
                          usage=reply["usage"])
        except Exception as error:
            record.update(state="failed", error=str(error))
        record["elapsed_seconds"] = round(time.monotonic() - started, 3)
        record["artifact"] = self.engine.store.put(json.dumps(record, sort_keys=True).encode())
        return record

    def revision_context(self, manifest: dict, scope_artifact: str, investigation: dict) -> str:
        """A revision_context artifact SemanticWorker.run(prior_artifact=...) accepts."""
        draft = json.loads(self.engine.store.get(investigation["draft_artifact"]))
        context = {"schema": 1, "state": "revision_context", "campaign": manifest["campaign"],
                   "subject": draft["subject"], "scope_artifact": scope_artifact,
                   "draft_artifact": investigation["draft_artifact"],
                   "review_artifact": investigation["review_artifact"],
                   "reason": "Reviewer left questions open. Investigator notes (untrusted, "
                             "verify against raw evidence): " +
                             json.dumps(investigation.get("answer"), separators=(",", ":"))[:20000]}
        return self.engine.store.put(json.dumps(context, sort_keys=True).encode())
