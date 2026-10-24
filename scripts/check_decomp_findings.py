"""Check conditional finding publication, conflicts, and reverse invalidation."""

import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.dossier import assemble  # noqa: E402
from engine.findings import FindingsStore  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402
from engine.validation.dependencies import (complete_direct_call_dependencies,  # noqa: E402
                                            dependency_binding_errors,
                                            uncovered_direct_calls)


def put(store: LocalArtifactStore, value: dict) -> str:
    return store.put(json.dumps(value, sort_keys=True).encode())


def main() -> None:
    admin_dsn = os.environ.get(
        "DECOMP_TEST_PG_DSN", "host=127.0.0.1 port=55479 dbname=postgres user=mitch")
    dbname = "decomp_findings_check_" + uuid.uuid4().hex[:12]
    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
        try:
            with TemporaryDirectory() as temporary:
                store = LocalArtifactStore(Path(temporary))
                params = psycopg.conninfo.conninfo_to_dict(admin_dsn)
                params["dbname"] = dbname
                queue = DurableQueue(psycopg.conninfo.make_conninfo(**params), store)
                queue.migrate()
                campaign = "c" * 64
                queue.create_campaign(campaign, "b" * 64)
                index = put(store, {"schema": 1, "binary_sha256": "b" * 64})
                entries = [
                    ("helper_one", "00100000", "helper returns one"),
                    ("consumer", "00100010", "consumer returns one"),
                    ("dependent", "00100030", "dependent calls helper"),
                    ("unrelated", "00100020", "unrelated returns three"),
                    ("helper_revision", "00100000", "helper returns one"),
                    ("helper_conflict", "00100000", "helper returns two"),
                    ("multi_helper", "00100040", "first effect"),
                    ("multi_helper_conflict", "00100040", "second effect differs"),
                    ("unbound_caller", "00100050", "calls helper without a dependency"),
                    ("misbound_caller", "00100060", "cites the wrong direct call"),
                    ("gap_helper", "00100070", "returns a fixed value"),
                ]
                tasks = [{"kind": "behavior", "subject": address,
                          "question": f"Explain {name}: {statement}",
                          "priority": 100 - position,
                          "deduplication_key": f"{position:064x}",
                          "index_artifact": index}
                         for position, (name, address, statement) in enumerate(entries)]
                scope = {"campaign": campaign, "scope_id": "s" * 64, "revision": 1,
                         "tasks": tasks, "included": [{"entry": "00100030",
                                                      "name": "dependent"},
                                                     {"entry": "00100070",
                                                      "name": "gap_helper"}],
                         "unresolved": [], "boundaries": [{"entry": "00100000",
                                                            "name": "helper",
                                                            "contract": "returns one"}],
                         "request": {"query": "dependent", "mode": "subsystem",
                                     "seeds": ["dependent"], "expected_observables": []}}
                scope_artifact = put(store, scope)
                assert len(queue.enqueue_scope(scope_artifact)) == len(entries)

                def complete(position: int, dependencies: list | None = None,
                             statements: list[str] | None = None,
                             expected_state: str | None = None,
                             missing_behavior: list[str] | None = None) -> str:
                    name, address, statement = entries[position]
                    statements = statements or [statement]
                    lease = queue.lease(name, campaign=campaign)
                    assert lease and lease["subject"] == address
                    references = ([{"from": address, "to": "00100000",
                                    "type": "UNCONDITIONAL_CALL", "external": False}]
                                  if position in (2, 8) else [])
                    if position == 9:
                        references = [
                            {"from": "00100060", "to": "00100020",
                             "type": "UNCONDITIONAL_CALL", "external": False},
                            {"from": "00100061", "to": "00100000",
                             "type": "UNCONDITIONAL_CALL", "external": False}]
                    evidence_artifact = put(store, {"entry": address,
                                                    "instructions": [],
                                                    "references": references})
                    answer = {"inputs": "No explicit parameters", "outputs": statement,
                              "state": "No observed state", "side_effects": "None observed",
                              "errors": "No observed error path", "pseudocode": "return value",
                              "claims": [{"statement": item,
                                          "evidence_addresses": [address],
                                          "assumptions": [], "alternatives": []}
                                         for item in statements],
                              "dependencies": dependencies or [], "unknowns": [],
                              "evidence_requests": []}
                    draft = {"state": "unreviewed", "structural_errors": [],
                             "campaign": campaign, "subject": address,
                             "scope_artifact": scope_artifact,
                             "task_key": tasks[position]["deduplication_key"],
                             "evidence_artifact": evidence_artifact,
                             "evidence_truncated": False, "answer": answer}
                    draft_artifact = put(store, draft)
                    assert queue.submit(lease["task_id"], name, lease["epoch"],
                                        draft_artifact, name) == "accepted_for_validation"
                    assert queue.validate_result(lease["task_id"], draft_artifact,
                                                 "validated")
                    review = {"state": "reviewed", "structural_errors": [],
                              "model": "independent-model",
                              "draft_artifact": draft_artifact,
                              "evidence_artifact": evidence_artifact,
                              "campaign": campaign, "subject": address,
                              "answer": {"reviews": [{"claim_index": index,
                                                       "outcome": "supported_static",
                                                       "reason": "synthetic queue finding check",
                                                       "evidence_addresses": [address]}
                                                      for index in range(len(statements))],
                                         "missing_behavior": missing_behavior or [],
                                         "unresolved": []},
                              "outcomes": {"supported_static": len(statements)}}
                    outcome = queue.publish_review(lease["task_id"], put(store, review))
                    assert outcome == (expected_state or
                                       ("needs_reconciliation" if dependencies else "accepted"))
                    return lease["task_id"]

                findings = FindingsStore(queue)
                helper1 = complete(0)
                first = findings.publish_claims(helper1, {0: "return_value"})
                assert first[0]["state"] == "active"
                assert findings.publish_claims(helper1, {0: "return_value"})[0]["duplicate"]
                version1 = findings.publish_contract(helper1, 0, "helper", expected_version=0)
                assert version1["version"] == 1
                assert findings.publish_contract(helper1, 0, "helper",
                                                 expected_version=0)["duplicate"]

                consumer = complete(1)
                consumer_finding = findings.publish_claims(
                    consumer, {0: "return_value"}, dependency_versions={"helper": 1})[0]
                dependent = complete(2, [{"target": "helper", "contract": "helper returns one",
                                          "evidence_addresses": ["00100030"],
                                          "assumptions": []}],
                                     missing_behavior=["callee might fail"])
                assert queue.task(dependent)["state"] == "needs_reconciliation"
                try:
                    findings.publish_claims(dependent, {0: "return_value"})
                except ValueError:
                    pass
                else:
                    raise AssertionError("unresolved dependent claim was published")
                dependent_task = queue.task(dependent)
                dependent_draft = json.loads(store.get(dependent_task["result_artifact"]))
                dependent_case = {"case_id": "dependent_one", "target": "dependent",
                                  "binary_sha256": "b" * 64, "input": {"value": 1},
                                  "observed": {"return": 1}, "outcome": "agreement",
                                  "execution_mode": "original",
                                  "runner_sha256": "r" * 64,
                                  "adapter_sha256": "a" * 64}
                dependent_probe = put(store, dependent_case)
                dependent_report = put(store, {"schema": 1, "results": [
                    {**dependent_case, "artifact": dependent_probe}]})
                dependent_gap = put(store, {
                    "schema": 1, "state": "reviewed", "structural_errors": [],
                    "campaign": campaign, "task_id": dependent,
                    "draft_artifact": dependent_task["result_artifact"],
                    "review_artifact": dependent_task["review_artifact"],
                    "evidence_artifact": dependent_draft["evidence_artifact"],
                    "probe_report_artifact": dependent_report,
                    "probe_case_ids": ["dependent_one"], "model": "other-model",
                    "answer": {"items": [{"kind": "missing_behavior", "index": 0,
                                          "decision": "nonblocking",
                                          "reason": "caller has no separate failure path",
                                          "evidence_addresses": ["00100030"],
                                          "probe_case_ids": ["dependent_one"]}]}})
                assert queue.publish_gap_adjudication(
                    dependent, dependent_gap) == "needs_reconciliation"
                assert queue.task(dependent)["terminal_reason"] == \
                    "dependency_contracts_unreviewed"
                contract = json.loads(store.get(version1["artifact"]))
                caller = json.loads(store.get(dependent_draft["evidence_artifact"]))
                callee = json.loads(store.get(contract["evidence_artifact"]))
                assert not dependency_binding_errors(
                    dependent_draft["answer"]["dependencies"][0], caller, callee)
                assert dependency_binding_errors(
                    {"target": "helper", "evidence_addresses": ["00100031"]}, caller, callee)
                call_scope = {"included": [{"entry": "00100000", "name": "helper"}],
                              "boundaries": []}
                assert not uncovered_direct_calls(
                    dependent_draft["answer"]["dependencies"], caller, call_scope)
                assert uncovered_direct_calls(
                    [{"target": "wrong_helper", "evidence_addresses": ["00100030"]}],
                    caller, call_scope)[0]["target_name"] == "helper"
                completed, additions, completion_errors = complete_direct_call_dependencies(
                    [], caller, call_scope,
                    {"helper": {"contract_key": "helper", "subject": "00100000",
                                "statement": "helper returns one"}})
                assert not completion_errors and len(additions) == 1
                assert completed == [{"target": "helper", "contract": "helper returns one",
                                      "evidence_addresses": ["00100030"],
                                      "assumptions": []}]
                assert complete_direct_call_dependencies(
                    [], caller, call_scope,
                    {"helper": {"contract_key": "helper", "subject": "00100020",
                                "statement": "wrong target"}})[2]
                dependency_review = {"schema": 1, "state": "reviewed", "structural_errors": [],
                                     "campaign": campaign, "task_id": dependent,
                                     "draft_artifact": dependent_task["result_artifact"],
                                     "dependency_index": 0, "target": "helper",
                                     "contract_key": "helper", "contract_version": 1,
                                     "contract_artifact": version1["artifact"],
                                     "caller_evidence_artifact": json.loads(store.get(
                                         dependent_task["result_artifact"]))["evidence_artifact"],
                                     "callee_evidence_artifact": contract["evidence_artifact"],
                                     "answer": {"outcome": "supported_static",
                                                "reason": "synthetic dependency check",
                                                "evidence_addresses": ["00100030", "00100000"],
                                                "missing_info": []}}
                uncertain = {**dependency_review,
                             "answer": {**dependency_review["answer"],
                                        "outcome": "uncertain", "missing_info": ["Unknown call"]}}
                assert queue.resolve_dependencies(dependent, [put(store, uncertain)]) == "blocked"
                stale_pin = {**dependency_review, "contract_version": 2}
                assert queue.resolve_dependencies(dependent, [put(store, stale_pin)]) == "stale"
                assert queue.resolve_dependencies(dependent, [put(store, dependency_review)]) == "accepted"
                assert queue.task(dependent)["dependency_versions"] == {"helper": 1}
                assert queue.audit_accepted_dependencies(campaign) == 0
                try:
                    findings.publish_claims(dependent, {0: "return_value"},
                                            dependency_versions={"helper": 2})
                except ValueError:
                    pass
                else:
                    raise AssertionError("dependent accepted pins were changed")
                dependent_finding = findings.publish_claims(dependent, {0: "return_value"})[0]
                dependent_task = queue.task(dependent)
                dossier = assemble(SimpleNamespace(store=store),
                                   {"campaign": campaign, "binary_sha256": "b" * 64},
                                   scope_artifact, [dependent_task["result_artifact"]],
                                   [dependent_task["review_artifact"]], [], [],
                                   [dependent_task["dependency_resolution_artifact"]],
                                   queue.contract_snapshot(campaign))
                assert dossier["coverage"]["reviewed_dependency_contracts"] == 1
                assert dossier["coverage"]["current_dependency_contracts"] == 1
                assert not any(item["kind"] == "dependency_contracts_need_review"
                               for item in dossier["blockers"])
                offline_dossier = assemble(
                    SimpleNamespace(store=store),
                    {"campaign": campaign, "binary_sha256": "b" * 64},
                    scope_artifact, [dependent_task["result_artifact"]],
                    [dependent_task["review_artifact"]], [], [],
                    [dependent_task["dependency_resolution_artifact"]])
                assert any(item["kind"] == "dependency_contract_heads_unchecked"
                           for item in offline_dossier["blockers"])
                unrelated = complete(3)
                unrelated_finding = findings.publish_claims(unrelated, {0: "return_value"})[0]
                helper2 = complete(4)
                findings.publish_claims(helper2, {0: "return_value"})
                version2 = findings.publish_contract(helper2, 0, "helper", expected_version=1)
                assert version2["version"] == 2 and version2["invalidated"] == 2
                try:
                    findings.publish_contract(helper1, 0, "helper", expected_version=1)
                except ValueError:
                    pass
                else:
                    raise AssertionError("stale contract compare-and-swap succeeded")

                helper_conflict = complete(5)
                conflicted = findings.publish_claims(helper_conflict,
                                                      {0: "return_value"})[0]
                assert conflicted["state"] == "conflicted"
                inventory = findings.inventory(campaign)
                by_id = {item["id"]: item for item in inventory["findings"]}
                assert by_id[consumer_finding["finding_id"]]["state"] == "stale"
                assert by_id[dependent_finding["finding_id"]]["state"] == "stale"
                stale_dossier = assemble(
                    SimpleNamespace(store=store),
                    {"campaign": campaign, "binary_sha256": "b" * 64},
                    scope_artifact, [dependent_task["result_artifact"]],
                    [dependent_task["review_artifact"]], [], [],
                    [dependent_task["dependency_resolution_artifact"]],
                    queue.contract_snapshot(campaign))
                assert stale_dossier["coverage"]["current_dependency_contracts"] == 0
                assert any(item["kind"] == "dependency_contract_heads_stale"
                           for item in stale_dossier["blockers"])
                assert by_id[unrelated_finding["finding_id"]]["state"] == "active"
                assert inventory["contract_heads"][0]["state"] == "disputed"
                try:
                    findings.publish_claims(consumer, {0: "return_value"},
                                            dependency_versions={"helper": 2})
                except ValueError:
                    pass
                else:
                    raise AssertionError("disputed contract was used for publication")
                assert len([item for item in inventory["conflicts"]
                            if item["state"] == "open"]) == 2
                multi = complete(6, statements=["first effect", "second effect"])
                findings.publish_claims(multi, {0: "first_effect", 1: "second_effect"})
                multi_contract = findings.publish_contract_set(
                    multi, [0, 1], "multi_helper", expected_version=0)
                multi_content = json.loads(store.get(multi_contract["artifact"]))
                assert multi_content["claim_indices"] == [0, 1]
                assert len(multi_content["claims"]) == 2
                rival = complete(7)
                findings.publish_claims(rival, {0: "second_effect"})
                final_inventory = findings.inventory(campaign)
                assert next(head for head in final_inventory["contract_heads"]
                            if head["contract_key"] == "multi_helper")["state"] == "disputed"
                unbound = complete(8, expected_state="needs_reconciliation")
                assert queue.task(unbound)["terminal_reason"] == "direct_calls_unbound"
                misbound = complete(9, [{"target": "helper", "contract": "returns one",
                                         "evidence_addresses": ["00100060"],
                                         "assumptions": []}])
                repaired = queue.repair_dependency_citations(misbound)
                assert repaired["state"] == "validated"
                assert repaired["remaining_unbound_calls"] == 1
                repaired_draft = json.loads(store.get(repaired["result_artifact"]))
                assert repaired_draft["answer"]["dependencies"][0][
                    "evidence_addresses"] == ["00100061"]
                assert queue.repair_dependency_citations(misbound)["state"] == "invalid"
                gap_task = complete(10, expected_state="needs_reconciliation",
                                    missing_behavior=["register setup might affect output"])
                gap_state = queue.task(gap_task)
                gap_draft = json.loads(store.get(gap_state["result_artifact"]))
                original_case = {"case_id": "fixed_output", "target": "gap_helper",
                                 "binary_sha256": "b" * 64,
                                 "input": {"value": 1}, "observed": {"return": 1},
                                 "outcome": "agreement", "execution_mode": "original",
                                 "runner_sha256": "r" * 64,
                                 "adapter_sha256": "a" * 64}
                probe_case = put(store, original_case)
                report_artifact = put(store, {"schema": 1,
                    "results": [{**original_case, "artifact": probe_case}]})
                adjudication = {"schema": 1, "state": "reviewed",
                                "structural_errors": [], "campaign": campaign,
                                "task_id": gap_task,
                                "draft_artifact": gap_state["result_artifact"],
                                "review_artifact": gap_state["review_artifact"],
                                "evidence_artifact": gap_draft["evidence_artifact"],
                                "probe_report_artifact": report_artifact,
                                "probe_case_ids": ["fixed_output"],
                                "model": "separate-model",
                                "answer": {"items": [{"kind": "missing_behavior",
                                                      "index": 0,
                                                      "decision": "nonblocking",
                                                      "reason": "register setup is internal",
                                                      "evidence_addresses": ["00100070"],
                                                      "probe_case_ids": ["fixed_output"]}]}}
                assert queue.publish_gap_adjudication(
                    gap_task, put(store, {**adjudication,
                                          "model": "independent-model"})) == "invalid"
                blocked = json.loads(json.dumps(adjudication))
                blocked["answer"]["items"][0]["decision"] = "uncertain"
                assert queue.publish_gap_adjudication(
                    gap_task, put(store, blocked)) == "blocked"
                disagreeing_case = {**original_case, "case_id": "contrary_output",
                                    "observed": {"return": 2},
                                    "outcome": "disagreement"}
                disagreeing_report = put(store, {"schema": 1, "results": [
                    {**original_case, "artifact": probe_case},
                    {**disagreeing_case,
                     "artifact": put(store, disagreeing_case)}]})
                assert queue.publish_gap_adjudication(
                    gap_task, put(store, {**adjudication,
                                          "probe_report_artifact": disagreeing_report})) \
                    == "invalid"
                adjudication_artifact = put(store, adjudication)
                assert queue.publish_gap_adjudication(gap_task, adjudication_artifact) == "accepted"
                assert queue.task(gap_task)["review_gap_adjudication_artifact"] == \
                    adjudication_artifact
                print(json.dumps({"findings": len(final_inventory["findings"]),
                                  "open_conflicts": len(final_inventory["conflicts"]),
                                  "contract_version": version2["version"],
                                  "contract_state": "disputed",
                                  "multi_claim_contract_disputed": True,
                                  "dependent_state": "stale",
                                  "unrelated_state": "active"}, indent=2))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
