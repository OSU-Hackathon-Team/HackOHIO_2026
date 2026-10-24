"""Register and observe module queues for one immutable project scope."""

from __future__ import annotations

import json
import re

from engine.queue import DurableQueue


def _project_modules(queue: DurableQueue, project_scope_artifact: str) -> tuple[dict, list[dict]]:
    scope = json.loads(queue.store.get(project_scope_artifact))
    if scope.get("schema") != 1 or not isinstance(scope.get("project_artifact"), str):
        raise ValueError("project queue requires a project scope artifact")
    project = json.loads(queue.store.get(scope["project_artifact"]))
    if (project.get("schema") != 2 or project.get("project_id") != scope.get("project_id") or
            not isinstance(scope.get("scope_id"), str) or
            not re.fullmatch(r"[a-f0-9]{64}", scope["scope_id"])):
        raise ValueError("project scope identity does not match intake")
    by_id = {item["id"]: item for item in project["modules"]}
    entries = scope.get("module_scopes")
    if not isinstance(entries, list) or not entries:
        raise ValueError("project scope has no module work")
    seen = set()
    modules = []
    for entry in entries:
        module_id = entry["module_id"]
        if module_id in seen or module_id not in by_id:
            raise ValueError("duplicate or unknown module in project scope")
        seen.add(module_id)
        source = by_id[module_id]
        module_scope = json.loads(queue.store.get(entry["scope_artifact"]))
        if (entry["campaign"] != source["analysis_campaign"] or
                entry["scope_id"] != module_scope.get("scope_id") or
                entry["revision"] != module_scope.get("revision") or
                module_scope.get("campaign") != source["analysis_campaign"] or
                module_scope.get("index_artifact") != source["index_artifact"] or
                module_scope.get("project_context", {}).get("project_scope_id") !=
                scope["scope_id"] or
                module_scope["project_context"].get("project_artifact") !=
                scope["project_artifact"] or
                entry["tasks"] != len(module_scope.get("tasks", [])) or
                entry["included"] != len(module_scope.get("included", [])) or
                any(task.get("kind") != "behavior" or
                    task.get("index_artifact") != source["index_artifact"]
                    for task in module_scope["tasks"]) or
                len({task.get("deduplication_key") for task in module_scope["tasks"]}) !=
                len(module_scope["tasks"])):
            raise ValueError(f"module scope identity changed for {module_id}")
        modules.append({"module_id": module_id,
                        "campaign": source["analysis_campaign"],
                        "binary_sha256": source["binary_sha256"],
                        "scope_id": entry["scope_id"],
                        "scope_artifact": entry["scope_artifact"],
                        "included": entry["included"], "tasks": entry["tasks"],
                        "task_keys": [task["deduplication_key"]
                                      for task in module_scope["tasks"]]})
    return scope, sorted(modules, key=lambda item: item["module_id"])


def enqueue_project_scope(queue: DurableQueue, project_scope_artifact: str) -> dict:
    """Idempotently register every reached module and enqueue its semantic tasks."""
    scope, modules = _project_modules(queue, project_scope_artifact)
    queue.migrate()
    result = []
    for module in modules:
        queue.create_campaign(module["campaign"], module["binary_sha256"])
        inserted = queue.enqueue_scope(module["scope_artifact"])
        result.append({**{key: value for key, value in module.items()
                          if key != "task_keys"},
                       "enqueued": len(inserted), "task_ids": inserted})
    return {"project_id": scope["project_id"], "project_scope_id": scope["scope_id"],
            "project_scope_artifact": project_scope_artifact,
            "modules": result, "enqueued": sum(item["enqueued"] for item in result),
            "planned_tasks": sum(item["tasks"] for item in result),
            "unresolved": len(scope["unresolved"])}


def project_queue_status(queue: DurableQueue, project_scope_artifact: str) -> dict:
    """Show queue counts for exactly the modules reached by one project scope."""
    scope, modules = _project_modules(queue, project_scope_artifact)
    result = []
    for module in modules:
        with queue._connect() as conn:
            rows = conn.execute(
                "SELECT deduplication_key, state, support_level, scope_artifact "
                "FROM decomp_tasks WHERE campaign_id = %s "
                "AND deduplication_key = ANY(%s)",
                (module["campaign"], module["task_keys"])).fetchall()
        states = {}
        support_levels = {}
        for row in rows:
            states[row["state"]] = states.get(row["state"], 0) + 1
            if row["support_level"] is not None:
                level = row["support_level"]
                support_levels[level] = support_levels.get(level, 0) + 1
        result.append({**{key: value for key, value in module.items()
                          if key != "task_keys"},
                       "scope_tasks": {"planned": module["tasks"],
                                       "present": len(rows),
                                       "missing": module["tasks"] - len(rows),
                                       "states": states,
                                       "support_levels": support_levels,
                                       "shared_from_other_scopes": sum(
                                           row["scope_artifact"] !=
                                           module["scope_artifact"] for row in rows)},
                       "campaign_queue": queue.status(module["campaign"])})
    return {"project_id": scope["project_id"], "project_scope_id": scope["scope_id"],
            "project_scope_artifact": project_scope_artifact,
            "modules": result, "planned_tasks": sum(item["tasks"] for item in result),
            "unresolved": len(scope["unresolved"]),
            "unexplored_modules": scope["unexplored_modules"]}
