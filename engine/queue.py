"""PostgreSQL task leases, fencing, retries, and transactional progress events."""

from __future__ import annotations

import json
from pathlib import Path
import uuid

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from engine.artifacts import LocalArtifactStore
from engine.worker import validate_answer
from engine.validation.review import validate_review

MIGRATIONS = tuple(sorted((Path(__file__).resolve().parents[1] / "migrations").glob(
    "[0-9][0-9][0-9]_decomp_*.sql")))


class DurableQueue:
    def __init__(self, dsn: str, store: LocalArtifactStore):
        self.dsn = dsn
        self.store = store

    def _connect(self):
        return psycopg.connect(self.dsn, row_factory=dict_row)

    def migrate(self) -> None:
        with self._connect() as conn:
            for migration in MIGRATIONS:
                conn.execute(migration.read_text())

    @staticmethod
    def _event(conn, campaign: str, event_type: str, payload: dict) -> None:
        conn.execute("INSERT INTO decomp_outbox (campaign_id, event_type, payload) "
                     "VALUES (%s, %s, %s)", (campaign, event_type, Jsonb(payload)))

    def create_campaign(self, campaign: str, binary_sha256: str) -> None:
        with self._connect() as conn:
            conn.execute("INSERT INTO decomp_campaigns (id, binary_sha256) "
                         "VALUES (%s, %s) ON CONFLICT (id) DO NOTHING",
                         (campaign, binary_sha256))
            row = conn.execute("SELECT binary_sha256 FROM decomp_campaigns WHERE id = %s",
                               (campaign,)).fetchone()
            if row["binary_sha256"] != binary_sha256:
                raise ValueError("campaign identity has a different binary hash")

    def set_pool_capacity(self, pool: str, capacity: int) -> None:
        if capacity < 1:
            raise ValueError("capacity must be positive")
        with self._connect() as conn:
            changed = conn.execute("UPDATE decomp_pools SET capacity = %s "
                                   "WHERE name = %s AND active <= %s RETURNING name",
                                   (capacity, pool, capacity)).fetchone()
            if not changed:
                raise ValueError("unknown pool or capacity below active leases")

    def enqueue_scope(self, scope_artifact: str) -> list[str]:
        scope = json.loads(self.store.get(scope_artifact))
        campaign = scope["campaign"]
        inserted = []
        with self._connect() as conn:
            if not conn.execute("SELECT 1 FROM decomp_campaigns WHERE id = %s",
                                (campaign,)).fetchone():
                raise ValueError("campaign is not registered")
            for task in scope["tasks"]:
                self.store.get(task["index_artifact"])
                task_id = uuid.uuid4()
                row = conn.execute(
                    "INSERT INTO decomp_tasks "
                    "(id, campaign_id, pool, scope_id, scope_artifact, kind, subject, question, "
                    "deduplication_key, priority_class, priority, evidence_artifact) "
                    "VALUES (%s,%s,'reasoning',%s,%s,%s,%s,%s,%s,2,%s,%s) "
                    "ON CONFLICT (campaign_id, deduplication_key) DO NOTHING "
                    "RETURNING id",
                    (task_id, campaign, scope["scope_id"], scope_artifact,
                     task["kind"], task["subject"],
                     task["question"], task["deduplication_key"], task["priority"],
                     task["index_artifact"])).fetchone()
                if row:
                    inserted.append(str(row["id"]))
                    self._event(conn, campaign, "task_queued",
                                {"task_id": str(row["id"]), "subject": task["subject"],
                                 "scope_id": scope["scope_id"]})
        return inserted

    def lease(self, worker_id: str, *, pool: str = "reasoning",
              campaign: str | None = None, lease_seconds: int = 60) -> dict | None:
        if not worker_id or lease_seconds < 1:
            raise ValueError("worker_id and positive lease_seconds required")
        with self._connect() as conn:
            capacity = conn.execute("SELECT capacity, active FROM decomp_pools "
                                    "WHERE name = %s FOR UPDATE", (pool,)).fetchone()
            if capacity is None:
                raise ValueError(f"unknown pool {pool}")
            if capacity["active"] >= capacity["capacity"]:
                return None
            task = conn.execute(
                "SELECT t.* FROM decomp_tasks t JOIN decomp_campaigns c "
                "ON c.id = t.campaign_id WHERE t.pool = %s AND t.state = 'queued' "
                "AND (%s::text IS NULL OR t.campaign_id = %s) "
                "AND t.available_at <= now() AND t.attempts_count < t.max_attempts "
                "AND c.state = 'active' "
                "ORDER BY (t.priority_class - LEAST(3, FLOOR(EXTRACT(EPOCH FROM "
                "(now() - t.created_at)) / 900))) ASC, t.priority DESC, "
                "t.created_at ASC FOR UPDATE OF t SKIP LOCKED LIMIT 1",
                (pool, campaign, campaign)).fetchone()
            if task is None:
                return None
            attempt_id = uuid.uuid4()
            leased = conn.execute(
                "UPDATE decomp_tasks SET state = 'leased', lease_epoch = lease_epoch + 1, "
                "attempts_count = attempts_count + 1, leased_by = %s, "
                "lease_until = now() + (%s * interval '1 second'), updated_at = now() "
                "WHERE id = %s RETURNING lease_epoch, lease_until, checkpoint_artifact",
                (worker_id, lease_seconds, task["id"])).fetchone()
            conn.execute("INSERT INTO decomp_attempts "
                         "(id, task_id, epoch, worker_id, state, lease_until, checkpoint_artifact) "
                         "VALUES (%s,%s,%s,%s,'leased',%s,%s)",
                         (attempt_id, task["id"], leased["lease_epoch"], worker_id,
                          leased["lease_until"], leased["checkpoint_artifact"]))
            conn.execute("UPDATE decomp_pools SET active = active + 1 WHERE name = %s", (pool,))
            self._event(conn, task["campaign_id"], "task_leased",
                        {"task_id": str(task["id"]), "attempt_id": str(attempt_id),
                         "worker_id": worker_id, "epoch": leased["lease_epoch"]})
            return {"task_id": str(task["id"]), "attempt_id": str(attempt_id),
                    "campaign": task["campaign_id"], "scope_id": task["scope_id"],
                    "scope_artifact": task["scope_artifact"],
                    "subject": task["subject"], "question": task["question"],
                    "evidence_artifact": task["evidence_artifact"],
                    "checkpoint_artifact": leased["checkpoint_artifact"],
                    "epoch": leased["lease_epoch"], "worker_id": worker_id,
                    "lease_until": leased["lease_until"].isoformat()}

    @staticmethod
    def _current(task: dict | None, worker_id: str, epoch: int) -> bool:
        if task is None:
            return False
        return (task["state"] == "leased" and task["leased_by"] == worker_id and
                task["lease_epoch"] == epoch and task["lease_until"] is not None and
                task["lease_until"] > task["db_now"])

    def heartbeat(self, task_id: str, worker_id: str, epoch: int,
                  *, lease_seconds: int = 60) -> bool:
        if lease_seconds < 1:
            raise ValueError("lease_seconds must be positive")
        with self._connect() as conn:
            task = conn.execute("SELECT t.*, now() AS db_now FROM decomp_tasks t "
                                "WHERE id = %s FOR UPDATE", (task_id,)).fetchone()
            if not self._current(task, worker_id, epoch):
                return False
            row = conn.execute("UPDATE decomp_tasks SET lease_until = now() + "
                               "(%s * interval '1 second'), updated_at = now() "
                               "WHERE id = %s RETURNING lease_until",
                               (lease_seconds, task_id)).fetchone()
            conn.execute("UPDATE decomp_attempts SET heartbeat_at = now(), "
                         "lease_until = %s WHERE task_id = %s AND epoch = %s",
                         (row["lease_until"], task_id, epoch))
            return True

    def checkpoint(self, task_id: str, worker_id: str, epoch: int,
                   artifact: str) -> bool:
        self.store.get(artifact)
        with self._connect() as conn:
            task = conn.execute("SELECT t.*, now() AS db_now FROM decomp_tasks t "
                                "WHERE id = %s FOR UPDATE", (task_id,)).fetchone()
            if not self._current(task, worker_id, epoch):
                return False
            conn.execute("UPDATE decomp_tasks SET checkpoint_artifact = %s, "
                         "updated_at = now() WHERE id = %s", (artifact, task_id))
            conn.execute("UPDATE decomp_attempts SET checkpoint_artifact = %s "
                         "WHERE task_id = %s AND epoch = %s",
                         (artifact, task_id, epoch))
            self._event(conn, task["campaign_id"], "checkpoint_saved",
                        {"task_id": task_id, "epoch": epoch, "artifact": artifact})
            return True

    def submit(self, task_id: str, worker_id: str, epoch: int, artifact: str,
               submission_key: str, *, model: str | None = None,
               runtime_version: str | None = None, usage: dict | None = None) -> str:
        if not submission_key:
            raise ValueError("submission_key is required")
        self.store.get(artifact)
        with self._connect() as conn:
            pool = conn.execute("SELECT pool FROM decomp_tasks WHERE id = %s",
                                (task_id,)).fetchone()
            if pool is None:
                raise ValueError("unknown task")
            conn.execute("SELECT 1 FROM decomp_pools WHERE name = %s FOR UPDATE",
                         (pool["pool"],))
            task = conn.execute("SELECT t.*, now() AS db_now FROM decomp_tasks t "
                                "WHERE id = %s FOR UPDATE", (task_id,)).fetchone()
            if (task["state"] in {"result_pending", "validated", "accepted"} and
                    task["result_submission_key"] == submission_key and
                    task["result_artifact"] == artifact):
                return "duplicate"
            if not self._current(task, worker_id, epoch):
                conn.execute("UPDATE decomp_attempts SET stale_result_artifact = %s "
                             "WHERE task_id = %s AND epoch = %s AND worker_id = %s "
                             "AND stale_result_artifact IS NULL",
                             (artifact, task_id, epoch, worker_id))
                return "stale"
            conn.execute("UPDATE decomp_tasks SET state = 'result_pending', "
                         "result_artifact = %s, result_submission_key = %s, "
                         "leased_by = NULL, lease_until = NULL, updated_at = now() "
                         "WHERE id = %s", (artifact, submission_key, task_id))
            conn.execute("UPDATE decomp_attempts SET state = 'submitted', "
                         "result_artifact = %s, model = %s, runtime_version = %s, "
                         "usage = %s WHERE task_id = %s AND epoch = %s",
                         (artifact, model, runtime_version, Jsonb(usage or {}), task_id, epoch))
            conn.execute("UPDATE decomp_pools SET active = active - 1 WHERE name = %s",
                         (task["pool"],))
            self._event(conn, task["campaign_id"], "result_submitted",
                        {"task_id": task_id, "epoch": epoch, "artifact": artifact})
            return "accepted_for_validation"

    def fail(self, task_id: str, worker_id: str, epoch: int, reason: str,
             *, failure_type: str = "infrastructure",
             artifact: str | None = None) -> str:
        if failure_type not in {"infrastructure", "rate_limited", "semantic", "budget"}:
            raise ValueError("invalid failure type")
        if artifact is not None:
            self.store.get(artifact)
        with self._connect() as conn:
            pool = conn.execute("SELECT pool FROM decomp_tasks WHERE id = %s",
                                (task_id,)).fetchone()
            if pool is None:
                return "stale"
            conn.execute("SELECT 1 FROM decomp_pools WHERE name = %s FOR UPDATE",
                         (pool["pool"],))
            task = conn.execute("SELECT t.*, now() AS db_now FROM decomp_tasks t "
                                "WHERE id = %s FOR UPDATE", (task_id,)).fetchone()
            if not self._current(task, worker_id, epoch):
                return "stale"
            retry = (failure_type in {"infrastructure", "rate_limited"} and
                     task["attempts_count"] < task["max_attempts"])
            state = "queued" if retry else "partial"
            backoff = min(60, 2 ** task["attempts_count"]) if retry else 0
            conn.execute("UPDATE decomp_tasks SET state = %s, leased_by = NULL, "
                         "lease_until = NULL, available_at = now() + "
                         "(%s * interval '1 second'), terminal_reason = %s, "
                         "result_artifact = CASE WHEN %s::text = 'partial' THEN %s "
                         "ELSE result_artifact END, "
                         "updated_at = now() WHERE id = %s",
                         (state, backoff, reason, state, artifact, task_id))
            conn.execute("UPDATE decomp_attempts SET state = %s, terminal_reason = %s, "
                         "result_artifact = %s "
                         "WHERE task_id = %s AND epoch = %s",
                         ("retryable_failed" if retry else "terminal_failed", reason, artifact,
                          task_id, epoch))
            conn.execute("UPDATE decomp_pools SET active = active - 1 WHERE name = %s",
                         (task["pool"],))
            self._event(conn, task["campaign_id"], "task_failed",
                        {"task_id": task_id, "epoch": epoch, "failure_type": failure_type,
                         "retry": retry, "reason": reason, "artifact": artifact})
            return state

    def reclaim_expired(self, *, pool: str = "reasoning", limit: int = 100) -> int:
        reclaimed = 0
        with self._connect() as conn:
            conn.execute("SELECT 1 FROM decomp_pools WHERE name = %s FOR UPDATE", (pool,))
            tasks = conn.execute("SELECT * FROM decomp_tasks WHERE pool = %s "
                                 "AND state = 'leased' AND lease_until <= now() "
                                 "ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT %s",
                                 (pool, limit)).fetchall()
            for task in tasks:
                retry = task["attempts_count"] < task["max_attempts"]
                state = "queued" if retry else "partial"
                conn.execute("UPDATE decomp_attempts SET state = 'expired', "
                             "terminal_reason = 'lease_expired' "
                             "WHERE task_id = %s AND epoch = %s",
                             (task["id"], task["lease_epoch"]))
                conn.execute("UPDATE decomp_tasks SET state = %s, leased_by = NULL, "
                             "lease_until = NULL, available_at = now(), "
                             "terminal_reason = 'lease_expired', updated_at = now() "
                             "WHERE id = %s", (state, task["id"]))
                conn.execute("UPDATE decomp_pools SET active = active - 1 WHERE name = %s",
                             (pool,))
                self._event(conn, task["campaign_id"], "lease_expired",
                            {"task_id": str(task["id"]), "epoch": task["lease_epoch"],
                             "retry": retry})
                reclaimed += 1
        return reclaimed

    def validate_result(self, task_id: str, artifact: str, verdict: str) -> bool:
        if verdict not in {"validated", "rejected", "needs_reconciliation"}:
            raise ValueError("invalid verdict")
        data = self.store.get(artifact)
        with self._connect() as conn:
            task = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                (task_id,)).fetchone()
            if task is None or task["state"] != "result_pending" or task["result_artifact"] != artifact:
                return False
            if verdict == "validated":
                try:
                    draft = json.loads(data)
                    if not isinstance(draft, dict):
                        return False
                    evidence = json.loads(self.store.get(draft["evidence_artifact"]))
                    scope = json.loads(self.store.get(task["scope_artifact"]))
                    answer = draft["answer"]
                    if not all(isinstance(value, dict) for value in
                               (evidence, scope, answer)):
                        return False
                except (ValueError, KeyError, TypeError, AttributeError):
                    return False
                matching = [item for item in scope.get("tasks", [])
                            if isinstance(item, dict) and
                            item.get("deduplication_key") == draft.get("task_key")]
                if (draft.get("state") != "unreviewed" or
                        draft.get("structural_errors") != [] or
                        draft.get("evidence_truncated") or
                        draft.get("campaign") != task["campaign_id"] or
                        draft.get("subject") != task["subject"] or
                        draft.get("scope_artifact") != task["scope_artifact"] or
                        scope.get("scope_id") != task["scope_id"] or
                        scope.get("campaign") != task["campaign_id"] or
                        len(matching) != 1 or
                        matching[0].get("subject") != task["subject"] or
                        matching[0].get("kind") != task["kind"] or
                        matching[0].get("question") != task["question"] or
                        evidence.get("entry") != task["subject"] or
                        validate_answer(answer, evidence)):
                    return False
            conn.execute("UPDATE decomp_tasks SET state = %s, updated_at = now() "
                         "WHERE id = %s", (verdict, task_id))
            self._event(conn, task["campaign_id"], "result_validated",
                        {"task_id": task_id, "verdict": verdict})
            return True

    def publish_review(self, task_id: str, review_artifact: str) -> str:
        try:
            review = json.loads(self.store.get(review_artifact))
        except (ValueError, TypeError):
            return "invalid"
        with self._connect() as conn:
            task = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                (task_id,)).fetchone()
            if task is None or task["state"] != "validated":
                return "invalid"
            try:
                draft = json.loads(self.store.get(task["result_artifact"]))
                evidence = json.loads(self.store.get(draft["evidence_artifact"]))
                answer = review["answer"]
                claim_count = len(draft["answer"]["claims"])
                outcomes = {kind: sum(item["outcome"] == kind for item in answer["reviews"])
                            for kind in ("supported_static", "contradicted", "uncertain")}
            except (ValueError, KeyError, TypeError):
                return "invalid"
            if (review.get("state") != "reviewed" or
                    review.get("structural_errors") != [] or
                    review.get("draft_artifact") != task["result_artifact"] or
                    review.get("evidence_artifact") != draft["evidence_artifact"] or
                    review.get("campaign") != task["campaign_id"] or
                    review.get("subject") != task["subject"] or
                    validate_review(answer, evidence, claim_count) or
                    review.get("outcomes") != {kind: count for kind, count in
                                                outcomes.items() if count}):
                return "invalid"
            reasons = []
            if claim_count < 1 or outcomes["supported_static"] != claim_count:
                reasons.append("claims_not_all_supported")
            if answer["missing_behavior"]:
                reasons.append("missing_behavior")
            if answer["unresolved"]:
                reasons.append("review_unresolved")
            if draft["answer"]["dependencies"]:
                reasons.append("dependency_contracts_unreviewed")
            state = "accepted" if not reasons else "needs_reconciliation"
            support = "static_only" if outcomes["supported_static"] == claim_count and claim_count else "none"
            conn.execute("UPDATE decomp_tasks SET state = %s, review_artifact = %s, "
                         "support_level = %s, terminal_reason = %s, updated_at = now() "
                         "WHERE id = %s", (state, review_artifact, support,
                                           ",".join(reasons) if reasons else None, task_id))
            self._event(conn, task["campaign_id"], "review_recorded",
                        {"task_id": task_id, "state": state, "support_level": support,
                         "review_artifact": review_artifact, "reasons": reasons})
            return state

    def accept(self, task_id: str, review_artifact: str) -> bool:
        return self.publish_review(task_id, review_artifact) == "accepted"

    def record_dependency_review(self, task_id: str, review_artifact: str) -> bool:
        try:
            review = json.loads(self.store.get(review_artifact))
        except (ValueError, TypeError):
            return False
        with self._connect() as conn:
            task = conn.execute("SELECT campaign_id, state, result_artifact FROM decomp_tasks "
                                "WHERE id = %s FOR UPDATE", (task_id,)).fetchone()
            if (task is None or task["state"] != "needs_reconciliation" or
                    review.get("campaign") != task["campaign_id"] or
                    review.get("task_id") != task_id or
                    review.get("draft_artifact") != task["result_artifact"]):
                return False
            self._event(conn, task["campaign_id"], "dependency_review_recorded",
                        {"task_id": task_id, "dependency_index": review.get("dependency_index"),
                         "target": review.get("target"), "state": review.get("state"),
                         "outcome": review.get("answer", {}).get("outcome"),
                         "artifact": review_artifact})
            return True

    def resolve_dependencies(self, task_id: str, review_artifacts: list[str]) -> str:
        from engine.validation.dependencies import validate_dependency_review

        with self._connect() as conn:
            task = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s",
                                (task_id,)).fetchone()
        if task is None or task["state"] != "needs_reconciliation":
            return "invalid"
        if task["terminal_reason"] != "dependency_contracts_unreviewed":
            return "blocked"
        draft = json.loads(self.store.get(task["result_artifact"]))
        dependencies = draft["answer"]["dependencies"]
        if not dependencies or len(review_artifacts) != len(dependencies):
            return "invalid"
        caller = json.loads(self.store.get(draft["evidence_artifact"]))
        reviews = []
        pins = {}
        for artifact in review_artifacts:
            review = json.loads(self.store.get(artifact))
            index = review.get("dependency_index")
            if not isinstance(index, int) or index < 0 or index >= len(dependencies):
                return "invalid"
            dependency = dependencies[index]
            key = dependency["target"]
            contract = json.loads(self.store.get(review["contract_artifact"]))
            callee = json.loads(self.store.get(contract["evidence_artifact"]))
            if (review.get("state") != "reviewed" or
                    review.get("structural_errors") != [] or
                    review.get("campaign") != task["campaign_id"] or
                    review.get("task_id") != task_id or
                    review.get("draft_artifact") != task["result_artifact"] or
                    review.get("target") != key or review.get("contract_key") != key or
                    review.get("caller_evidence_artifact") != draft["evidence_artifact"] or
                    review.get("callee_evidence_artifact") != contract["evidence_artifact"] or
                    contract.get("campaign") != task["campaign_id"] or
                    contract.get("contract_key") != key or
                    validate_dependency_review(review["answer"], caller, callee)):
                return "invalid"
            if review["answer"]["outcome"] != "supported_static":
                return "blocked"
            version = review.get("contract_version")
            if not isinstance(version, int) or version < 1 or (
                    key in pins and pins[key] != version):
                return "invalid"
            pins[key] = version
            reviews.append((index, artifact, key, version, review["contract_artifact"]))
        if {item[0] for item in reviews} != set(range(len(dependencies))):
            return "invalid"
        resolution = {"schema": 1, "campaign": task["campaign_id"],
                      "task_id": task_id, "draft_artifact": task["result_artifact"],
                      "claim_review_artifact": task["review_artifact"],
                      "dependency_reviews": [artifact for _, artifact, _, _, _ in
                                             sorted(reviews)],
                      "dependency_versions": pins}
        resolution_artifact = self.store.put(json.dumps(resolution, sort_keys=True).encode())
        with self._connect() as conn:
            current = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                   (task_id,)).fetchone()
            if (current["state"] != "needs_reconciliation" or
                    current["result_artifact"] != task["result_artifact"] or
                    current["review_artifact"] != task["review_artifact"] or
                    current["terminal_reason"] != "dependency_contracts_unreviewed"):
                return "stale"
            for key, version in sorted(pins.items()):
                head = conn.execute("SELECT version, artifact, state "
                                    "FROM decomp_contract_heads WHERE campaign_id = %s "
                                    "AND contract_key = %s FOR UPDATE",
                                    (task["campaign_id"], key)).fetchone()
                matching = [item for item in reviews if item[2] == key]
                if (head is None or head["state"] != "active" or
                        head["version"] != version or any(
                            item[4] != head["artifact"] for item in matching)):
                    return "stale"
            conn.execute("UPDATE decomp_tasks SET state = 'accepted', "
                         "dependency_versions = %s, dependency_resolution_artifact = %s, "
                         "terminal_reason = NULL, updated_at = now() WHERE id = %s",
                         (Jsonb(pins), resolution_artifact, task_id))
            self._event(conn, task["campaign_id"], "dependencies_resolved",
                        {"task_id": task_id, "resolution_artifact": resolution_artifact,
                         "dependency_versions": pins})
            return "accepted"

    def audit_accepted_dependencies(self, campaign: str) -> int:
        revised = 0
        with self._connect() as conn:
            tasks = conn.execute("SELECT id, result_artifact, dependency_resolution_artifact "
                                 "FROM decomp_tasks "
                                 "WHERE campaign_id = %s AND state = 'accepted' "
                                 "FOR UPDATE", (campaign,)).fetchall()
            for task in tasks:
                draft = json.loads(self.store.get(task["result_artifact"]))
                if not draft["answer"].get("dependencies") or task["dependency_resolution_artifact"]:
                    continue
                conn.execute("UPDATE decomp_tasks SET state = 'needs_reconciliation', "
                             "terminal_reason = 'dependency_contracts_unreviewed', "
                             "updated_at = now() WHERE id = %s", (task["id"],))
                self._event(conn, campaign, "acceptance_revised",
                            {"task_id": str(task["id"]),
                             "reason": "dependency_contracts_unreviewed"})
                revised += 1
        return revised

    def status(self, campaign: str) -> dict:
        with self._connect() as conn:
            states = conn.execute("SELECT state, count(*) AS total FROM decomp_tasks "
                                  "WHERE campaign_id = %s GROUP BY state", (campaign,)).fetchall()
            attempts = conn.execute("SELECT count(*) AS total FROM decomp_attempts a "
                                    "JOIN decomp_tasks t ON t.id = a.task_id "
                                    "WHERE t.campaign_id = %s", (campaign,)).fetchone()["total"]
            pools = conn.execute("SELECT name, capacity, active FROM decomp_pools "
                                 "ORDER BY name").fetchall()
            support = conn.execute("SELECT support_level, count(*) AS total "
                                   "FROM decomp_tasks WHERE campaign_id = %s "
                                   "GROUP BY support_level", (campaign,)).fetchall()
            cursor = conn.execute("SELECT coalesce(max(id), 0) AS id FROM decomp_outbox "
                                  "WHERE campaign_id = %s", (campaign,)).fetchone()["id"]
            return {"campaign": campaign, "tasks": {r["state"]: r["total"] for r in states},
                    "support_levels": {r["support_level"]: r["total"] for r in support},
                    "attempts": attempts, "pools": pools, "event_cursor": cursor}

    def task(self, task_id: str) -> dict | None:
        with self._connect() as conn:
            row = conn.execute("SELECT id, campaign_id, subject, state, result_artifact, "
                               "review_artifact, support_level, terminal_reason, "
                               "dependency_versions, dependency_resolution_artifact "
                               "FROM decomp_tasks "
                               "WHERE id = %s", (task_id,)).fetchone()
            if row is None:
                return None
            return {**row, "id": str(row["id"])}

    def reassess(self, task_id: str, reason: str) -> bool:
        if not reason.strip():
            raise ValueError("reassessment reason is required")
        with self._connect() as conn:
            task = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                (task_id,)).fetchone()
            if (task is None or task["state"] != "partial" or
                    task["result_artifact"] is None or
                    task["attempts_count"] >= task["max_attempts"]):
                return False
            self.store.get(task["result_artifact"])
            conn.execute("UPDATE decomp_tasks SET state = 'queued', "
                         "checkpoint_artifact = result_artifact, "
                         "available_at = now(), terminal_reason = %s, "
                         "updated_at = now() WHERE id = %s", (reason, task_id))
            self._event(conn, task["campaign_id"], "task_reassessment_queued",
                        {"task_id": task_id, "reason": reason,
                         "prior_artifact": task["result_artifact"]})
            return True

    def events(self, campaign: str, after_id: int = 0, limit: int = 100) -> list[dict]:
        with self._connect() as conn:
            rows = conn.execute("SELECT id, event_type, payload, created_at FROM decomp_outbox "
                                "WHERE campaign_id = %s AND id > %s ORDER BY id LIMIT %s",
                                (campaign, after_id, limit)).fetchall()
            return [{**row, "created_at": row["created_at"].isoformat()} for row in rows]
