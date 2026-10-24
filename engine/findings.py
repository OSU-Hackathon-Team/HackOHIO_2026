"""Conditionally publish reviewed claims and versioned helper contracts."""

from __future__ import annotations

import json
import uuid

from engine.queue import DurableQueue


class FindingsStore:
    def __init__(self, queue: DurableQueue):
        self.queue = queue
        self.store = queue.store

    def _invalidate_consumers(self, conn, campaign: str, contract_key: str,
                              version: int, reason: str) -> int:
        stale = conn.execute(
            "SELECT f.id, f.task_id FROM decomp_findings f "
            "JOIN decomp_finding_dependencies d ON d.finding_id = f.id "
            "WHERE d.campaign_id = %s AND d.contract_key = %s "
            "AND d.contract_version <= %s AND f.state IN ('active', 'conflicted') "
            "FOR UPDATE OF f", (campaign, contract_key, version)).fetchall()
        for finding in stale:
            conn.execute("UPDATE decomp_findings SET state = 'stale', updated_at = now() "
                         "WHERE id = %s", (finding["id"],))
            self.queue._event(conn, campaign, "finding_invalidated",
                              {"finding_id": str(finding["id"]),
                               "task_id": str(finding["task_id"]),
                               "contract_key": contract_key, "new_version": version,
                               "reason": reason})
        return len(stale)

    def _accepted_source(self, task_id: str) -> tuple[dict, dict, dict]:
        with self.queue._connect() as conn:
            task = conn.execute("SELECT * FROM decomp_tasks WHERE id = %s",
                                (task_id,)).fetchone()
        if task is None or task["state"] != "accepted" or task["support_level"] != "static_only":
            raise ValueError("source task is not accepted with static support")
        draft = json.loads(self.store.get(task["result_artifact"]))
        review = json.loads(self.store.get(task["review_artifact"]))
        if (draft["campaign"] != task["campaign_id"] or
                draft["subject"] != task["subject"] or
                review["draft_artifact"] != task["result_artifact"]):
            raise ValueError("source task identity or dependency gate failed")
        if draft["answer"]["dependencies"]:
            if not task["dependency_resolution_artifact"]:
                raise ValueError("source task has no dependency resolution")
            resolution = json.loads(self.store.get(task["dependency_resolution_artifact"]))
            if (resolution.get("campaign") != task["campaign_id"] or
                    resolution.get("task_id") != str(task["id"]) or
                    resolution.get("draft_artifact") != task["result_artifact"] or
                    resolution.get("claim_review_artifact") != task["review_artifact"] or
                    resolution.get("dependency_versions") != task["dependency_versions"] or
                    len(resolution.get("dependency_reviews", [])) !=
                    len(draft["answer"]["dependencies"])):
                raise ValueError("source dependency resolution does not match task")
        return task, draft, review

    def publish_contract(self, task_id: str, claim_index: int, contract_key: str,
                         *, expected_version: int) -> dict:
        if not contract_key.strip() or expected_version < 0:
            raise ValueError("contract key and expected version required")
        task, draft, review = self._accepted_source(task_id)
        claims = draft["answer"]["claims"]
        if claim_index < 0 or claim_index >= len(claims):
            raise ValueError("claim index outside reviewed draft")
        if not any(item["claim_index"] == claim_index and
                   item["outcome"] == "supported_static"
                   for item in review["answer"]["reviews"]):
            raise ValueError("contract source claim lacks static support")
        claim = claims[claim_index]
        content = {"schema": 1, "campaign": task["campaign_id"],
                   "contract_key": contract_key, "source_task_id": str(task["id"]),
                   "subject": task["subject"], "claim_index": claim_index,
                   "statement": claim["statement"],
                   "evidence_artifact": draft["evidence_artifact"],
                   "evidence_addresses": claim["evidence_addresses"],
                   "draft_artifact": task["result_artifact"],
                   "review_artifact": task["review_artifact"],
                   "dependency_resolution_artifact": task["dependency_resolution_artifact"],
                   "dependency_versions": task["dependency_versions"]}
        artifact = self.store.put(json.dumps(content, sort_keys=True).encode())
        campaign = task["campaign_id"]
        with self.queue._connect() as conn:
            current = conn.execute("SELECT state, result_artifact, review_artifact "
                                   "FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                   (task_id,)).fetchone()
            if (current["state"] != "accepted" or
                    current["result_artifact"] != task["result_artifact"] or
                    current["review_artifact"] != task["review_artifact"]):
                raise ValueError("source task changed before contract publication")
            source = conn.execute("SELECT id, semantic_slot, state "
                                  "FROM decomp_findings WHERE task_id = %s AND claim_index = %s",
                                  (task_id, claim_index)).fetchone()
            if source is None:
                raise ValueError("publish the source finding before its contract")
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                         (f"{campaign}:{task['subject']}:{source['semantic_slot']}",))
            source = conn.execute("SELECT state FROM decomp_findings WHERE id = %s FOR UPDATE",
                                  (source["id"],)).fetchone()
            if source["state"] != "active":
                raise ValueError("contract source finding is disputed or stale")
            conn.execute("INSERT INTO decomp_contract_heads (campaign_id, contract_key) "
                         "VALUES (%s, %s) ON CONFLICT DO NOTHING", (campaign, contract_key))
            head = conn.execute("SELECT * FROM decomp_contract_heads "
                                "WHERE campaign_id = %s AND contract_key = %s FOR UPDATE",
                                (campaign, contract_key)).fetchone()
            if head["artifact"] == artifact and head["version"] > 0 and head["state"] == "active":
                return {"artifact": artifact, "version": head["version"],
                        "invalidated": 0, "duplicate": True}
            if head["state"] == "disputed":
                raise ValueError("contract head has an unresolved claim conflict")
            if head["version"] != expected_version:
                raise ValueError("contract version changed before publication")
            version = head["version"] + 1
            conn.execute("INSERT INTO decomp_contract_versions "
                         "(campaign_id, contract_key, version, artifact, source_task_id, claim_index) "
                         "VALUES (%s,%s,%s,%s,%s,%s)",
                         (campaign, contract_key, version, artifact, task_id, claim_index))
            conn.execute("UPDATE decomp_contract_heads SET version = %s, artifact = %s, "
                         "state = 'active', "
                         "updated_at = now() WHERE campaign_id = %s AND contract_key = %s",
                         (version, artifact, campaign, contract_key))
            invalidated = self._invalidate_consumers(
                conn, campaign, contract_key, version - 1, "contract_revised")
            self.queue._event(conn, campaign, "contract_published",
                              {"contract_key": contract_key, "version": version,
                               "artifact": artifact, "invalidated": invalidated})
            return {"artifact": artifact, "version": version,
                    "invalidated": invalidated, "duplicate": False}

    def publish_claims(self, task_id: str, slots: dict[int, str],
                       *, dependency_versions: dict[str, int] | None = None) -> list[dict]:
        task, draft, review = self._accepted_source(task_id)
        claims = draft["answer"]["claims"]
        if set(slots) != set(range(len(claims))) or not all(
            isinstance(value, str) and value.strip() for value in slots.values()
        ) or len(set(slots.values())) != len(slots):
            raise ValueError("one distinct semantic slot is required for each claim")
        if not all(any(item["claim_index"] == index and
                       item["outcome"] == "supported_static"
                       for item in review["answer"]["reviews"])
                   for index in range(len(claims))):
            raise ValueError("all published claims need static support")
        pins = dependency_versions if dependency_versions is not None else task["dependency_versions"]
        if draft["answer"]["dependencies"] and pins != task["dependency_versions"]:
            raise ValueError("dependency versions must match accepted resolution")
        if not all(isinstance(key, str) and key and isinstance(version, int) and
                   version > 0 for key, version in pins.items()):
            raise ValueError("dependency versions must be positive integers")
        prepared = []
        for index, claim in enumerate(claims):
            content = {"schema": 1, "campaign": task["campaign_id"],
                       "task_id": str(task["id"]), "subject": task["subject"],
                       "semantic_slot": slots[index], "claim_index": index,
                       "statement": claim["statement"],
                       "evidence_artifact": draft["evidence_artifact"],
                       "evidence_addresses": claim["evidence_addresses"],
                       "assumptions": claim["assumptions"],
                       "alternatives": claim["alternatives"],
                       "dependency_versions": pins,
                       "dependency_resolution_artifact": task["dependency_resolution_artifact"],
                       "draft_artifact": task["result_artifact"],
                       "review_artifact": task["review_artifact"]}
            artifact = self.store.put(json.dumps(content, sort_keys=True).encode())
            prepared.append((index, claim, artifact))
        campaign = task["campaign_id"]
        published = []
        with self.queue._connect() as conn:
            current = conn.execute("SELECT state, result_artifact, review_artifact "
                                   "FROM decomp_tasks WHERE id = %s FOR UPDATE",
                                   (task_id,)).fetchone()
            if (current["state"] != "accepted" or
                    current["result_artifact"] != task["result_artifact"] or
                    current["review_artifact"] != task["review_artifact"]):
                raise ValueError("source task changed before claim publication")
            for slot in sorted(slots.values()):
                conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                             (f"{campaign}:{task['subject']}:{slot}",))
            for key, version in sorted(pins.items()):
                head = conn.execute("SELECT version, state FROM decomp_contract_heads "
                                    "WHERE campaign_id = %s AND contract_key = %s FOR UPDATE",
                                    (campaign, key)).fetchone()
                if head is None or head["version"] != version or head["state"] != "active":
                    raise ValueError(f"dependency contract {key} changed before publication")
            for index, claim, artifact in sorted(prepared, key=lambda item: slots[item[0]]):
                slot = slots[index]
                existing = conn.execute("SELECT id, claim_artifact, semantic_slot, state "
                                        "FROM decomp_findings WHERE task_id = %s "
                                        "AND claim_index = %s", (task_id, index)).fetchone()
                if existing:
                    if existing["claim_artifact"] != artifact or existing["semantic_slot"] != slot:
                        raise ValueError("claim was already published with different content")
                    published.append({"finding_id": str(existing["id"]),
                                      "artifact": artifact, "state": existing["state"],
                                      "duplicate": True})
                    continue
                rivals = conn.execute("SELECT id, task_id, claim_index, statement "
                                      "FROM decomp_findings "
                                      "WHERE campaign_id = %s AND subject = %s "
                                      "AND semantic_slot = %s AND state IN ('active', 'conflicted') "
                                      "AND statement <> %s FOR UPDATE",
                                      (campaign, task["subject"], slot,
                                       claim["statement"])).fetchall()
                finding_id = uuid.uuid4()
                state = "conflicted" if rivals else "active"
                conn.execute("INSERT INTO decomp_findings "
                             "(id, campaign_id, task_id, claim_index, subject, semantic_slot, "
                             "statement, claim_artifact, draft_artifact, review_artifact, state) "
                             "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                             (finding_id, campaign, task_id, index, task["subject"],
                              slot, claim["statement"], artifact, task["result_artifact"],
                              task["review_artifact"], state))
                for key, version in sorted(pins.items()):
                    conn.execute("INSERT INTO decomp_finding_dependencies "
                                 "(finding_id, campaign_id, contract_key, contract_version) "
                                 "VALUES (%s,%s,%s,%s)",
                                 (finding_id, campaign, key, version))
                for rival in rivals:
                    conn.execute("UPDATE decomp_findings SET state = 'conflicted', "
                                 "updated_at = now() WHERE id = %s", (rival["id"],))
                    pair = sorted((finding_id, rival["id"]))
                    conflict = conn.execute("INSERT INTO decomp_claim_conflicts "
                                            "(id, campaign_id, finding_a, finding_b) "
                                            "VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING "
                                            "RETURNING id",
                                            (uuid.uuid4(), campaign, pair[0], pair[1])).fetchone()
                    if conflict:
                        self.queue._event(conn, campaign, "claim_conflict_opened",
                                          {"conflict_id": str(conflict["id"]),
                                           "finding_a": str(pair[0]), "finding_b": str(pair[1]),
                                           "semantic_slot": slot})
                if rivals:
                    source_pairs = [(task_id, index)] + [
                        (str(rival["task_id"]), rival["claim_index"]) for rival in rivals]
                    for source_task, source_index in source_pairs:
                        heads = conn.execute(
                            "SELECT h.contract_key, h.version FROM decomp_contract_heads h "
                            "JOIN decomp_contract_versions v ON v.campaign_id = h.campaign_id "
                            "AND v.contract_key = h.contract_key AND v.version = h.version "
                            "WHERE h.campaign_id = %s AND h.state = 'active' "
                            "AND v.source_task_id = %s AND v.claim_index = %s FOR UPDATE OF h",
                            (campaign, source_task, source_index)).fetchall()
                        for head in heads:
                            conn.execute("UPDATE decomp_contract_heads SET state = 'disputed', "
                                         "updated_at = now() WHERE campaign_id = %s "
                                         "AND contract_key = %s",
                                         (campaign, head["contract_key"]))
                            invalidated = self._invalidate_consumers(
                                conn, campaign, head["contract_key"], head["version"],
                                "source_claim_conflicted")
                            self.queue._event(conn, campaign, "contract_disputed",
                                              {"contract_key": head["contract_key"],
                                               "version": head["version"],
                                               "invalidated": invalidated})
                self.queue._event(conn, campaign, "finding_published",
                                  {"finding_id": str(finding_id), "task_id": task_id,
                                   "claim_index": index, "semantic_slot": slot,
                                   "state": state, "artifact": artifact})
                published.append({"finding_id": str(finding_id), "artifact": artifact,
                                  "state": state, "duplicate": False})
        return sorted(published, key=lambda item: next(
            index for index, _, artifact in prepared if artifact == item["artifact"]))

    def inventory(self, campaign: str) -> dict:
        with self.queue._connect() as conn:
            findings = conn.execute("SELECT id, task_id, claim_index, subject, semantic_slot, "
                                    "statement, claim_artifact, state FROM decomp_findings "
                                    "WHERE campaign_id = %s ORDER BY created_at, id",
                                    (campaign,)).fetchall()
            conflicts = conn.execute("SELECT id, finding_a, finding_b, state "
                                     "FROM decomp_claim_conflicts WHERE campaign_id = %s "
                                     "ORDER BY created_at, id", (campaign,)).fetchall()
            heads = conn.execute("SELECT contract_key, version, artifact, state "
                                 "FROM decomp_contract_heads WHERE campaign_id = %s "
                                 "ORDER BY contract_key", (campaign,)).fetchall()
        return {"campaign": campaign,
                "findings": [{**row, "id": str(row["id"]),
                              "task_id": str(row["task_id"])} for row in findings],
                "conflicts": [{**row, "id": str(row["id"]),
                               "finding_a": str(row["finding_a"]),
                               "finding_b": str(row["finding_b"])} for row in conflicts],
                "contract_heads": heads}
