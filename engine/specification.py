"""Publish behavioral native specs through the regular Step 2 spec writer."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

from engine.artifacts import LocalArtifactStore
from engine.dossier import canonical

ROOT = Path(__file__).resolve().parents[1]
WRITER = ROOT / "node_modules" / ".bin" / "tsx"
SCRIPT = ROOT / "packages/backend/src/scripts/writeNativeSpec.ts"
WRITER_INPUTS = (SCRIPT, ROOT / "packages/backend/src/spec/nativeDraft.ts",
                 ROOT / "packages/backend/src/spec/writeDraft.ts",
                 ROOT / "packages/backend/src/spec/nativeSafety.ts",
                 ROOT / "packages/contracts/src/nativeSpec.ts",
                 ROOT / "models.json", Path(__file__))


def writer_revision() -> str:
    digest = hashlib.sha256()
    for path in WRITER_INPUTS:
        digest.update(str(path.relative_to(ROOT)).encode())
        digest.update(path.read_bytes())
    digest.update(os.environ.get("MODEL_SPEC_WRITER", "").encode())
    return digest.hexdigest()


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def prepare_handoff(dossier: dict, dossier_artifact: str) -> tuple[dict, dict]:
    """Pass supported behavior to the writer and retain source references for audit."""
    _require(dossier.get("schema") == 1, "unsupported dossier schema")
    _require(dossier.get("readiness") == "ready_for_spec" and not dossier.get("blockers"),
             "dossier is not ready for a cleanroom specification; resolve blockers first")
    scope = dossier.get("scope", {})
    _require(scope.get("campaign") == dossier.get("campaign") and
             scope.get("scope_id") == dossier.get("scope_id") and
             scope.get("revision") == dossier.get("scope_revision"),
             "dossier scope identity is inconsistent")
    claims = dossier.get("claims", [])
    _require(bool(claims) and all(c.get("review_state") == "supported_static" and
                                     c.get("execution_state") == "case_agreement" and
                                     c.get("evidence") and c.get("reviews") and
                                     c.get("probe_links") and
                                     all(link.get("agreement") is True
                                         for link in c["probe_links"])
                                     for c in claims),
             "all claims need static support and agreeing original cases")
    source_shaped = [c for c in claims if re.search(
        r"\b(?:param_\d+|_?DAT_[0-9a-f]+|RDI|RAX|EAX|XMM\d+|MOVAPS|MOVUPS|PXOR)\b|"
        r"\b0x[0-9a-f]{6,}\b|\bat address\s+[0-9a-f]{6,}\b|"
        r"\b(?:reads a value from memory|specific memory location|calculated value based on|"
        r"result of the comparison|several bytes and a constant|predefined global variables)\b",
        c.get("statement", ""), re.I)]
    _require(not source_shaped,
             f"{len(source_shaped)} claims are source-shaped or underspecified; revise them as observable behavior")
    functions = dossier.get("functions", [])
    included = scope.get("included", [])
    _require({f.get("subject") for f in functions} == {f.get("entry") for f in included} and
             len(functions) == len(included),
             "included functions lack unique behavioral descriptions")
    _require(not scope.get("unresolved") and not dossier.get("uncovered_direct_calls"),
             "scope or direct-call behavior remains unresolved")
    _require(all(isinstance(item.get("contract"), str) and item["contract"].strip()
                 for item in scope.get("boundaries", [])),
             "boundary contract is missing")
    _require(all(d.get("review_state") == "supported_static" and
                 d.get("current_at_snapshot") is True
                 for d in dossier.get("dependency_contracts", [])),
             "dependency contracts are not current and reviewed")
    _require(not any(g.get("decision") != "nonblocking"
                     for g in dossier.get("independent_review_gaps", [])),
             "independent review gaps remain unresolved")
    names = {f["entry"]: f["name"] for f in included}
    claim_ids = {id(c): f"C{i}" for i, c in enumerate(claims, 1)}
    cases = {}
    for case in dossier.get("probes", []):
        _require(case.get("outcome") == "agreement", "original case disagreement")
        key = json.dumps([case.get("input"), case.get("observed")], sort_keys=True)
        cases.setdefault(key, {"name": case["case_id"], "input": case["input"],
                               "input_description": case.get("input_description"),
                               **({"observation_kind": case["kind"]}
                                  if case.get("kind") in {"executable", "shared"} else {}),
                               "expected_output": case["observed"]})
    _require(bool(cases), "no original behavior examples")
    handoff = {
        "feature": scope["request"]["query"],
        "boundary": scope["request"]["mode"],
        "observables": scope["request"].get("expected_observables", []),
        "functions": [{"name": names[f["subject"]], "inputs": f["inputs"],
                       "outputs": f["outputs"], "state": f["state"],
                       "side_effects": f["side_effects"], "errors": f["errors"]}
                      for f in functions],
        "claims": [{"id": claim_ids[id(c)], "statement": c["statement"],
                    "function": names[c["subject"]]} for c in claims],
        "dependency_contracts": [d["contract"] for d in dossier["dependency_contracts"]],
        "boundary_contracts": [item["contract"] for item in scope.get("boundaries", [])],
        "original_examples": list(cases.values()),
        "excluded_behavior": [{"name": e.get("name"), "reason": e.get("reason")}
                              for e in scope.get("exclusions", [])],
    }
    audit = {
        "dossier_artifact": dossier_artifact, "dossier_revision": dossier["revision"],
        "campaign": dossier["campaign"], "binary_sha256": dossier["binary_sha256"],
        "scope_artifact": dossier["scope_artifact"],
        "claim_sources": {claim_ids[id(c)]: {
            "subject": c["subject"], "draft_artifact": c["draft_artifact"],
            "claim_index": c["claim_index"], "evidence": c["evidence"],
            "reviews": c["reviews"], "probe_links": c.get("probe_links", [])}
            for c in claims},
        "analysis_provenance": dossier.get("analysis_provenance"),
        "coverage": dossier.get("coverage"),
        "writer_revision": writer_revision(),
    }
    return handoff, audit


def _write_with_regular_engine(handoff: dict) -> dict:
    _require(WRITER.exists(), "install workspace dependencies before writing a spec")
    result = subprocess.run([str(WRITER), str(SCRIPT)], cwd=ROOT,
                            input=json.dumps(handoff), text=True, capture_output=True,
                            timeout=180, check=False)
    if result.returncode:
        raise RuntimeError(f"regular spec writer failed: {result.stderr[-4000:]}")
    return json.loads(result.stdout)


def validate_draft(draft: dict, handoff: dict) -> None:
    _require(isinstance(draft, dict), "spec writer returned no draft")
    expected = {c["id"] for c in handoff["claims"]}
    requirements = draft.get("requirements", [])
    _require(isinstance(requirements, list) and requirements, "spec lacks requirements")
    covered = set()
    for index, requirement in enumerate(requirements, 1):
        _require(requirement.get("id") == f"REQ-{index}" and
                 isinstance(requirement.get("statement"), str) and
                 requirement["statement"].strip(), "invalid requirement")
        refs = requirement.get("claim_ids", [])
        _require(bool(refs) and set(refs) <= expected, "invented or missing claim reference")
        covered.update(refs)
    _require(covered == expected, "spec omits supported behavioral facts")
    interface = draft.get("interface", {})
    _require(isinstance(interface, dict) and
             all(isinstance(interface.get(k), list) for k in ("inputs", "outputs", "state")) and
             all(isinstance(draft.get(k), list) for k in
                 ("behavior_steps", "acceptance_criteria", "deviations", "exclusions")),
             "spec lacks interface or checks")
    _require(bool(interface["inputs"]) and bool(interface["outputs"]) and
             bool(draft["behavior_steps"]) and bool(draft["acceptance_criteria"]),
             "spec lacks implementation guidance")
    text = ([draft["title"], draft["purpose"]] + interface["inputs"] +
            interface["outputs"] + interface["state"] +
            [r["statement"] for r in requirements] + draft["behavior_steps"] +
            draft["acceptance_criteria"] + draft["deviations"] + draft["exclusions"])
    for value in text:
        _require(isinstance(value, str) and bool(value.strip()), "empty spec text")
        _require(not re.search(
            r"```|</?(?:source|code)|\b(?:MOVAPS|MOVUPS|PXOR|JBE|CMP|RDI|XMM\d+|param_\d+)\b|"
            r"\b0x[0-9a-f]{6,}\b|\b[0-9a-f]{64}\b|\b(?:decompil|disassembl|review_state|unmapped|artifact|unknown|TODO|dossier|claim|probe|source)\w*\b|\bsrc/|"
            r"\b(?:function|const|let|return|if)\s*\(|=>|[{};`]|"
            r"(?:^|\s)[A-Za-z_]\w*(?:\[[^\]]+\])?\s*(?:\+=|-=|==|=)\s*\S|"
            r"^\s*[A-Za-z_]\w*\s*:\s*(?:u?int\d+|boolean|number|string|bool)\b|\n",
            value, re.I),
            "spec contains source-like or report-card text")


def _validate_examples(examples: list[dict]) -> None:
    """Original test data may itself contain source; keep that out of the public artifact."""
    def inspect(value) -> None:
        if isinstance(value, str):
            _require(len(value) <= 256 and not re.search(
                r"```|/\*|\*/|//|\b(?:function|class|const|import|export)\s+\w+|"
                r"\b(?:MOVAPS|MOVUPS|PXOR|JBE|CMP)\b|\b0x[0-9a-f]{6,}\b|"
                r"\b(?:return|const|let|import|export)\s+\w+|=>|\{\s*\w+\s*[:=]|\n",
                value, re.I), "original example contains source-like or oversized text")
        elif isinstance(value, list):
            for item in value:
                inspect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                inspect(key)
                inspect(item)
        else:
            _require(value is None or isinstance(value, (int, float, bool)),
                     "invalid original example data")
    for example in examples:
        inspect(example)


def generate_spec(dossier: dict, dossier_artifact: str, *, writer=None) -> tuple[dict, dict]:
    handoff, audit = prepare_handoff(dossier, dossier_artifact)
    result = (writer or _write_with_regular_engine)(handoff)
    draft = result["draft"]
    validate_draft(draft, handoff)
    spec = {
        "schema": 2, "kind": "native_subsystem_spec", "status": "ready_for_review",
        "title": draft["title"], "purpose": draft["purpose"],
        "boundary": handoff["boundary"], "interface": draft["interface"],
        "requirements": [{"id": r["id"], "statement": r["statement"]}
                         for r in draft["requirements"]],
        "behavior_steps": draft["behavior_steps"],
        "examples": handoff["original_examples"],
        "acceptance_criteria": draft["acceptance_criteria"],
        "deviations": draft["deviations"], "exclusions": draft["exclusions"],
    }
    _validate_examples(spec["examples"])
    audit["requirement_sources"] = {r["id"]: r["claim_ids"] for r in draft["requirements"]}
    audit["model"] = result.get("model")
    return spec, audit


def render_markdown(spec: dict) -> str:
    lines = [f"# {spec['title']}", "", spec["purpose"], "", "## Interface", ""]
    for key in ("inputs", "outputs", "state"):
        lines.extend([f"### {key.title()}", ""])
        lines.extend(f"- {item}" for item in spec["interface"][key])
        lines.append("")
    for title, key in (("Requirements", "requirements"),
                       ("Behavior outline", "behavior_steps"),
                       ("Acceptance criteria", "acceptance_criteria"),
                       ("Allowed deviations", "deviations"),
                       ("Excluded behavior", "exclusions")):
        lines.extend([f"## {title}", ""])
        lines.extend(f"- {item['id']}: {item['statement']}" if key == "requirements"
                     else f"- {item}" for item in spec[key])
        lines.append("")
    lines.extend(["## Original behavior examples", ""])
    for case in spec["examples"]:
        context = case.get("input_description") or (
            "Original executable arguments" if case.get("observation_kind") == "executable"
            else "Original shared call input")
        lines.append(f"- {case['name']} ({context}): input {json.dumps(case['input'], sort_keys=True)}; "
                     f"expected output {json.dumps(case['expected_output'], sort_keys=True)}")
    return "\n".join(lines) + "\n"


def persist_spec(state: Path, dossier_artifact: str, *, writer=None) -> dict:
    state = Path(state)
    store = LocalArtifactStore(state / "artifacts")
    dossier = json.loads(store.get(dossier_artifact))
    handoff, _ = prepare_handoff(dossier, dossier_artifact)
    folder = state / "specifications" / dossier["scope_id"]
    folder.mkdir(parents=True, exist_ok=True)
    writer_hash = writer_revision()
    pointer_path = folder / f"dossier-{dossier_artifact}-writer-{writer_hash}.json"
    if pointer_path.exists():
        pointer = json.loads(pointer_path.read_text())
        store.get(pointer["artifact"])
        store.get(pointer["audit_artifact"])
    else:
        spec, audit = generate_spec(dossier, dossier_artifact, writer=writer)
        artifact = store.put(canonical(spec))
        audit["spec_artifact"] = artifact
        audit["handoff_sha256"] = hashlib.sha256(canonical(handoff)).hexdigest()
        audit_artifact = store.put(canonical(audit))
        pointer = {"artifact": artifact, "audit_artifact": audit_artifact,
                   "dossier_artifact": dossier_artifact, "status": spec["status"],
                   "dossier_revision": dossier["revision"]}
        pointer_path.write_text(json.dumps(pointer, sort_keys=True) + "\n")
    spec = json.loads(store.get(pointer["artifact"]))
    markdown = render_markdown(spec)
    markdown_path = folder / f"spec-{pointer['artifact']}.md"
    if not markdown_path.exists():
        markdown_path.write_text(markdown)
    latest = folder / "latest.json"
    previous = json.loads(latest.read_text()) if latest.exists() else None
    if previous is None or previous["dossier_revision"] <= dossier["revision"]:
        temporary = folder / "latest.tmp"
        temporary.write_text(json.dumps(pointer, sort_keys=True) + "\n")
        os.replace(temporary, latest)
        (folder / "latest.md").write_text(markdown)
    return {**pointer, "json_path": str(pointer_path),
            "markdown_path": str(markdown_path),
            "requirements": len(spec["requirements"])}
