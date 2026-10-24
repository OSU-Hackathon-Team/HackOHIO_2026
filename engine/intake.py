"""Analyze a declared set of native modules and persist one project inventory."""

from __future__ import annotations

import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess

from engine.analysis.ghidra import GhidraAnalysis, SCRIPT_DIR, file_hash, tool_version


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _elf_dynamic(path: Path) -> tuple[list[str], str | None, str]:
    with path.open("rb") as stream:
        magic = stream.read(4)
    if magic != b"\x7fELF":
        return [], None, "not_elf"
    result = subprocess.run(["readelf", "-d", "--", str(path)], text=True,
                            capture_output=True, check=False, timeout=30,
                            env={**os.environ, "LC_ALL": "C"})
    if result.returncode:
        raise RuntimeError(f"readelf could not inspect {path}: {result.stderr.strip()}")
    needed = re.findall(r"\(NEEDED\).*Shared library: \[([^]]+)\]", result.stdout)
    sonames = re.findall(r"\(SONAME\).*Library soname: \[([^]]+)\]", result.stdout)
    return sorted(set(needed)), sonames[0] if sonames else None, "elf_dynamic"


def _request(path: Path) -> tuple[list[dict], list[dict]]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or value.get("schema") != 1 or not isinstance(
            value.get("modules"), list) or not value["modules"]:
        raise ValueError("project request needs schema 1 and a nonempty modules array")
    if set(value) - {"schema", "modules", "dependencies"}:
        raise ValueError("unknown project request fields")
    modules = []
    ids = set()
    paths = set()
    for item in value["modules"]:
        if not isinstance(item, dict) or set(item) != {"id", "path", "kind"}:
            raise ValueError("each module needs id, path, and kind")
        module_id = item["id"]
        if not isinstance(module_id, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]*", module_id):
            raise ValueError("module id must start with a letter and use letters, digits, ._- only")
        if item["kind"] not in {"executable", "shared"}:
            raise ValueError("module kind must be executable or shared")
        if not isinstance(item["path"], str) or not item["path"]:
            raise ValueError("module path must be nonempty")
        binary = (path.parent / item["path"]).resolve(strict=True)
        if not binary.is_file():
            raise ValueError(f"module path is not a file: {binary}")
        if module_id in ids or binary in paths:
            raise ValueError("duplicate module id or path")
        ids.add(module_id)
        paths.add(binary)
        needed, soname, scan = _elf_dynamic(binary)
        modules.append({"id": module_id, "kind": item["kind"], "path": str(binary),
                        "binary_sha256": file_hash(binary), "needed": needed,
                        "soname": soname, "dependency_scan": scan})
    declared = value.get("dependencies", [])
    if not isinstance(declared, list):
        raise ValueError("dependencies must be an array")
    edges = []
    for edge in declared:
        if not isinstance(edge, dict) or set(edge) != {"from", "to"} or not all(
                isinstance(edge[key], str) and edge[key] in ids for key in ("from", "to")):
            raise ValueError("declared dependencies must refer to module ids")
        if edge["from"] == edge["to"]:
            raise ValueError("a module cannot depend on itself")
        edges.append({"from": edge["from"], "to": edge["to"], "source": "declared"})
    return sorted(modules, key=lambda item: item["id"]), sorted(
        edges, key=lambda item: (item["from"], item["to"]))


def _dependencies(modules: list[dict], declared: list[dict]) -> tuple[list[dict], list[dict]]:
    by_name: dict[str, list[str]] = {}
    for module in modules:
        if module["kind"] == "shared":
            for name in {Path(module["path"]).name, module["soname"]} - {None}:
                by_name.setdefault(name, []).append(module["id"])
    edges = {(edge["from"], edge["to"]): edge for edge in declared}
    unresolved = []
    for module in modules:
        for name in module["needed"]:
            matches = sorted(set(by_name.get(name, [])) - {module["id"]})
            if len(matches) == 1:
                edges.setdefault((module["id"], matches[0]),
                                 {"from": module["id"], "to": matches[0],
                                  "source": "elf_needed", "name": name})
            else:
                unresolved.append({"from": module["id"], "name": name,
                                   "reason": "external" if not matches else "ambiguous",
                                   "candidates": matches})
    return sorted(edges.values(), key=lambda edge: (edge["from"], edge["to"])), unresolved


def analyze_project(engine: GhidraAnalysis, request_path: Path) -> dict:
    modules, declared = _request(request_path.resolve(strict=True))
    edges, unresolved = _dependencies(modules, declared)
    identity = {"schema": 1, "modules": modules, "dependencies": edges,
                "unresolved_dependencies": unresolved,
                "ghidra_version_sha256": tool_version(engine.headless),
                "exporter_sha256": file_hash(SCRIPT_DIR / "ExportEvidence.java")}
    project_id = hashlib.sha256(canonical(identity)).hexdigest()
    directory = engine.root / "intakes" / project_id
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".intake.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            pointer = directory / "manifest.json"
            if pointer.exists():
                artifact = json.loads(pointer.read_text())["artifact"]
                project = json.loads(engine.store.get(artifact))
                if project.get("project_id") != project_id:
                    raise RuntimeError("cached project identity does not match its pointer")
                for module in project["modules"]:
                    manifest = engine.analyze(Path(module["path"]))
                    if (manifest["campaign"] != module["analysis_campaign"] or
                            manifest["index_artifact"] != module["index_artifact"]):
                        raise RuntimeError(f"cached analysis changed for {module['id']}")
                engine._emit(project_id, "project_cache_hit", artifact=artifact)
                return {**project, "artifact": artifact}
            engine._emit(project_id, "project_intake_started", modules=len(modules))
            analyzed = []
            for module in modules:
                engine._emit(project_id, "project_module_started", module_id=module["id"])
                try:
                    manifest = engine.analyze(Path(module["path"]))
                except Exception as error:
                    engine._emit(project_id, "project_module_failed", module_id=module["id"],
                                 error=str(error))
                    raise
                analyzed.append({**module, "analysis_campaign": manifest["campaign"],
                                 "index_artifact": manifest["index_artifact"],
                                 "function_count": manifest["function_count"],
                                 "analysis_manifest": str(Path(manifest["project"]) / "manifest.json")})
                engine._emit(project_id, "project_module_finished", module_id=module["id"],
                             module_campaign=manifest["campaign"],
                             functions=manifest["function_count"])
            project = {"schema": 1, "project_id": project_id, "modules": analyzed,
                       "dependencies": edges, "unresolved_dependencies": unresolved,
                       "ghidra_version_sha256": identity["ghidra_version_sha256"],
                       "exporter_sha256": identity["exporter_sha256"]}
            artifact = engine.store.put(canonical(project))
            temporary = pointer.with_suffix(".tmp")
            temporary.write_text(json.dumps({"artifact": artifact}) + "\n")
            os.replace(temporary, pointer)
            engine._emit(project_id, "project_intake_finished", modules=len(analyzed),
                         artifact=artifact, unresolved_dependencies=len(unresolved))
            return {**project, "artifact": artifact}
        except Exception as error:
            engine._emit(project_id, "project_intake_failed", error=str(error))
            raise
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
