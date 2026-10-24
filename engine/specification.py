"""Generate an auditable native subsystem specification from a dossier revision."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from engine.artifacts import LocalArtifactStore
from engine.dossier import canonical


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def generate_spec(dossier: dict, dossier_artifact: str) -> dict:
    """Project reviewed dossier content without upgrading its evidence status."""
    _require(dossier.get("schema") == 1, "unsupported dossier schema")
    _require(dossier.get("readiness") in {"partial", "ready_for_spec", "blocked"},
             "invalid dossier readiness")
    scope = dossier.get("scope")
    _require(isinstance(scope, dict) and scope.get("campaign") == dossier.get("campaign") and
             scope.get("scope_id") == dossier.get("scope_id") and
             scope.get("revision") == dossier.get("scope_revision"),
             "dossier scope identity is inconsistent")
    _require(isinstance(dossier.get("claims"), list) and
             isinstance(dossier.get("blockers"), list) and
             isinstance(dossier.get("functions"), list), "incomplete dossier")
    required_lists = ("draft_artifacts", "review_artifacts", "probe_report_artifacts",
                      "probe_link_artifacts", "dependency_resolution_artifacts",
                      "gap_adjudication_artifacts", "independent_review_gaps",
                      "dependency_contracts", "probes")
    missing = [field for field in required_lists if not isinstance(dossier.get(field), list)]
    _require(not missing, f"dossier lacks current handoff fields: {', '.join(missing)}")
    names = {item["entry"]: item["name"] for item in scope["included"]}
    drafts_by_subject: dict[str, set[str]] = {}
    for function in dossier["functions"]:
        drafts_by_subject.setdefault(function["subject"], set()).add(
            function["draft_artifact"])
    requirements = []
    unresolved_claims = []
    for claim in dossier["claims"]:
        _require(claim["subject"] in names and
                 claim["draft_artifact"] in dossier["draft_artifacts"],
                 "claim is outside dossier inputs")
        identity = {"subject": claim["subject"],
                    "draft_artifact": claim["draft_artifact"],
                    "claim_index": claim["claim_index"]}
        if claim["review_state"] != "supported_static" or len(
                drafts_by_subject.get(claim["subject"], set())) != 1:
            unresolved_claims.append({**identity, "statement": claim["statement"],
                                      "review_state": claim["review_state"],
                                      "reason": ("multiple_drafts_for_subject" if len(
                                          drafts_by_subject.get(claim["subject"], set())) != 1
                                          else "claim_not_supported_static"),
                                      "reviews": claim["reviews"]})
            continue
        _require(bool(claim["evidence"]) and bool(claim["reviews"]),
                 "supported claim lacks evidence or independent review")
        _require(all(isinstance(item.get("artifact"), str) and
                     isinstance(item.get("address"), str) for item in claim["evidence"]),
                 "invalid claim evidence")
        requirements.append({**identity, "id": f"REQ-{len(requirements) + 1}",
                             "statement": claim["statement"],
                             "evidence": claim["evidence"],
                             "assumptions": claim["assumptions"],
                             "alternatives": claim["alternatives"],
                             "review_state": "supported_static",
                             "reviews": claim["reviews"],
                             "execution_state": claim["execution_state"],
                             "probe_links": claim.get("probe_links", [])})
    descriptions = []
    for function in dossier["functions"]:
        _require(function["subject"] in names and
                 function["draft_artifact"] in dossier["draft_artifacts"],
                 "function summary is outside dossier inputs")
        descriptions.append({"entry": function["subject"],
                             "name": names[function["subject"]],
                             "draft_artifact": function["draft_artifact"],
                             "inputs": function["inputs"], "outputs": function["outputs"],
                             "state": function["state"],
                             "side_effects": function["side_effects"],
                             "errors": function["errors"],
                             "draft_pseudocode": function["pseudocode"],
                             "unknowns": function["unknowns"],
                             "evidence_requests": function["evidence_requests"]})
    blockers = list(dossier["blockers"])
    if unresolved_claims:
        blockers.append({"kind": "claims_excluded_from_requirements",
                         "count": len(unresolved_claims)})
    return {"schema": 1, "kind": "native_subsystem_spec",
            "campaign": dossier["campaign"],
            "binary_sha256": dossier["binary_sha256"],
            "scope_id": dossier["scope_id"],
            "scope_revision": dossier["scope_revision"],
            "title": scope["request"]["query"],
            "status": "partial" if blockers or dossier["readiness"] != "ready_for_spec"
                      else "ready_for_review",
            "boundary": {"mode": scope["request"]["mode"],
                         "included": scope["included"],
                         "boundaries": scope["boundaries"],
                         "exclusions": scope.get("exclusions", []),
                         "unresolved_edges": scope["unresolved"],
                         "expected_observables_to_investigate":
                             scope["request"].get("expected_observables", [])},
            "requirements": requirements,
            "function_descriptions": descriptions,
            "dependency_contracts": dossier["dependency_contracts"],
            "original_cases": dossier["probes"],
            "unresolved_claims": unresolved_claims,
            "review_gaps": dossier["independent_review_gaps"],
            "blockers": blockers,
            "coverage": dossier["coverage"],
            "provenance": {"dossier_artifact": dossier_artifact,
                           "dossier_revision": dossier["revision"],
                           "dossier_readiness": dossier["readiness"],
                           "dossier_schema": dossier["schema"],
                           "analysis": dossier.get("analysis_provenance"),
                           "scope_artifact": dossier["scope_artifact"],
                           "draft_artifacts": dossier["draft_artifacts"],
                           "review_artifacts": dossier["review_artifacts"],
                           "probe_report_artifacts": dossier["probe_report_artifacts"],
                           "probe_link_artifacts": dossier["probe_link_artifacts"],
                           "dependency_resolution_artifacts":
                               dossier["dependency_resolution_artifacts"],
                           "gap_adjudication_artifacts":
                               dossier["gap_adjudication_artifacts"],
                           "generator_sha256": hashlib.sha256(
                               Path(__file__).read_bytes()).hexdigest()}}


def render_markdown(spec: dict) -> str:
    lines = [f"# Native subsystem specification: {spec['title']}", "",
             f"Status: **{spec['status']}**  ",
             f"Dossier: `{spec['provenance']['dossier_artifact']}` revision "
             f"{spec['provenance']['dossier_revision']}  ",
             f"Binary SHA-256: `{spec['binary_sha256']}`", "",
             "## Boundary", "",
             f"Mode: {spec['boundary']['mode']}", "",
             "Included functions:", ""]
    for item in spec["boundary"]["included"]:
        lines.append(f"- `{item['entry']}` {item['name']}")
    for heading, key in (("Boundary contracts", "boundaries"),
                         ("Exclusions", "exclusions"),
                         ("Unresolved edges", "unresolved_edges"),
                         ("Observables to investigate", "expected_observables_to_investigate")):
        lines += ["", f"### {heading}", ""]
        for item in spec["boundary"][key]:
            lines.append(f"- {json.dumps(item, sort_keys=True) if isinstance(item, dict) else item}")
    lines += ["", "## Evidence-backed requirements", "",
              "Static support and original case agreement are separate. A case covers only its recorded input.", ""]
    for req in spec["requirements"]:
        lines.append(f"### {req['id']} · `{req['subject']}`")
        lines += ["", req["statement"], "",
                  f"Static review: {req['review_state']}; original execution: {req['execution_state']}.", "",
                  "Evidence: " + ", ".join(
                      f"`{ref['artifact']}@{ref['address']}`" for ref in req["evidence"]), ""]
        for key, label in (("assumptions", "Assumption"), ("alternatives", "Alternative")):
            for item in req[key]:
                lines.append(f"- {label}: {json.dumps(item, sort_keys=True) if isinstance(item, dict) else item}")
        for link in req["probe_links"]:
            lines.append(f"- Original case `{link['case_id']}`: "
                         f"{'agreement' if link['agreement'] else 'disagreement'}; "
                         f"observed `{json.dumps(link['observed'], sort_keys=True)}` "
                         f"at `{link['observed_pointer']}`.")
        lines.append("")
    lines += ["## Function notes and draft pseudocode", "",
              "These descriptions come from semantic drafts; read supported requirements and open issues before implementing.", ""]
    for function in spec["function_descriptions"]:
        lines += [f"### {function['name']} (`{function['entry']}`)", ""]
        for key in ("inputs", "outputs", "state", "side_effects", "errors"):
            lines.append(f"- {key.replace('_', ' ').title()}: {function[key]}")
        lines += ["", "```text", function["draft_pseudocode"], "```", ""]
        for item in function["unknowns"]:
            lines.append(f"- Unknown: {item}")
        for item in function["evidence_requests"]:
            lines.append(f"- Evidence requested: {item}")
        lines.append("")
    for heading, key in (("Dependency contracts", "dependency_contracts"),
                         ("Original cases", "original_cases"),
                         ("Claims withheld from requirements", "unresolved_claims"),
                         ("Independent review gaps", "review_gaps"),
                         ("Open blockers", "blockers")):
        lines += [f"## {heading}", ""]
        for item in spec[key]:
            lines.append(f"- {json.dumps(item, sort_keys=True)}")
        lines.append("")
    lines += ["## Coverage inventory", "", "```json",
              json.dumps(spec["coverage"], sort_keys=True, indent=2), "```", ""]
    return "\n".join(lines)


def persist_spec(state: Path, dossier_artifact: str) -> dict:
    state = Path(state)
    store = LocalArtifactStore(state / "artifacts")
    dossier = json.loads(store.get(dossier_artifact))
    spec = generate_spec(dossier, dossier_artifact)
    folder = state / "specifications" / spec["scope_id"]
    folder.mkdir(parents=True, exist_ok=True)
    artifact = store.put(canonical(spec))
    markdown = render_markdown(spec)
    markdown_artifact = store.put(markdown.encode())
    pointer = {"artifact": artifact, "markdown_artifact": markdown_artifact,
               "dossier_artifact": dossier_artifact, "status": spec["status"]}
    pointer_path = folder / (f"dossier-{dossier_artifact}-generator-"
                             f"{spec['provenance']['generator_sha256']}.json")
    if pointer_path.exists():
        _require(json.loads(pointer_path.read_text()) == pointer,
                 "specification pointer conflicts with immutable dossier revision")
    else:
        pointer_path.write_text(json.dumps(pointer, sort_keys=True) + "\n")
    markdown_path = folder / f"spec-{artifact}.md"
    if not markdown_path.exists():
        markdown_path.write_text(markdown)
    latest = folder / "latest.json"
    latest_revision = -1
    if latest.exists():
        latest_pointer = json.loads(latest.read_text())
        latest_spec = json.loads(store.get(latest_pointer["artifact"]))
        latest_revision = latest_spec["provenance"]["dossier_revision"]
    if latest_revision <= spec["provenance"]["dossier_revision"]:
        temporary = folder / "latest.tmp"
        temporary.write_text(json.dumps(pointer, sort_keys=True) + "\n")
        os.replace(temporary, latest)
        (folder / "latest.md").write_text(markdown)
    return {**pointer, "json_path": str(pointer_path),
            "markdown_path": str(markdown_path),
            "requirements": len(spec["requirements"]),
            "blockers": spec["blockers"]}
