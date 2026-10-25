"""Compact typed inventory of persisted native pipeline results."""

from __future__ import annotations

import json
from pathlib import Path

from engine.artifacts import LocalArtifactStore


def inventory(state: Path) -> dict:
    state = state.resolve()
    store = LocalArtifactStore(state / "artifacts")
    result: dict[str, object] = {"schema": 1, "projects": [], "project_scopes": [],
                                 "module_scopes": [], "dossiers": [], "specs": []}
    for path in sorted((state / "projects").glob("*/manifest.json")):
        value = json.loads(path.read_text())
        result["projects"].append({
            "campaign": value["campaign"], "binary": value["binary"],
            "index_artifact": value["index_artifact"],
            "function_count": value["function_count"], "manifest": str(path)})
    for directory, key, fields in (
            ("project-scopes", "project_scopes", ("project_artifact", "readiness", "coverage")),
            ("scopes", "module_scopes", ("campaign", "readiness")),
            ("dossiers", "dossiers", ("campaign", "readiness", "scope_id"))):
        for path in sorted((state / directory).glob("*/latest.json")):
            pointer = json.loads(path.read_text())
            artifact = pointer["artifact"]
            value = json.loads(store.get(artifact))
            item = {"artifact": artifact, "revision": pointer["revision"],
                    "pointer": str(path)}
            item.update({field: value.get(field) for field in fields})
            if key == "module_scopes":
                item["included_functions"] = len(value.get("included", []))
            if key == "dossiers":
                item["blocker_count"] = len(value.get("blockers", []))
            result[key].append(item)
    for path in sorted((state / "specifications").glob("**/*writer-*.json")):
        pointer = json.loads(path.read_text())
        artifact = pointer.get("artifact")
        if not artifact:
            continue
        value = json.loads(store.get(artifact))
        result["specs"].append({"artifact": artifact,
                                "status": value.get("status"),
                                "title": value.get("title"),
                                "pointer": str(path)})
    return result
