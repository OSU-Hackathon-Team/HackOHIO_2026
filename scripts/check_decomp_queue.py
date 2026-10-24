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

                restarted = DurableQueue(queue.dsn, store)
                status = restarted.status(campaign)
                assert status["tasks"]["accepted"] == 1
                assert status["support_levels"]["static_only"] == 1
                assert len([e for e in restarted.events(campaign, limit=100)
                            if e["event_type"] == "task_accepted"]) == 1
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
                                  artifact=rejected_artifact) == "partial"
                assert queue.task(failed["task_id"])["result_artifact"] == rejected_artifact
                assert queue.reassess(failed["task_id"], "correct missing claim")
                reassessed = queue.lease("reassessment-worker", campaign=campaign)
                assert reassessed["task_id"] == failed["task_id"]
                assert reassessed["epoch"] == failed["epoch"] + 1
                assert reassessed["checkpoint_artifact"] == rejected_artifact
                final_status = queue.status(campaign)
                print(json.dumps({"active_leases": 16, "recovered_epoch": recovered["epoch"],
                                  "killed_worker_recovered_epoch": resumed["epoch"],
                                  "accepted": 1, "support_level": "static_only",
                                  "rejected_attempt_preserved": True,
                                  "event_cursor": final_status["event_cursor"]}, indent=2))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
