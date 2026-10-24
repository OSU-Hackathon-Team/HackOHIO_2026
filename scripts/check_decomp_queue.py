"""Run the durable queue lifecycle against a disposable PostgreSQL database."""

from concurrent.futures import ThreadPoolExecutor
import json
import multiprocessing
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402
from engine.worker import validate_answer  # noqa: E402


def put(store: LocalArtifactStore, value: dict) -> str:
    return store.put(json.dumps(value, sort_keys=True).encode())


def hold_lease(dsn: str, store_root: str, campaign: str,
               checkpoint: str, connection) -> None:
    queue = DurableQueue(dsn, LocalArtifactStore(Path(store_root)))
    lease = queue.lease("killed-worker", campaign=campaign, lease_seconds=1)
    if lease is None:
        connection.send(None)
        return
    queue.checkpoint(lease["task_id"], lease["worker_id"], lease["epoch"], checkpoint)
    connection.send(lease)
    while True:
        time.sleep(60)


def main() -> None:
    admin_dsn = os.environ.get(
        "DECOMP_TEST_PG_DSN", "host=127.0.0.1 port=55479 dbname=postgres user=mitch")
    dbname = "decomp_queue_check_" + uuid.uuid4().hex[:12]
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
                tasks = []
                for i in range(17):
                    subject = f"{0x100000 + i * 16:08x}"
                    tasks.append({"schema": 1, "kind": "behavior", "subject": subject,
                                  "question": f"Explain function {subject}", "priority": 50,
                                  "deduplication_key": f"{i:064x}",
                                  "index_artifact": index})
                scope = {"campaign": campaign, "scope_id": "s" * 64, "tasks": tasks}
                scope_artifact = put(store, scope)
                assert len(queue.enqueue_scope(scope_artifact)) == 17
                assert queue.enqueue_scope(scope_artifact) == []

                with ThreadPoolExecutor(max_workers=17) as executor:
                    futures = [executor.submit(queue.lease, f"worker-{i}", lease_seconds=60)
                               for i in range(17)]
                    leases = [future.result() for future in futures]
                active = [lease for lease in leases if lease]
                assert len(active) == 16, len(active)
                assert len({lease["worker_id"] for lease in active}) == 16
                assert queue.status(campaign)["pools"][1]["active"] == 16
                assert queue.lease("overflow") is None

                lost = active[0]
                checkpoint = put(store, {"progress": "decoded first block"})
                assert queue.heartbeat(lost["task_id"], lost["worker_id"], lost["epoch"])
                assert queue.checkpoint(lost["task_id"], lost["worker_id"],
                                        lost["epoch"], checkpoint)
                with queue._connect() as conn:
                    conn.execute("UPDATE decomp_tasks SET lease_until = now() - interval '1 second' "
                                 "WHERE id = %s", (lost["task_id"],))
                assert queue.reclaim_expired() == 1
                recovered = queue.lease("replacement")
                assert recovered["task_id"] == lost["task_id"]
                assert recovered["epoch"] == lost["epoch"] + 1
                assert recovered["checkpoint_artifact"] == checkpoint
                assert queue.heartbeat(lost["task_id"], lost["worker_id"],
                                       lost["epoch"]) is False

                evidence = {"schema": 1, "entry": recovered["subject"],
                            "instructions": [], "references": []}
                evidence_artifact = put(store, evidence)
                answer = {"inputs": "No explicit parameters", "outputs": "Returns a value",
                          "state": "No observed state", "side_effects": "None observed",
                          "errors": "No observed error path", "pseudocode": "return value",
                          "claims": [{"statement": "Returns a value",
                                      "evidence_addresses": [recovered["subject"]],
                                      "assumptions": [], "alternatives": []}],
                          "dependencies": [], "unknowns": [], "evidence_requests": []}
                draft = {"state": "unreviewed", "structural_errors": [],
                         "campaign": campaign, "subject": recovered["subject"],
                         "scope_artifact": scope_artifact,
                         "task_key": next(t["deduplication_key"] for t in tasks
                                          if t["subject"] == recovered["subject"]),
                         "evidence_artifact": evidence_artifact,
                         "evidence_truncated": False, "answer": answer}
                draft_artifact = put(store, draft)
                try:
                    queue.submit(recovered["task_id"], recovered["worker_id"],
                                 recovered["epoch"], "0" * 64, "missing-artifact")
                except FileNotFoundError:
                    pass
                else:
                    raise AssertionError("missing artifact was published")
                assert queue.submit(lost["task_id"], lost["worker_id"], lost["epoch"],
                                    draft_artifact, "old-attempt") == "stale"
                assert queue.submit(recovered["task_id"], recovered["worker_id"],
                                    recovered["epoch"], draft_artifact,
                                    "new-attempt") == "accepted_for_validation"
                assert queue.submit(recovered["task_id"], recovered["worker_id"],
                                    recovered["epoch"], draft_artifact,
                                    "new-attempt") == "duplicate"
                bad = put(store, {**draft, "subject": "deadbeef"})
                assert not queue.validate_result(recovered["task_id"], bad, "validated")
                assert queue.validate_result(recovered["task_id"], draft_artifact,
                                             "validated")
                review_answer = {"reviews": [{"claim_index": 0,
                                              "outcome": "supported_static",
                                              "reason": "Entry address supports the claim",
                                              "evidence_addresses": [recovered["subject"]]}],
                                 "missing_behavior": [], "unresolved": []}
                review = {"state": "reviewed", "structural_errors": [],
                          "draft_artifact": draft_artifact,
                          "evidence_artifact": evidence_artifact,
                          "campaign": campaign, "subject": recovered["subject"],
                          "answer": review_answer, "outcomes": {"supported_static": 1}}
                contradicted = put(store, {**review, "answer": {
                    **review_answer, "reviews": [{**review_answer["reviews"][0],
                                                 "outcome": "contradicted"}]}})
                assert not queue.accept(recovered["task_id"], contradicted)
                assert queue.accept(recovered["task_id"], put(store, review))
                assert not queue.accept(recovered["task_id"], put(store, review))

                dependent = active[2]
                dependent_evidence = put(store, {**evidence, "entry": dependent["subject"]})
                dependent_claim = {**answer["claims"][0],
                                   "evidence_addresses": [dependent["subject"]]}
                dependent_draft = {**draft, "subject": dependent["subject"],
                                   "task_key": next(t["deduplication_key"] for t in tasks
                                                    if t["subject"] == dependent["subject"]),
                                   "evidence_artifact": dependent_evidence,
                                   "answer": {**answer, "claims": [dependent_claim],
                                              "dependencies": [{"target": "helper",
                                                                "contract": "helper result",
                                                                "evidence_addresses": [dependent["subject"]],
                                                                "assumptions": []}]}}
                dependent_artifact = put(store, dependent_draft)
                assert queue.submit(dependent["task_id"], dependent["worker_id"],
                                    dependent["epoch"], dependent_artifact,
                                    "dependent-attempt") == "accepted_for_validation"
                assert queue.validate_result(dependent["task_id"], dependent_artifact,
                                             "validated")
                dependent_review = {**review, "subject": dependent["subject"],
                                    "draft_artifact": dependent_artifact,
                                    "evidence_artifact": dependent_evidence,
                                    "answer": {**review_answer, "reviews": [{
                                        **review_answer["reviews"][0],
                                        "evidence_addresses": [dependent["subject"]]}]}}
                assert queue.publish_review(dependent["task_id"],
                                            put(store, dependent_review)) == "needs_reconciliation"
                assert queue.task(dependent["task_id"])["support_level"] == "static_only"
                assert queue.task(dependent["task_id"])["terminal_reason"] == (
                    "dependency_contracts_unreviewed")
                with queue._connect() as conn:
                    conn.execute("UPDATE decomp_tasks SET state = 'accepted', "
                                 "terminal_reason = NULL WHERE id = %s",
                                 (dependent["task_id"],))
                assert queue.audit_accepted_dependencies(campaign) == 1
                assert queue.audit_accepted_dependencies(campaign) == 0
                assert queue.task(dependent["task_id"])["state"] == "needs_reconciliation"

                restarted = DurableQueue(queue.dsn, store)
                status = restarted.status(campaign)
                assert status["tasks"]["accepted"] == 1
                assert status["tasks"]["needs_reconciliation"] == 1
                assert status["support_levels"]["static_only"] == 2
                assert len([e for e in restarted.events(campaign, limit=100)
                            if e["event_type"] == "review_recorded" and
                            e["payload"]["state"] == "accepted"]) == 1
                parent, child = multiprocessing.Pipe(duplex=False)
                process = multiprocessing.Process(
                    target=hold_lease,
                    args=(queue.dsn, temporary, campaign, checkpoint, child))
                process.start()
                killed = parent.recv()
                assert killed is not None
                process.terminate()
                process.join(timeout=5)
                assert process.exitcode is not None
                time.sleep(1.1)
                assert queue.reclaim_expired() == 1
                resumed = queue.lease("after-kill", campaign=campaign)
                assert resumed["task_id"] == killed["task_id"]
                assert resumed["epoch"] == killed["epoch"] + 1
                assert resumed["checkpoint_artifact"] == checkpoint
                failed = active[1]
                rejected_artifact = put(store, {"state": "rejected",
                                                "structural_errors": ["missing claim"]})
                assert queue.fail(failed["task_id"], failed["worker_id"],
                                  failed["epoch"], "invalid semantic draft",
                                  failure_type="semantic",
                                  artifact=rejected_artifact,
                                  model="test/model", usage={"input": 10,
                                                               "output": 5,
                                                               "cost": 0.1}) == "partial"
                assert queue.task(failed["task_id"])["result_artifact"] == rejected_artifact
                failure_metrics = queue.metrics(campaign, worker_prefix=failed["worker_id"])
                assert failure_metrics["usage"]["cost"] == 0.1
                assert failure_metrics["models"] == {"test/model": 1}
                assert failure_metrics["attempts_with_timing"] == 1
                assert queue.reassess(failed["task_id"], "correct missing claim")
                reassessed = queue.lease("reassessment-worker", campaign=campaign)
                assert reassessed["task_id"] == failed["task_id"]
                assert reassessed["epoch"] == failed["epoch"] + 1
                assert reassessed["checkpoint_artifact"] == rejected_artifact
                shape_task = active[3]
                shape_evidence = {**evidence, "entry": shape_task["subject"]}
                shape_evidence_artifact = put(store, shape_evidence)
                shape_answer = {**answer,
                                "claims": [{**answer["claims"][0],
                                            "evidence_addresses": ["0x" +
                                                                   shape_task["subject"]]}],
                                "unknowns": [{"description": "width unclear"}]}
                shape_draft = {**draft, "state": "rejected",
                               "subject": shape_task["subject"],
                               "task_key": next(t["deduplication_key"] for t in tasks
                                                if t["subject"] == shape_task["subject"]),
                               "evidence_artifact": shape_evidence_artifact,
                               "answer": shape_answer,
                               "structural_errors": validate_answer(
                                   shape_answer, shape_evidence)}
                shape_artifact = put(store, shape_draft)
                assert queue.fail(shape_task["task_id"], shape_task["worker_id"],
                                  shape_task["epoch"], "shape mismatch",
                                  failure_type="semantic", artifact=shape_artifact) == "partial"
                normalized = queue.normalize_partial(shape_task["task_id"])
                assert normalized["state"] == "validated"
                assert len(normalized["citation_changes"]) == 1
                assert len(normalized["text_item_changes"]) == 1
                assert queue.normalize_partial(shape_task["task_id"])["state"] == "invalid"
                normalized_draft = json.loads(store.get(normalized["result_artifact"]))
                assert normalized_draft["source_artifact"] == shape_artifact
                assert not validate_answer(normalized_draft["answer"], shape_evidence)
                review_lease = queue.lease_review("review-worker", campaign=campaign)
                assert review_lease["task_id"] == shape_task["task_id"]
                assert queue.heartbeat_review(shape_task["task_id"], "review-worker",
                                              review_lease["epoch"])
                shape_review = {**review, "subject": shape_task["subject"],
                                "draft_artifact": normalized["result_artifact"],
                                "evidence_artifact": shape_evidence_artifact,
                                "answer": {**review_answer, "reviews": [{
                                    **review_answer["reviews"][0],
                                    "evidence_addresses": [shape_task["subject"]]}]}}
                shape_review_artifact = put(store, shape_review)
                assert queue.publish_review(shape_task["task_id"],
                                            shape_review_artifact) == "accepted"
                assert queue.finish_review(shape_task["task_id"], "review-worker",
                                           review_lease["epoch"], shape_review_artifact)
                assert queue.status(campaign)["reviews"]["completed"] >= 2
                malformed = active[4]
                failed_artifact = put(store, {"state": "failed", "error": "malformed JSON"})
                assert queue.fail(malformed["task_id"], malformed["worker_id"],
                                  malformed["epoch"], "malformed model output",
                                  failure_type="semantic", artifact=failed_artifact) == "partial"
                assert queue.reassess(malformed["task_id"], "retry malformed output")
                with queue._connect() as conn:
                    row = conn.execute("SELECT checkpoint_artifact FROM decomp_tasks "
                                       "WHERE id = %s", (malformed["task_id"],)).fetchone()
                assert row["checkpoint_artifact"] is None
                no_artifact = active[5]
                assert queue.fail(no_artifact["task_id"], no_artifact["worker_id"],
                                  no_artifact["epoch"], "no model artifact",
                                  failure_type="semantic") == "partial"
                assert queue.reassess(no_artifact["task_id"], "retry without prior output")
                review_recovery = active[6]
                recovery_evidence = put(store, {**evidence,
                                                "entry": review_recovery["subject"]})
                recovery_draft = {**draft, "subject": review_recovery["subject"],
                                  "task_key": next(t["deduplication_key"] for t in tasks
                                                   if t["subject"] == review_recovery["subject"]),
                                  "evidence_artifact": recovery_evidence,
                                  "answer": {**answer, "claims": [{**answer["claims"][0],
                                      "evidence_addresses": [review_recovery["subject"]]}]}}
                recovery_artifact = put(store, recovery_draft)
                assert queue.submit(review_recovery["task_id"], review_recovery["worker_id"],
                                    review_recovery["epoch"], recovery_artifact,
                                    "review-recovery") == "accepted_for_validation"
                assert queue.validate_result(review_recovery["task_id"], recovery_artifact,
                                             "validated")
                expired_review = queue.lease_review("review-killed", campaign=campaign,
                                                    lease_seconds=1)
                assert expired_review["task_id"] == review_recovery["task_id"]
                with queue._connect() as conn:
                    conn.execute("UPDATE decomp_review_jobs SET lease_until = "
                                 "now() - interval '1 second' WHERE task_id = %s",
                                 (review_recovery["task_id"],))
                assert queue.reclaim_expired_reviews() == 1
                resumed_review = queue.lease_review("review-replacement", campaign=campaign)
                assert resumed_review["task_id"] == review_recovery["task_id"]
                assert resumed_review["epoch"] == expired_review["epoch"] + 1
                final_status = queue.status(campaign)
                print(json.dumps({"active_leases": 16, "recovered_epoch": recovered["epoch"],
                                  "killed_worker_recovered_epoch": resumed["epoch"],
                                  "accepted": 1, "needs_reconciliation": 1,
                                  "static_only": 2,
                                  "rejected_attempt_preserved": True,
                                  "event_cursor": final_status["event_cursor"]}, indent=2))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
