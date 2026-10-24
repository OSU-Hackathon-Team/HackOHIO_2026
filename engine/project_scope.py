"""Build bounded module scopes connected by unverified cross-module call candidates."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re

from engine.analysis.ghidra import GhidraAnalysis
from engine.intake import canonical
from engine.models import ScopeRequest
from engine.scope import discover, persist_scope, resolve_seed


@dataclass(frozen=True)
class ProjectScopeRequest:
    mode: str
    query: str
    seeds: tuple[tuple[str, str], ...]
    max_functions_per_module: int = 32
    max_depth: int = 2
    include_callers: bool = False
    include_shared_data: bool = True
    expected_observables: tuple[str, ...] = ()

    @classmethod
    def from_dict(cls, value: dict, module_ids: set[str]) -> "ProjectScopeRequest":
        if not isinstance(value, dict) or set(value) - {
                "mode", "query", "seeds", "max_functions_per_module", "max_depth",
                "include_callers", "include_shared_data", "expected_observables"} or not {
                "mode", "query"} <= set(value):
            raise ValueError("invalid project scope request fields")
        seeds = value.get("seeds", [])
        if not isinstance(seeds, list) or not all(
                isinstance(item, dict) and set(item) == {"module", "seed"} and
                isinstance(item["module"], str) and item["module"] in module_ids and
                isinstance(item["seed"], str) and item["seed"]
                for item in seeds):
            raise ValueError("project seeds must name supplied modules and nonempty symbols")
        observables = value.get("expected_observables", [])
        if not isinstance(observables, list) or not all(
                isinstance(item, str) and item for item in observables):
            raise ValueError("expected observables must be nonempty strings")
        data = {**value, "seeds": tuple(sorted({(item["module"], item["seed"])
                                                 for item in seeds})),
                "expected_observables": tuple(observables)}
        request = cls(**data)
        if request.mode not in {"subsystem", "project"} or not isinstance(
                request.query, str) or not request.query:
            raise ValueError("project scope needs a mode and nonempty query")
        if request.mode == "subsystem" and not request.seeds:
            raise ValueError("subsystem project scope needs a seed")
        if request.mode == "project" and request.seeds:
            raise ValueError("project-wide scope uses all discovered module functions")
        if not isinstance(request.max_functions_per_module, int) or isinstance(
                request.max_functions_per_module, bool) or not 1 <= request.max_functions_per_module <= 10000:
            raise ValueError("max_functions_per_module must be between 1 and 10000")
        if not isinstance(request.max_depth, int) or isinstance(
                request.max_depth, bool) or not 0 <= request.max_depth <= 100:
            raise ValueError("max_depth must be between 0 and 100")
        if not isinstance(request.include_callers, bool) or not isinstance(
                request.include_shared_data, bool):
            raise ValueError("scope expansion flags must be booleans")
        return request

    def as_dict(self) -> dict:
        return {**asdict(self), "seeds": [{"module": module, "seed": seed}
                                          for module, seed in self.seeds]}


def persist_project_scope(engine: GhidraAnalysis, project_artifact: str,
                          request_value: dict) -> dict:
    project = json.loads(engine.store.get(project_artifact))
    if project.get("schema") != 2 or not re.fullmatch(
            r"[a-f0-9]{64}", project.get("project_id", "")):
        raise ValueError("project scope requires a schema 2 intake artifact")
    modules = {item["id"]: item for item in project["modules"]}
    request = ProjectScopeRequest.from_dict(request_value, set(modules))
    links = json.loads(engine.store.get(project["symbol_links_artifact"]))
    if links.get("schema") != 1:
        raise ValueError("unsupported project symbol links")
    manifests = {}
    indexes = {}
    for module_id, module in modules.items():
        campaign = module["analysis_campaign"]
        if not isinstance(campaign, str) or not re.fullmatch(r"[a-f0-9]{64}", campaign):
            raise ValueError(f"invalid analysis identity for {module_id}")
        project_dir = engine.root / "projects" / campaign
        manifest = json.loads((project_dir / "manifest.json").read_text())
        if (manifest["campaign"] != module["analysis_campaign"] or
                manifest["index_artifact"] != module["index_artifact"] or
                manifest["binary_sha256"] != module["binary_sha256"] or
                Path(manifest["project"]).resolve() != project_dir.resolve()):
            raise ValueError(f"analysis identity changed for {module_id}")
        manifests[module_id] = manifest
        indexes[module_id] = engine.index(manifest)
    scope_id = hashlib.sha256(canonical({"project_artifact": project_artifact,
                                         "request": request.as_dict()})).hexdigest()
    directory = engine.root / "project-scopes" / scope_id
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".scope.lock").open("a+b") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            seeds: dict[str, set[str]] = {module_id: set() for module_id in modules}
            unresolved = []
            for module_id, seed in request.seeds:
                matches = resolve_seed(seed, indexes[module_id])
                if not matches:
                    unresolved.append({"kind": "seed_not_found", "module": module_id,
                                       "seed": seed})
                seeds[module_id].update(item["entry"] for item in matches)

            def module_request(module_id: str) -> ScopeRequest:
                return ScopeRequest(mode=request.mode, query=f"{request.query} [{module_id}]",
                                    seeds=tuple(sorted(seeds[module_id])),
                                    max_functions=request.max_functions_per_module,
                                    max_depth=request.max_depth,
                                    include_callers=request.include_callers,
                                    include_shared_data=request.include_shared_data,
                                    expected_observables=request.expected_observables)

            def drafts() -> dict[str, dict]:
                return {module_id: discover(indexes[module_id], module_request(module_id),
                                            module["analysis_campaign"],
                                            module["index_artifact"])
                        for module_id, module in modules.items()
                        if request.mode == "project" or seeds[module_id]}

            if request.mode == "subsystem":
                while True:
                    current = drafts()
                    included = {module_id: {item["entry"] for item in scope["included"]}
                                for module_id, scope in current.items()}
                    changed = False
                    for link in links["candidates"]:
                        if any(site["caller"] in included.get(link["from_module"], set())
                               for site in link["call_sites"]):
                            target_seeds = seeds[link["to_module"]]
                            if link["target_entry"] not in target_seeds:
                                target_seeds.add(link["target_entry"])
                                changed = True
                    if not changed:
                        break

            final_drafts = drafts()
            included = {module_id: {item["entry"] for item in scope["included"]}
                        for module_id, scope in final_drafts.items()}
            unresolved_by_module: dict[str, list[dict]] = {module_id: []
                                                            for module_id in final_drafts}

            def record_unresolved(module_id: str, edge: dict) -> None:
                unresolved.append(edge)
                unresolved_by_module[module_id].append(edge)

            cross_candidates = []
            for link in links["candidates"]:
                sites = [site for site in link["call_sites"]
                         if site["caller"] in included.get(link["from_module"], set())]
                if not sites:
                    continue
                target_included = link["target_entry"] in included.get(link["to_module"], set())
                cross_candidates.append({"from_module": link["from_module"],
                                         "to_module": link["to_module"],
                                         "symbol": link["symbol"],
                                         "target_entry": link["target_entry"],
                                         "source_index_artifact": link["source_index_artifact"],
                                         "target_index_artifact": link["target_index_artifact"],
                                         "call_sites": sites,
                                         "target_included": target_included,
                                         "binding": "candidate_static"})
                record_unresolved(link["from_module"], {
                    "kind": "cross_module_binding_unverified",
                    "from_module": link["from_module"],
                    "to_module": link["to_module"],
                    "symbol": link["symbol"],
                    "target_entry": link["target_entry"],
                    "source_index_artifact": link["source_index_artifact"],
                    "target_index_artifact": link["target_index_artifact"],
                    "call_sites": sites,
                    "target_included": target_included})
            for kind in ("ambiguous", "unmatched"):
                for link in links[kind]:
                    sites = [site for site in link["call_sites"]
                             if site["caller"] in included.get(link["from_module"], set())]
                    if sites:
                        edge = {"kind": f"cross_module_import_{kind}",
                                "from_module": link["from_module"],
                                "symbol": link["symbol"],
                                "reason": link["reason"],
                                "source_index_artifact": link["source_index_artifact"],
                                "call_sites": sites}
                        if kind == "ambiguous":
                            edge["candidates"] = link["candidates"]
                        record_unresolved(link["from_module"], edge)
            project_context = {"project_scope_id": scope_id,
                               "project_artifact": project_artifact,
                               "symbol_links_artifact": project["symbol_links_artifact"]}
            module_scopes = []
            for module_id, module in sorted(modules.items()):
                if module_id not in final_drafts:
                    continue
                scope = persist_scope(
                    engine, manifests[module_id], module_request(module_id),
                    project_context=project_context,
                    additional_unresolved=tuple(unresolved_by_module[module_id]))
                module_scopes.append({"module_id": module_id,
                                      "campaign": module["analysis_campaign"],
                                      "scope_id": scope["scope_id"],
                                      "scope_artifact": scope["artifact"],
                                      "revision": scope["revision"],
                                      "included": len(scope["included"]),
                                      "tasks": len(scope["tasks"]),
                                      "unresolved": len(scope["unresolved"])})
            content = {"schema": 1, "project_id": project["project_id"],
                       "project_artifact": project_artifact,
                       "symbol_links_artifact": project["symbol_links_artifact"],
                       "scope_id": scope_id, "request": request.as_dict(),
                       "module_scopes": module_scopes,
                       "cross_module_candidates": cross_candidates,
                       "unresolved": unresolved,
                       "unexplored_modules": sorted(set(modules) - set(included)),
                       "coverage": {"modules": len(module_scopes),
                                    "included_functions": sum(item["included"] for item in
                                                              module_scopes),
                                    "tasks": sum(item["tasks"] for item in module_scopes),
                                    "unclassified_executable_bytes": sum(
                                        indexes[module_id].get("static_inventory", {}).get(
                                            "unclassified_executable_bytes", 0)
                                        for module_id in final_drafts),
                                    "cross_module_candidates": len(cross_candidates)},
                       "readiness": "partial"}
            latest = directory / "latest.json"
            semantic_hash = hashlib.sha256(canonical(content)).hexdigest()
            if latest.exists():
                previous = json.loads(latest.read_text())
                if previous["semantic_hash"] == semantic_hash:
                    return {**content, "revision": previous["revision"],
                            "artifact": previous["artifact"]}
                revision = previous["revision"] + 1
            else:
                revision = 1
            content["revision"] = revision
            artifact = engine.store.put(canonical(content))
            pointer = {"revision": revision, "artifact": artifact,
                       "semantic_hash": semantic_hash}
            revision_path = directory / f"revision-{revision:06d}.json"
            with revision_path.open("x") as stream:
                stream.write(json.dumps(pointer, sort_keys=True) + "\n")
            temporary = latest.with_suffix(".tmp")
            temporary.write_text(json.dumps(pointer, sort_keys=True) + "\n")
            os.replace(temporary, latest)
            engine._emit(project["project_id"], "project_scope_revised",
                         scope_id=scope_id, revision=revision, artifact=artifact,
                         modules=len(module_scopes),
                         included=content["coverage"]["included_functions"],
                         unresolved=len(unresolved))
            return {**content, "artifact": artifact}
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
