"""Run one bounded semantic attempt under a durable queue lease."""

from __future__ import annotations

import threading

from engine.queue import DurableQueue
from engine.worker import SemanticWorker


def run_one(queue: DurableQueue, worker: SemanticWorker, manifest: dict,
            worker_id: str, *, lease_seconds: int = 60,
            model: str | None = None, model_role: str = "decomp_worker") -> dict:
    lease = queue.lease(worker_id, campaign=manifest["campaign"],
                        lease_seconds=lease_seconds)
    if lease is None:
        return {"state": "idle"}
    if lease["campaign"] != manifest["campaign"]:
        queue.fail(lease["task_id"], worker_id, lease["epoch"],
                   "worker manifest does not match campaign", failure_type="infrastructure")
        return {"state": "manifest_mismatch", "task_id": lease["task_id"]}

    stop = threading.Event()
    lost = threading.Event()

    def renew() -> None:
        while not stop.wait(max(1, lease_seconds / 3)):
            try:
                if not queue.heartbeat(lease["task_id"], worker_id, lease["epoch"],
                                       lease_seconds=lease_seconds):
                    lost.set()
                    return
            except Exception:
                lost.set()
                return

    heartbeat = threading.Thread(target=renew, daemon=True)
    heartbeat.start()
    try:
        result = worker.run(manifest, lease["scope_artifact"], lease["subject"],
                            model=model, model_role=model_role)
    except Exception as error:
        stop.set()
        heartbeat.join()
        state = queue.fail(lease["task_id"], worker_id, lease["epoch"],
                           f"worker exception: {type(error).__name__}: {error}",
                           failure_type="infrastructure")
        return {"state": state, "task_id": lease["task_id"], "error": str(error)}
    finally:
        stop.set()
        heartbeat.join()

    if lost.is_set():
        return {"state": "lease_lost", "task_id": lease["task_id"],
                "draft_artifact": result.get("artifact")}
    if result["state"] != "unreviewed":
        failure_type = "budget" if result["state"] == "partial" else "semantic"
        state = queue.fail(lease["task_id"], worker_id, lease["epoch"],
                           f"semantic attempt ended {result['state']}",
                           failure_type=failure_type)
        return {"state": state, "task_id": lease["task_id"],
                "draft_artifact": result["artifact"]}

    submitted = queue.submit(lease["task_id"], worker_id, lease["epoch"],
                             result["artifact"], result["attempt_id"],
                             model=result.get("model"),
                             runtime_version=result.get("opencode_version"),
                             usage=result.get("usage"))
    if submitted != "accepted_for_validation":
        return {"state": submitted, "task_id": lease["task_id"],
                "draft_artifact": result["artifact"]}
    valid = queue.validate_result(lease["task_id"], result["artifact"], "validated")
    return {"state": "validated" if valid else "result_pending",
            "task_id": lease["task_id"], "draft_artifact": result["artifact"]}
