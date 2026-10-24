"""Export indexed functions across a native project without hiding coverage gaps."""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import re

from engine.analysis.ghidra import GhidraAnalysis
from engine.intake import canonical


def export_project(engine: GhidraAnalysis, project_artifact: str) -> dict:
    project = json.loads(engine.store.get(project_artifact))
    if (project.get("schema") != 2 or not isinstance(project.get("modules"), list) or
            not project["modules"]):
        raise ValueError("project export requires a schema 2 intake artifact")
    project_id = project["project_id"]
    if not isinstance(project_id, str) or not re.fullmatch(r"[a-f0-9]{64}", project_id):
        raise ValueError("invalid project identity")
    directory = engine.root / "intakes" / project_id / "exports"
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".export.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            engine._emit(project_id, "project_export_started", modules=len(project["modules"]))
            results = []
            totals: dict[str, int] = {}
            unassigned_instructions = 0
            for module in project["modules"]:
                module_id = module["id"]
                engine._emit(project_id, "project_export_module_started", module_id=module_id)
                try:
                    campaign = module["analysis_campaign"]
                    if not isinstance(campaign, str) or not re.fullmatch(
                            r"[a-f0-9]{64}", campaign):
                        raise ValueError("invalid module analysis identity")
                    project_dir = engine.root / "projects" / campaign
                    manifest = json.loads((project_dir / "manifest.json").read_text())
                    if (manifest["campaign"] != module["analysis_campaign"] or
                            manifest["index_artifact"] != module["index_artifact"] or
                            manifest["binary_sha256"] != module["binary_sha256"] or
                            Path(manifest["project"]).resolve() != project_dir.resolve()):
                        raise ValueError("module analysis identity changed")
                    exported = engine.export_all(manifest)
                    result = {"module_id": module_id, "campaign": manifest["campaign"],
                              "inventory_artifact": exported["artifact"],
                              "discovered_functions": module["function_count"],
                              "counts": exported["counts"],
                              "complete_discovered_exports": exported["complete"],
                              "static_inventory": exported["static_inventory"],
                              "unassigned_instruction_regions":
                                  exported["unassigned_instruction_regions"]}
                    if "bulk_error" in exported:
                        result["bulk_error"] = exported["bulk_error"]
                    for status, count in exported["counts"].items():
                        totals[status] = totals.get(status, 0) + count
                    unassigned_instructions += (exported["static_inventory"] or {}).get(
                        "unassigned_instructions", 0)
                    engine._emit(project_id, "project_export_module_finished",
                                 module_id=module_id, artifact=exported["artifact"],
                                 counts=exported["counts"], complete=exported["complete"])
                except Exception as error:
                    result = {"module_id": module_id,
                              "campaign": module["analysis_campaign"],
                              "discovered_functions": module["function_count"],
                              "complete_discovered_exports": False,
                              "error": f"{type(error).__name__}: {error}"}
                    engine._emit(project_id, "project_export_module_failed",
                                 module_id=module_id, error=result["error"])
                results.append(result)
            discovered = sum(module["function_count"] for module in project["modules"])
            inventory = {"schema": 1, "project_id": project_id,
                         "project_artifact": project_artifact,
                         "modules": results,
                         "counts": dict(sorted(totals.items())),
                         "discovered_functions": discovered,
                         "unreported_functions": discovered - sum(totals.values()),
                         "unassigned_instructions": (unassigned_instructions if all(
                             "static_inventory" in item for item in results) else None),
                         "complete_discovered_exports": all(
                             item["complete_discovered_exports"] for item in results),
                         "symbol_links_artifact": project["symbol_links_artifact"],
                         "symbol_link_counts": project["symbol_link_counts"],
                         "unresolved_dependencies": project["unresolved_dependencies"]}
            artifact = engine.store.put(canonical(inventory))
            pointer = directory / "latest.json"
            temporary = pointer.with_suffix(".tmp")
            temporary.write_text(json.dumps({"artifact": artifact}) + "\n")
            os.replace(temporary, pointer)
            engine._emit(project_id, "project_export_finished", artifact=artifact,
                         counts=inventory["counts"],
                         complete=inventory["complete_discovered_exports"],
                         unassigned_instructions=inventory["unassigned_instructions"],
                         unreported_functions=inventory["unreported_functions"])
            return {**inventory, "artifact": artifact}
        except Exception as error:
            engine._emit(project_id, "project_export_failed", error=str(error))
            raise
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
