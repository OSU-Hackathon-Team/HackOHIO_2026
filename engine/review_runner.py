"""Run one independently reviewed draft under a durable review-pool lease."""

from __future__ import annotations

import threading

from engine.queue import DurableQueue
from engine.validation.review import IndependentReviewer


def run_one(queue: DurableQueue, reviewer: IndependentReviewer, campaign: str,
            worker_id: str, *, lease_seconds: int = 60,
            model: str | None = None, model_role: str = "legal_verification") -> dict:
    lease = queue.lease_review(worker_id, campaign=campaign,
                               lease_seconds=lease_seconds)
    if lease is None:
        return {"state": "idle"}
    stop = threading.Event()
    lost = threading.Event()

    def renew() -> None:
        while not stop.wait(max(1, lease_seconds / 3)):
            try:
                if not queue.heartbeat_review(lease["task_id"], worker_id,
                                              lease["epoch"],
                                              lease_seconds=lease_seconds):
                    lost.set()
                    return
            except Exception:
                lost.set()
                return

    heartbeat = threading.Thread(target=renew, daemon=True)
    heartbeat.start()
    try:
        result = reviewer.run(lease["draft_artifact"],
                              model=model, model_role=model_role)
    except Exception as error:
        stop.set()
        heartbeat.join()
        state = queue.fail_review(lease["task_id"], worker_id, lease["epoch"],
                                  f"review exception: {type(error).__name__}: {error}")
        return {"state": state, "task_id": lease["task_id"], "error": str(error)}
    finally:
        stop.set()
        heartbeat.join()
    if lost.is_set():
        return {"state": "lease_lost", "task_id": lease["task_id"],
                "review_artifact": result.get("artifact")}
    if not queue.heartbeat_review(lease["task_id"], worker_id, lease["epoch"],
                                  lease_seconds=lease_seconds):
        return {"state": "lease_lost", "task_id": lease["task_id"],
                "review_artifact": result.get("artifact")}
    if result["state"] != "reviewed":
        state = queue.fail_review(lease["task_id"], worker_id, lease["epoch"],
                                  f"review ended {result['state']}",
                                  result["artifact"])
        return {"state": state, "task_id": lease["task_id"],
                "review_artifact": result["artifact"]}
    task_state = queue.publish_review(lease["task_id"], result["artifact"])
    if task_state not in {"accepted", "needs_reconciliation"}:
        state = queue.fail_review(lease["task_id"], worker_id, lease["epoch"],
                                  "review publication rejected", result["artifact"])
        return {"state": state, "task_id": lease["task_id"],
                "review_artifact": result["artifact"]}
    completed = queue.finish_review(lease["task_id"], worker_id,
                                    lease["epoch"], result["artifact"])
    return {"state": task_state if completed else "completion_pending",
            "task_id": lease["task_id"], "review_artifact": result["artifact"],
            "outcomes": result.get("outcomes", {})}
