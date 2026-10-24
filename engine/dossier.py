"""Immutable, evidence-linked subsystem dossier assembly and rendering."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from engine.analysis.ghidra import GhidraAnalysis
from engine.validation.dependencies import (dependency_binding_errors,
                                            uncovered_direct_calls,
                                            validate_dependency_review)
from engine.validation.gaps import (select_original_cases, validate_gap_answer)


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _claim_state(reviews: list[dict]) -> str:
    outcomes = {item["outcome"] for item in reviews}
    if "contradicted" in outcomes:
        return "contradicted"
    if "uncertain" in outcomes:
        return "uncertain"
    if "supported_static" in outcomes:
        return "supported_static"
    return "unreviewed"


def _pointer(value: object, path: str) -> object:
    if not isinstance(path, str) or not path.startswith("/"):
        raise ValueError("probe observation pointer must start with /")
    for component in path[1:].split("/"):
        key = component.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict):
            value = value[key]
        elif isinstance(value, list):
            value = value[int(key)]
        else:
            raise ValueError(f"probe observation pointer enters a scalar: {path}")
    return value


def assemble(engine: GhidraAnalysis, manifest: dict, scope_artifact: str,
             draft_artifacts: list[str], review_artifacts: list[str],
             probe_report_artifacts: list[str],
             probe_link_artifacts: list[str] = (),
             dependency_resolution_artifacts: list[str] = (),
             contract_snapshot: dict | None = None,
             gap_adjudication_artifacts: list[str] = ()) -> dict:
    scope = json.loads(engine.store.get(scope_artifact))
    if scope["campaign"] != manifest["campaign"]:
        raise ValueError("scope and manifest campaign differ")
    if contract_snapshot is not None and contract_snapshot.get("campaign") != manifest["campaign"]:
        raise ValueError("contract snapshot and manifest campaign differ")
    included = {item["entry"] for item in scope["included"]}
    drafts = {}
    for artifact in draft_artifacts:
        draft = json.loads(engine.store.get(artifact))
        if draft["campaign"] != manifest["campaign"] or draft["subject"] not in included:
            raise ValueError(f"draft {artifact} is outside the scope")
        if draft["state"] != "unreviewed" or draft["scope_artifact"] != scope_artifact:
            raise ValueError(f"draft {artifact} is not a valid scope draft")
        drafts[artifact] = draft
    reviews: dict[str, list[tuple[str, dict]]] = {}
    for artifact in review_artifacts:
        review = json.loads(engine.store.get(artifact))
        if review["draft_artifact"] not in drafts or review["state"] != "reviewed":
            raise ValueError(f"review {artifact} does not cover a provided draft")
        reviews.setdefault(review["draft_artifact"], []).append((artifact, review))
    gap_adjudications = {}
    names = {item["entry"]: item["name"] for item in scope["included"]}
    for artifact in gap_adjudication_artifacts:
        adjudication = json.loads(engine.store.get(artifact))
        review_artifact = adjudication.get("review_artifact")
        matches = [(draft_id, review) for draft_id, items in reviews.items()
                   for review_id, review in items if review_id == review_artifact]
        if len(matches) != 1 or review_artifact in gap_adjudications:
            raise ValueError(f"gap adjudication {artifact} has no unique provided review")
        draft_artifact, review = matches[0]
        draft = drafts[draft_artifact]
        evidence = json.loads(engine.store.get(draft["evidence_artifact"]))
        report_artifact = adjudication.get("probe_report_artifact")
        if report_artifact not in probe_report_artifacts:
            raise ValueError(f"gap adjudication {artifact} has no provided probe report")
        report = json.loads(engine.store.get(report_artifact))
        cases = select_original_cases(engine.store, report, manifest["binary_sha256"],
                                      names.get(draft["subject"]))
        if (adjudication.get("state") != "reviewed" or
                adjudication.get("structural_errors") != [] or
                adjudication.get("campaign") != manifest["campaign"] or
                adjudication.get("draft_artifact") != draft_artifact or
                adjudication.get("evidence_artifact") != draft["evidence_artifact"] or
                adjudication.get("model") == review.get("model") or
                not cases or adjudication.get("probe_case_ids") !=
                [case["case_id"] for case in cases] or
                validate_gap_answer(adjudication.get("answer"), review, evidence, cases)):
            raise ValueError(f"gap adjudication {artifact} is invalid or stale")
        gap_adjudications[review_artifact] = (artifact, adjudication)
    resolutions = {}
    for artifact in dependency_resolution_artifacts:
        resolution = json.loads(engine.store.get(artifact))
        draft_artifact = resolution.get("draft_artifact")
        draft = drafts.get(draft_artifact)
        if (resolution.get("schema") != 1 or
                resolution.get("campaign") != manifest["campaign"] or
                draft is None or
                resolution.get("claim_review_artifact") not in review_artifacts or
                draft_artifact in resolutions):
            raise ValueError(f"dependency resolution {artifact} does not cover a provided draft")
        dependency_claims = draft["answer"]["dependencies"]
        review_ids = resolution.get("dependency_reviews")
        if not isinstance(review_ids, list) or len(review_ids) != len(dependency_claims):
            raise ValueError(f"dependency resolution {artifact} has missing reviews")
        caller = json.loads(engine.store.get(draft["evidence_artifact"]))
        pins = {}
        reviewed = []
        for index, review_id in enumerate(review_ids):
            review = json.loads(engine.store.get(review_id))
            dependency = dependency_claims[index]
            contract = json.loads(engine.store.get(review["contract_artifact"]))
            callee = json.loads(engine.store.get(contract["evidence_artifact"]))
            key = dependency["target"]
            version = review.get("contract_version")
            if (review.get("state") != "reviewed" or
                    review.get("structural_errors") != [] or
                    review.get("campaign") != manifest["campaign"] or
                    review.get("draft_artifact") != draft_artifact or
                    review.get("dependency_index") != index or
                    review.get("target") != key or
                    review.get("contract_key") != key or
                    review.get("caller_evidence_artifact") != draft["evidence_artifact"] or
                    review.get("callee_evidence_artifact") != contract["evidence_artifact"] or
                    contract.get("campaign") != manifest["campaign"] or
                    contract.get("contract_key") != key or
                    review.get("answer", {}).get("outcome") != "supported_static" or
                    dependency_binding_errors(dependency, caller, callee) or
                    validate_dependency_review(review["answer"], caller, callee) or
                    not isinstance(version, int) or version < 1 or
                    (key in pins and pins[key] != version)):
                raise ValueError(f"dependency review {review_id} does not support {key}")
            pins[key] = version
            reviewed.append({"artifact": review_id, "version": version,
                             "contract_artifact": review["contract_artifact"],
                             "reason": review["answer"]["reason"]})
        if pins != resolution.get("dependency_versions"):
            raise ValueError(f"dependency resolution {artifact} has inconsistent pins")
        resolutions[draft_artifact] = (artifact, reviewed)
    probes = []
    probe_by_key = {}
    for artifact in probe_report_artifacts:
        report = json.loads(engine.store.get(artifact))
        for result in report["results"]:
            if result["binary_sha256"] == manifest["binary_sha256"]:
                key = (artifact, result["case_id"])
                if key in probe_by_key:
                    raise ValueError(f"duplicate probe case in report {key}")
                probe_by_key[key] = result
                probes.append({"report_artifact": artifact, "case_id": result["case_id"],
                               "kind": result["kind"], "target": result.get("target"),
                               "input": result["input"],
                               "expected": result["expected"],
                               "observed": result["observed"],
                               "outcome": result["outcome"],
                               "probe_artifact": result["artifact"],
                               "execution_mode": result.get("execution_mode"),
                               "runner_sha256": result.get("runner_sha256"),
                               "adapter_sha256": result.get("adapter_sha256")})
    probe_case_outcomes = {}
    for probe in probes:
        key = (probe["kind"], probe["target"], probe["case_id"],
               json.dumps(probe["input"], sort_keys=True))
        probe_case_outcomes.setdefault(key, set()).add(probe["outcome"])
    claims = []
    dependencies = []
    uncovered_calls = []
    function_summaries = []
    for artifact, draft in drafts.items():
        answer = draft["answer"]
        subject = draft["subject"]
        caller = json.loads(engine.store.get(draft["evidence_artifact"]))
        uncovered_calls.extend({"subject": subject, **call}
                               for call in uncovered_direct_calls(
                                   answer["dependencies"], caller, scope))
        function_summaries.append({"subject": subject, "draft_artifact": artifact,
                                   "inputs": answer["inputs"], "outputs": answer["outputs"],
                                   "state": answer["state"],
                                   "side_effects": answer["side_effects"],
                                   "errors": answer["errors"],
                                   "pseudocode": answer["pseudocode"],
                                   "unknowns": answer["unknowns"],
                                   "evidence_requests": answer.get("evidence_requests", [])})
        for i, claim in enumerate(answer["claims"]):
            claim_reviews = []
            for review_artifact, review in reviews.get(artifact, []):
                match = next(item for item in review["answer"]["reviews"]
                             if item["claim_index"] == i)
                claim_reviews.append({"review_artifact": review_artifact,
                                      "outcome": match["outcome"],
                                      "reason": match["reason"],
                                      "evidence_addresses": match["evidence_addresses"]})
            claims.append({"subject": subject, "statement": claim["statement"],
                           "evidence": [{"artifact": draft["evidence_artifact"],
                                         "address": address}
                                        for address in claim["evidence_addresses"]],
                           "assumptions": claim["assumptions"],
                           "alternatives": claim["alternatives"],
                           "draft_artifact": artifact, "claim_index": i,
                           "review_state": _claim_state(claim_reviews),
                           "reviews": claim_reviews,
                           "execution_state": "unmapped"})
        for index, dependency in enumerate(answer["dependencies"]):
            resolution = resolutions.get(artifact)
            review = resolution[1][index] if resolution else None
            head = ((contract_snapshot.get("heads", {}).get(dependency["target"])
                     if contract_snapshot is not None else None) if review else None)
            current = (head is not None and head.get("state") == "active" and
                       head.get("version") == review["version"] and
                       head.get("artifact") == review["contract_artifact"]) if review else False
            dependencies.append({"subject": subject, "target": dependency["target"],
                                 "contract": dependency["contract"],
                                 "evidence": [{"artifact": draft["evidence_artifact"],
                                               "address": address}
                                              for address in dependency.get("evidence_addresses", [])],
                                 "assumptions": dependency.get("assumptions", []),
                                 "review_state": "supported_static" if review else "unreviewed",
                                 "resolution_artifact": resolution[0] if resolution else None,
                                 "review_artifact": review["artifact"] if review else None,
                                 "contract_version": review["version"] if review else None,
                                 "contract_artifact": review["contract_artifact"] if review else None,
                                 "current_at_snapshot": current if contract_snapshot is not None
                                 and review else None})
    claim_by_key = {(item["draft_artifact"], item["claim_index"]): item
                    for item in claims}
    seen_links = set()
    for artifact in probe_link_artifacts:
        document = json.loads(engine.store.get(artifact))
        if document.get("schema") != 1 or not isinstance(document.get("links"), list):
            raise ValueError(f"invalid probe link artifact {artifact}")
        for link in document["links"]:
            key = (link["draft_artifact"], link["claim_index"])
            probe_key = (link["probe_report_artifact"], link["case_id"])
            identity = (*key, *probe_key, link["observed_pointer"])
            if identity in seen_links:
                raise ValueError(f"duplicate probe link {identity}")
            seen_links.add(identity)
            claim = claim_by_key.get(key)
            probe = probe_by_key.get(probe_key)
            if claim is None or probe is None:
                raise ValueError(f"probe link references unknown claim or case {identity}")
            if not isinstance(link.get("rationale"), str) or not link["rationale"].strip():
                raise ValueError(f"probe link needs rationale {identity}")
            try:
                observed = _pointer(probe["observed"], link["observed_pointer"])
            except (KeyError, IndexError, TypeError, ValueError) as error:
                raise ValueError(f"invalid probe observation pointer {identity}") from error
            agreement = (probe["outcome"] == "agreement" and
                         observed == link["expected_observed"])
            claim.setdefault("probe_links", []).append({"link_artifact": artifact,
                "report_artifact": probe_key[0], "case_id": probe_key[1],
                "probe_artifact": probe["artifact"],
                "observed_pointer": link["observed_pointer"],
                "observed": observed, "expected_observed": link["expected_observed"],
                "rationale": link["rationale"], "agreement": agreement})
    for claim in claims:
        links = claim.get("probe_links", [])
        if links:
            claim["execution_state"] = ("case_disagreement" if any(
                not link["agreement"] for link in links) else "case_agreement")
    drafted_subjects = {draft["subject"] for draft in drafts.values()}
    missing = sorted(included - drafted_subjects)
    blockers = []
    if missing:
        blockers.append({"kind": "missing_function_drafts", "subjects": missing})
    for edge in scope["unresolved"]:
        blockers.append({"kind": "unresolved_scope_edge", "edge": edge})
    for claim in claims:
        if claim["review_state"] != "supported_static":
            blockers.append({"kind": "claim_needs_resolution", "subject": claim["subject"],
                             "claim_index": claim["claim_index"],
                             "review_state": claim["review_state"]})
    review_gaps = []
    blocking_review_gaps = []
    for draft_artifact, items in reviews.items():
        for review_artifact, review in items:
            adjudication = gap_adjudications.get(review_artifact)
            decisions = ({(item["kind"], item["index"]): item for item in
                          adjudication[1]["answer"]["items"]} if adjudication else {})
            for field in ("missing_behavior", "unresolved"):
                for index, description in enumerate(review["answer"].get(field, [])):
                    decision = decisions.get((field, index))
                    gap = {"draft_artifact": draft_artifact,
                           "review_artifact": review_artifact,
                           "kind": field, "index": index,
                           "description": description,
                           "decision": decision["decision"] if decision else "unadjudicated",
                           "adjudication_artifact": adjudication[0] if adjudication else None,
                           "adjudication_reason": decision["reason"] if decision else None}
                    review_gaps.append(gap)
                    if gap["decision"] != "nonblocking":
                        blocking_review_gaps.append(gap)
    if blocking_review_gaps:
        blockers.append({"kind": "independent_review_gaps",
                         "items": blocking_review_gaps})
    unreviewed_dependencies = [item for item in dependencies
                               if item["review_state"] != "supported_static"]
    if unreviewed_dependencies:
        blockers.append({"kind": "dependency_contracts_need_review",
                         "count": len(unreviewed_dependencies)})
    unchecked_dependencies = [item for item in dependencies
                              if item["review_state"] == "supported_static" and
                              item["current_at_snapshot"] is None]
    if unchecked_dependencies:
        blockers.append({"kind": "dependency_contract_heads_unchecked",
                         "count": len(unchecked_dependencies)})
    stale_dependencies = [item for item in dependencies
                          if item["current_at_snapshot"] is False]
    if stale_dependencies:
        blockers.append({"kind": "dependency_contract_heads_stale",
                         "targets": sorted({item["target"] for item in stale_dependencies})})
    uncited_dependencies = [item["target"] for item in dependencies if not item["evidence"]]
    if uncited_dependencies:
        blockers.append({"kind": "dependency_contracts_missing_citations",
                         "targets": uncited_dependencies})
    if uncovered_calls:
        blockers.append({"kind": "direct_calls_without_bound_dependencies",
                         "calls": uncovered_calls})
    unmapped = [claim for claim in claims if claim["execution_state"] == "unmapped"]
    if unmapped:
        blockers.append({"kind": "claims_not_linked_to_original_probes",
                         "count": len(unmapped)})
    disagreements = [claim for claim in claims
                     if claim["execution_state"] == "case_disagreement"]
    if disagreements:
        blockers.append({"kind": "claim_probe_disagreements",
                         "count": len(disagreements)})
    record = {"schema": 1, "campaign": manifest["campaign"],
              "renderer_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "binary_sha256": manifest["binary_sha256"],
              "scope_artifact": scope_artifact, "scope_id": scope["scope_id"],
              "scope_revision": scope["revision"], "scope": scope,
              "draft_artifacts": sorted(drafts),
              "review_artifacts": sorted(review_artifacts),
              "probe_report_artifacts": sorted(probe_report_artifacts),
              "probe_link_artifacts": sorted(probe_link_artifacts),
              "dependency_resolution_artifacts": sorted(dependency_resolution_artifacts),
              "gap_adjudication_artifacts": sorted(gap_adjudication_artifacts),
              "contract_snapshot": contract_snapshot,
              "analysis_provenance": {
                  "drafts": [{"artifact": artifact, "subject": draft["subject"],
                              "model": draft.get("model"),
                              "model_role": draft.get("model_role"),
                              "runtime_version": draft.get("opencode_version"),
                              "prompt_version": draft.get("prompt_version"),
                              "record_schema": draft.get("schema"),
                              "evidence_truncated": draft.get("evidence_truncated")}
                             for artifact, draft in sorted(drafts.items())],
                  "reviews": [{"artifact": artifact,
                               "draft_artifact": draft_artifact,
                               "model": review.get("model"),
                               "model_role": review.get("model_role"),
                               "runtime_version": review.get("opencode_version"),
                               "prompt_version": review.get("prompt_version"),
                               "record_schema": review.get("schema")}
                              for draft_artifact, items in sorted(reviews.items())
                              for artifact, review in items]},
              "functions": sorted(function_summaries, key=lambda item: item["subject"]),
              "claims": claims, "dependency_contracts": dependencies,
              "uncovered_direct_calls": uncovered_calls,
              "independent_review_gaps": review_gaps,
              "probes": probes, "blockers": blockers,
              "coverage": {"included_functions": len(included),
                           "drafted_functions": len(drafted_subjects),
                           "claims": len(claims),
                           "static_supported_claims": sum(
                               claim["review_state"] == "supported_static" for claim in claims),
                           "independent_review_gaps": len(review_gaps),
                           "blocking_review_gaps": len(blocking_review_gaps),
                           "reviewed_dependency_contracts": len(dependencies) -
                               len(unreviewed_dependencies),
                           "current_dependency_contracts": sum(
                               item["current_at_snapshot"] is True for item in dependencies),
                           "uncovered_direct_calls": len(uncovered_calls),
                           "claims_with_case_agreement": sum(
                               claim["execution_state"] == "case_agreement" for claim in claims),
                           "claims_with_case_disagreement": len(disagreements),
                           "original_probe_runs": len(probes),
                           "original_probe_cases": len(probe_case_outcomes),
                           "original_probe_agreements": sum(
                               outcomes == {"agreement"} for outcomes in
                               probe_case_outcomes.values())},
              "readiness": "partial"}
    return record


def render_markdown(dossier: dict) -> str:
    scope = dossier["scope"]
    lines = [f"# Subsystem dossier: {scope['request']['query']}", "",
             f"Campaign: `{dossier['campaign']}`  ",
             f"Binary SHA-256: `{dossier['binary_sha256']}`  ",
             f"Scope revision: {dossier['scope_revision']}  ",
             f"Readiness: **{dossier['readiness']}**", "",
             "## Declared boundary", "",
             f"Mode: {scope['request']['mode']}. Seeds: {', '.join(scope['request']['seeds'])}.", "",
             "Included functions: " + ", ".join(
                 f"{item['name']} (`{item['entry']}`)" for item in scope["included"]), "",
             "Expected observables to investigate:", ""]
    for observable in scope["request"]["expected_observables"]:
        lines.append(f"- {observable}")
    lines += ["", "Boundary contracts:", ""]
    for boundary in scope["boundaries"]:
        lines.append(f"- `{boundary['entry']}` {boundary['name']}: "
                     f"{boundary.get('contract') or 'contract missing'}")
    lines += ["", "Unresolved scope edges:", ""]
    for edge in scope["unresolved"]:
        lines.append(f"- {json.dumps(edge, sort_keys=True)}")
    lines += ["", "## Function behavior", ""]
    for function in dossier["functions"]:
        lines += [f"### `{function['subject']}`", "",
                  f"Inputs: {function['inputs']}", "",
                  f"Outputs: {function['outputs']}", "",
                  f"State: {function['state']}", "",
                  f"Side effects: {function['side_effects']}", "",
                  f"Errors: {function['errors']}", "",
                  "```text", function["pseudocode"], "```", ""]
        for unknown in function["unknowns"]:
            lines.append(f"- Unknown: {unknown}")
        for request in function["evidence_requests"]:
            lines.append(f"- Evidence requested: {request}")
        lines.append("")
    lines += ["## Evidence-linked claims", ""]
    for claim in dossier["claims"]:
        evidence_artifact = claim["evidence"][0]["artifact"] if claim["evidence"] else "none"
        refs = ", ".join(f"`{ref['address']}`" for ref in claim["evidence"])
        lines += [f"- **{claim['review_state']}** · `{claim['subject']}` · "
                  f"{claim['statement']} Evidence artifact: `{evidence_artifact}`; "
                  f"addresses: {refs}. "
                  f"Execution: {claim['execution_state']}."]
        for assumption in claim["assumptions"]:
            lines.append(f"  - Assumption: {assumption}")
        for alternative in claim["alternatives"]:
            lines.append(f"  - Alternative: {alternative}")
        for review in claim["reviews"]:
            lines.append(f"  - Review `{review['review_artifact']}`: {review['reason']}")
        for link in claim.get("probe_links", []):
            lines.append(f"  - Original case `{link['case_id']}` "
                         f"(`{link['observed_pointer']}` = "
                         f"`{json.dumps(link['observed'])}`): {link['rationale']} "
                         f"({'agreement' if link['agreement'] else 'disagreement'})")
    lines += ["", "## Dependency contracts", ""]
    for dependency in dossier["dependency_contracts"]:
        refs = ", ".join(f"`{ref['artifact']}@{ref['address']}`"
                         for ref in dependency["evidence"]) or "no citation"
        lines.append(f"- `{dependency['subject']}` → {dependency['target']}: "
                     f"{dependency['contract']} ({dependency['review_state']}; {refs})")
        if dependency["review_artifact"]:
            lines.append(f"  - Reviewed against contract v{dependency['contract_version']} "
                         f"(`{dependency['contract_artifact']}`); review "
                         f"`{dependency['review_artifact']}`; resolution "
                         f"`{dependency['resolution_artifact']}`")
            lines.append(f"  - Current at recorded head snapshot: "
                         f"{dependency['current_at_snapshot']}")
    lines += ["", "## Direct calls without bound dependencies", ""]
    for call in dossier["uncovered_direct_calls"]:
        lines.append(f"- `{call['subject']}@{call['call_site']}` → "
                     f"{call['target_name'] or call['target_entry']} "
                     f"(`{call['target_entry']}`); declared at site: "
                     f"{', '.join(call['declared_targets']) or 'none'}")
    lines += ["", "## Independent review gaps", ""]
    for gap in dossier["independent_review_gaps"]:
        lines.append(f"- **{gap['decision']}** {gap['kind']} · draft "
                     f"`{gap['draft_artifact']}` · review "
                     f"`{gap['review_artifact']}`: {gap['description']}")
        if gap["adjudication_artifact"]:
            lines.append(f"  - Adjudication `{gap['adjudication_artifact']}`: "
                         f"{gap['adjudication_reason']}")
    lines += ["", "## Original-execution probes", ""]
    for probe in dossier["probes"]:
        lines.append(f"- **{probe['outcome']}** · {probe['case_id']} · "
                     f"artifact `{probe['probe_artifact']}`")
        lines.append(f"  - Input: `{json.dumps(probe['input'], sort_keys=True)}`")
        lines.append(f"  - Observed: `{json.dumps(probe['observed'], sort_keys=True)}`")
    lines += ["", "## Open blockers", ""]
    for blocker in dossier["blockers"]:
        lines.append(f"- {json.dumps(blocker, sort_keys=True)}")
    lines += ["", "## Coverage inventory", "",
              "```json", json.dumps(dossier["coverage"], indent=2), "```", ""]
    return "\n".join(lines)


def persist_dossier(engine: GhidraAnalysis, manifest: dict, scope_artifact: str,
                    draft_artifacts: list[str], review_artifacts: list[str],
                    probe_report_artifacts: list[str],
                    probe_link_artifacts: list[str] = (),
                    dependency_resolution_artifacts: list[str] = (),
                    contract_snapshot: dict | None = None,
                    gap_adjudication_artifacts: list[str] = ()) -> dict:
    record = assemble(engine, manifest, scope_artifact, draft_artifacts,
                      review_artifacts, probe_report_artifacts, probe_link_artifacts,
                      dependency_resolution_artifacts, contract_snapshot,
                      gap_adjudication_artifacts)
    scope_id = record["scope_id"]
    folder = engine.root / "dossiers" / scope_id
    folder.mkdir(parents=True, exist_ok=True)
    latest = folder / "latest.json"
    content_hash = hashlib.sha256(canonical(record)).hexdigest()
    if latest.exists():
        previous = json.loads(latest.read_text())
        if previous["content_hash"] == content_hash:
            return {**record, "revision": previous["revision"],
                    "artifact": previous["artifact"],
                    "markdown_artifact": previous["markdown_artifact"]}
        revision = previous["revision"] + 1
    else:
        revision = 1
    record["revision"] = revision
    markdown = render_markdown(record)
    markdown_artifact = engine.store.put(markdown.encode())
    artifact = engine.store.put(canonical(record))
    pointer = {"revision": revision, "artifact": artifact,
               "markdown_artifact": markdown_artifact, "content_hash": content_hash}
    with (folder / f"revision-{revision:06d}.json").open("x") as stream:
        stream.write(json.dumps(pointer, sort_keys=True) + "\n")
    temporary = latest.with_suffix(".tmp")
    temporary.write_text(json.dumps(pointer, sort_keys=True) + "\n")
    os.replace(temporary, latest)
    (folder / "latest.md").write_text(markdown)
    engine._emit(manifest["campaign"], "dossier_assembled", scope_id=scope_id,
                 revision=revision, readiness=record["readiness"],
                 coverage=record["coverage"], artifact=artifact,
                 markdown_artifact=markdown_artifact)
    return {**record, "artifact": artifact, "markdown_artifact": markdown_artifact}
