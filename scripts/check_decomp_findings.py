"""Check conditional finding publication, conflicts, and reverse invalidation."""

import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.findings import FindingsStore  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402


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
                ]
                tasks = [{"kind": "behavior", "subject": address,
                          "question": f"Explain {name}: {statement}",
                          "priority": 100 - position,
                          "deduplication_key": f"{position:064x}",
                          "index_artifact": index}
                         for position, (name, address, statement) in enumerate(entries)]
                scope = {"campaign": campaign, "scope_id": "s" * 64, "tasks": tasks}
                scope_artifact = put(store, scope)
                assert len(queue.enqueue_scope(scope_artifact)) == len(entries)

                def complete(position: int, dependencies: list | None = None) -> str:
                    name, address, statement = entries[position]
                    lease = queue.lease(name, campaign=campaign)
                    assert lease and lease["subject"] == address
                    evidence_artifact = put(store, {"entry": address,
                                                    "instructions": [], "references": []})
                    answer = {"inputs": "No explicit parameters", "outputs": statement,
                              "state": "No observed state", "side_effects": "None observed",
                              "errors": "No observed error path", "pseudocode": "return value",
                              "claims": [{"statement": statement,
                                          "evidence_addresses": [address],
                                          "assumptions": [], "alternatives": []}],
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
                              "draft_artifact": draft_artifact,
                              "evidence_artifact": evidence_artifact,
                              "campaign": campaign, "subject": address,
                              "answer": {"reviews": [{"claim_index": 0,
                                                       "outcome": "supported_static",
                                                       "reason": "synthetic queue finding check",
                                                       "evidence_addresses": [address]}],
                                         "missing_behavior": [], "unresolved": []},
                              "outcomes": {"supported_static": 1}}
                    outcome = queue.publish_review(lease["task_id"], put(store, review))
                    assert outcome == ("needs_reconciliation" if dependencies else "accepted")
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
                                          "assumptions": []}])
                assert queue.task(dependent)["state"] == "needs_reconciliation"
                try:
                    findings.publish_claims(dependent, {0: "return_value"})
                except ValueError:
                    pass
                else:
                    raise AssertionError("unresolved dependent claim was published")
                dependent_task = queue.task(dependent)
                contract = json.loads(store.get(version1["artifact"]))
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
                print(json.dumps({"findings": len(inventory["findings"]),
                                  "open_conflicts": len(inventory["conflicts"]),
                                  "contract_version": version2["version"],
                                  "contract_state": "disputed",
                                  "dependent_state": "stale",
                                  "unrelated_state": "active"}, indent=2))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
