"""Bounded native subsystem discovery over immutable Ghidra indexes."""

from __future__ import annotations

import functools
import hashlib
import heapq
import json
import os
from pathlib import Path
import subprocess

from engine.analysis.elfinfo import build_id, debug_file_for
from engine.analysis.ghidra import GhidraAnalysis
from engine.models import ScopeRequest


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


ROOT = Path(__file__).resolve().parents[1]


@functools.lru_cache(maxsize=8)
def _nm_symbols(debug_path: str, base: int) -> tuple[tuple[int, str], ...]:
    """Function symbols from a debug file; cached because resolve_seed runs once per seed."""
    try:
        out = subprocess.check_output(["nm", "-n", debug_path], text=True,
                                      stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError):
        return ()
    symbols: dict[int, str] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 3 and parts[1] in ("T", "t", "W", "w"):
            sym_addr = int(parts[0], 16)
            symbols[sym_addr] = parts[2]
            if base:
                symbols[base + sym_addr] = parts[2]
    return tuple(symbols.items())


def load_companion_debug_symbols(index: dict, campaign: str | None = None) -> dict[int, str]:
    prog_str = index.get("program")
    candidate_paths = []
    decomp_state = Path(os.environ.get("DECOMP_STATE", "/home/mitch/Documents/HackOHIO_2026/decomp-state"))
    if prog_str:
        candidate_paths.extend([
            Path(prog_str),
            ROOT / "decomp-state" / "fixtures" / prog_str,
            Path.cwd() / "decomp-state" / "fixtures" / prog_str,
            decomp_state / "fixtures" / prog_str,
        ])
    if campaign:
        for mpath in (
            ROOT / "decomp-state" / "projects" / campaign / "manifest.json",
            Path.cwd() / "decomp-state" / "projects" / campaign / "manifest.json",
            decomp_state / "projects" / campaign / "manifest.json",
        ):
            if mpath.is_file():
                try:
                    b = json.loads(mpath.read_text()).get("binary")
                    if b:
                        candidate_paths.append(Path(b))
                except Exception:
                    pass
    base = int(index.get("image_base", "0"), 16)
    for p in candidate_paths:
        debug_paths = [p.with_suffix(".debug"), p.parent / (p.name + ".debug"),
                       p.with_name(p.stem + ".debug")]
        # Distribution debug packages (e.g. libreoffice-calc-dbgsym) install by GNU build-id.
        if p.is_file():
            try:
                by_build_id = debug_file_for(build_id(p.read_bytes()))
            except OSError:
                by_build_id = None
            if by_build_id is not None:
                debug_paths.append(by_build_id)
        for debug_path in debug_paths:
            if debug_path.is_file():
                symbols = _nm_symbols(str(debug_path), base)
                if symbols:
                    return dict(symbols)
    return {}


def resolve_seed(seed: str, index: dict, campaign: str | None = None) -> list[dict]:
    functions = index["functions"]
    matches = []
    try:
        numeric = int(seed, 16)
    except ValueError:
        numeric = None
    if numeric is not None:
        matches = [{"entry": item["entry"], "score": 100, "reason": "address"}
                   for item in functions if int(item["entry"], 16) == numeric]
    if not matches:
        exact = [item for item in functions if item["name"].lower() == seed.lower()]
        matches = [{"entry": item["entry"], "score": 90 if not item["thunk"] else 50,
                    "reason": "exact_symbol"} for item in exact]
    if not matches:
        debug_symbols = load_companion_debug_symbols(index, campaign)
        for sym_addr, sym_name in debug_symbols.items():
            if sym_name.lower() == seed.lower():
                for item in functions:
                    if int(item["entry"], 16) == sym_addr and not item.get("thunk"):
                        matches.append({"entry": item["entry"], "score": 85,
                                        "reason": "companion_debug_symbol"})
    if not matches:
        partial = [item for item in functions if seed.lower() in item["name"].lower()]
        matches = [{"entry": item["entry"], "score": 55 if not item["thunk"] else 30,
                    "reason": "partial_symbol"} for item in partial]
    if not matches:
        strings = {item["address"] for item in index.get("strings", [])
                   if seed.lower() in item["value"].lower()}
        matches = [{"entry": ref["function"], "score": 40,
                    "reason": "string_reference"}
                   for ref in index.get("data_references", []) if ref["target"] in strings]
    if not matches:
        imports = {item["address"] for item in index.get("imports", [])
                   if seed.lower() in item["name"].lower()}
        matches = [{"entry": call["caller"], "score": 35,
                    "reason": "import_call"}
                   for call in index.get("calls", []) if call["target"] in imports]
    unique = {item["entry"]: item for item in matches}
    return sorted(unique.values(), key=lambda item: (-item["score"], item["entry"]))


def discover(index: dict, request: ScopeRequest, campaign: str, index_artifact: str) -> dict:
    debug_symbols = load_companion_debug_symbols(index, campaign)
    by_entry = {item["entry"]: item for item in index["functions"]}
    outgoing: dict[str, list[dict]] = {}
    incoming: dict[str, list[dict]] = {}
    for call in index.get("calls", []):
        outgoing.setdefault(call["caller"], []).append(call)
        incoming.setdefault(call["target"], []).append(call)
    data_by_function: dict[str, set[str]] = {}
    data_users: dict[str, set[str]] = {}
    for ref in index.get("data_references", []):
        target = ref["target"]
        if target.startswith("Stack["):
            continue
        data_by_function.setdefault(ref["function"], set()).add(target)
        data_users.setdefault(target, set()).add(ref["function"])

    seed_results = []
    unresolved = []
    if request.mode == "project" and index.get("unassigned_instruction_regions"):
        unresolved.append({
            "kind": "unassigned_executable_instructions",
            "instructions": index["static_inventory"]["unassigned_instructions"],
            "instruction_bytes": index["static_inventory"]["unassigned_instruction_bytes"],
            "regions": index["unassigned_instruction_regions"],
        })
    if request.mode == "project" and index.get("static_inventory", {}).get(
            "unclassified_executable_bytes", 0):
        unresolved.append({
            "kind": "unclassified_executable_bytes",
            "bytes": index["static_inventory"]["unclassified_executable_bytes"],
            "region_count": index["static_inventory"]["unclassified_executable_regions"],
            "regions": index["unclassified_executable_regions"],
            "regions_truncated": index["unclassified_executable_regions_truncated"],
        })
    frontier = []
    sequence = 0

    def offer(entry: str, depth: int, priority: int, reason: str) -> None:
        nonlocal sequence
        sequence += 1
        heapq.heappush(frontier, (depth, -priority, sequence, entry, reason))

    seeds = request.seeds
    project_seed_entries = request.mode == "project" and not seeds
    if project_seed_entries:
        seeds = tuple(item["entry"] for item in index["functions"]
                      if not item["external"] and not item["thunk"])
    for seed in (*seeds, *request.inclusions):
        # Project seeds are already exact entries from this index. Resolving each
        # one by scanning every function makes full-project scope quadratic.
        matches = ([{"entry": seed, "score": 100, "reason": "address"}]
                   if project_seed_entries and seed in by_entry else
                   resolve_seed(seed, index, campaign))
        seed_results.append({"seed": seed, "matches": matches})
        if not matches:
            unresolved.append({"kind": "seed_not_found", "seed": seed})
        for match in matches:
            offer(match["entry"], 0, match["score"], f"seed:{seed}:{match['reason']}")

    included: dict[str, dict] = {}
    boundaries = []
    exclusions = []
    seen_boundary = set()
    while frontier and len(included) < request.max_functions:
        depth, negative_priority, _, entry, reason = heapq.heappop(frontier)
        if entry in included:
            included[entry]["reasons"].append(reason)
            continue
        item = by_entry.get(entry)
        if item is None:
            if entry.startswith("EXTERNAL:"):
                # Import stubs outside the analyzed binary can never be resolved
                # by deeper analysis; treat them as explicit subsystem boundaries
                # rather than unresolved edges.
                if entry not in seen_boundary:
                    boundaries.append({"entry": entry, "name": entry,
                                       "contract": "External import outside the analyzed binary; "
                                                   "behavior beyond the subsystem boundary.",
                                       "from": reason})
                    seen_boundary.add(entry)
                continue
            unresolved.append({"kind": "unknown_function", "entry": entry,
                               "from": reason})
            continue
        display_name = debug_symbols.get(int(entry, 16), item["name"]) if item["name"].startswith("FUN_") else item["name"]
        if (entry in request.exclusions or item["name"] in request.exclusions or
                display_name in request.exclusions):
            exclusions.append({"entry": entry, "name": display_name,
                               "reason": "explicit_exclusion"})
            continue
        contract = (request.boundary_contracts.get(entry) or
                    request.boundary_contracts.get(item["name"]) or
                    request.boundary_contracts.get(display_name))
        if contract:
            if entry not in seen_boundary:
                boundaries.append({"entry": entry, "name": display_name, "contract": contract,
                                   "from": reason})
                seen_boundary.add(entry)
            continue
        if item["thunk"]:
            target = item.get("thunk_target")
            if entry in seen_boundary:
                continue
            seen_boundary.add(entry)
            boundaries.append({"entry": entry, "name": display_name,
                               "contract": "thunk alias", "target": target,
                               "from": reason})
            if target and target != entry:
                offer(target, depth, -negative_priority, f"thunk_target:{entry}")
            else:
                unresolved.append({"kind": "thunk_target_unknown", "entry": entry})
            continue
        if item["external"]:
            boundaries.append({"entry": entry, "name": display_name,
                               "contract": None, "from": reason})
            unresolved.append({"kind": "external_contract_missing", "entry": entry,
                               "name": display_name})
            continue
        included[entry] = {"entry": entry, "name": display_name, "depth": depth,
                           "priority": -negative_priority, "reasons": [reason]}
        for call in index.get("indirect_calls", []):
            if call["caller"] == entry:
                unresolved.append({"kind": "indirect_call", "caller": entry,
                                   "site": call["site"], "instruction": call["instruction"]})
        if depth >= request.max_depth:
            for call in outgoing.get(entry, []):
                exclusions.append({"entry": call["target"], "from": entry,
                                   "reason": "depth_limit"})
            if request.include_callers:
                for call in incoming.get(entry, []):
                    exclusions.append({"entry": call["caller"], "from": entry,
                                       "reason": "depth_limit"})
            if request.include_shared_data:
                for target in data_by_function.get(entry, ()):
                    for neighbor in data_users.get(target, ()) - {entry}:
                        exclusions.append({"entry": neighbor, "from": entry,
                                           "via": target, "reason": "depth_limit"})
            continue
        for call in outgoing.get(entry, []):
            offer(call["target"], depth + 1, 80, f"called_by:{entry}@{call['site']}")
        if request.include_callers:
            for call in incoming.get(entry, []):
                offer(call["caller"], depth + 1, 35, f"calls:{entry}@{call['site']}")
        if request.include_shared_data:
            for target in sorted(data_by_function.get(entry, ())):
                for neighbor in sorted(data_users.get(target, ()) - {entry}):
                    offer(neighbor, depth + 1, 65,
                          f"shared_data:{target}:with:{entry}")
    pending = [(entry, reason) for _, _, _, entry, reason in frontier
               if entry not in included and entry not in seen_boundary]
    if pending:
        for entry, reason in pending:
            exclusions.append({"entry": entry, "from": reason,
                               "reason": "function_budget"})
        unresolved.append({"kind": "function_budget_exhausted",
                           "remaining_frontier": len({entry for entry, _ in pending})})
    exclusions = [item for item in exclusions if item["entry"] not in included]
    tasks = []
    for item in included.values():
        question = (f"Explain {item['name']} at {item['entry']}: inputs, outputs, state, "
                    "side effects, errors, boundary cases, and dependency assumptions. "
                    "Cite raw evidence addresses; list alternatives and unknowns.")
        key = hashlib.sha256(canonical({"campaign": campaign,
                                        "index": index_artifact,
                                        "entry": item["entry"],
                                        "question": question})).hexdigest()
        tasks.append({"schema": 1, "kind": "behavior", "subject": item["entry"],
                      "question": question, "priority": item["priority"],
                      "deduplication_key": key, "index_artifact": index_artifact})
    return {"schema": 1, "campaign": campaign, "index_artifact": index_artifact,
            "request": request.as_dict(), "seed_ranking": seed_results,
            "included": sorted(included.values(), key=lambda item: (item["depth"], item["entry"])),
            "boundaries": boundaries, "exclusions": exclusions,
            "unresolved": unresolved, "tasks": tasks, "readiness": "partial"}


def persist_scope(engine: GhidraAnalysis, manifest: dict, request: ScopeRequest, *,
                  project_context: dict | None = None,
                  additional_unresolved: tuple[dict, ...] = ()) -> dict:
    identity = {"campaign": manifest["campaign"], "request": request.as_dict()}
    if project_context is not None:
        identity["project_context"] = project_context
    scope_id = hashlib.sha256(canonical(identity)).hexdigest()
    content = discover(engine.index(manifest), request, manifest["campaign"],
                       manifest["index_artifact"])
    if project_context is not None:
        content["project_context"] = project_context
    content["unresolved"].extend(additional_unresolved)
    content["scope_id"] = scope_id
    folder = engine.root / "scopes" / scope_id
    folder.mkdir(parents=True, exist_ok=True)
    latest = folder / "latest.json"
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
    revision_path = folder / f"revision-{revision:06d}.json"
    with revision_path.open("x") as stream:
        stream.write(json.dumps(pointer, sort_keys=True) + "\n")
    temporary = latest.with_suffix(".tmp")
    temporary.write_text(json.dumps(pointer, sort_keys=True) + "\n")
    os.replace(temporary, latest)
    engine._emit(manifest["campaign"], "scope_revised", scope_id=scope_id,
                 revision=revision, included=len(content["included"]),
                 unresolved=len(content["unresolved"]), artifact=artifact)
    return {**content, "artifact": artifact}
