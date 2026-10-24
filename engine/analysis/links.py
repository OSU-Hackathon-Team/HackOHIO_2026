"""Find static cross-module symbol candidates without claiming runtime binding."""

from __future__ import annotations


def link_modules(modules: list[dict], indexes: dict[str, dict],
                 dependencies: list[dict]) -> dict:
    by_id = {module["id"]: module for module in modules}
    providers: dict[str, list[str]] = {}
    for edge in dependencies:
        providers.setdefault(edge["from"], []).append(edge["to"])
    candidates = []
    ambiguous = []
    unmatched = []
    for module in sorted(modules, key=lambda item: item["id"]):
        module_id = module["id"]
        index = indexes[module_id]
        functions = index["functions"]
        calls = index.get("calls", [])
        for imported in sorted(index.get("imports", []),
                               key=lambda item: (item["name"], item["address"])):
            symbol = imported["name"].removeprefix("<EXTERNAL>::")
            address = imported["address"]
            thunks = sorted({item["entry"] for item in functions
                             if item.get("thunk") and item.get("thunk_target") == address})
            gateways = set(thunks) | {address}
            sites = sorted(({"caller": call["caller"], "site": call["site"],
                             "target": call["target"]}
                            for call in calls if call["target"] in gateways),
                           key=lambda item: (item["caller"], item["site"], item["target"]))
            base = {"from_module": module_id, "symbol": symbol,
                    "import_name": imported["name"], "import_address": address,
                    "source_index_artifact": module["index_artifact"],
                    "thunks": thunks, "call_sites": sites}
            if not thunks and not sites:
                unmatched.append({**base, "reason": "no_function_call_evidence"})
                continue
            matches = []
            for provider_id in sorted(set(providers.get(module_id, []))):
                target = indexes[provider_id]
                for function in target["functions"]:
                    if (function["name"] == symbol and not function["external"] and
                            not function["thunk"]):
                        matches.append({"to_module": provider_id,
                                        "target_entry": function["entry"],
                                        "target_index_artifact": by_id[provider_id]["index_artifact"]})
            if len(matches) == 1:
                candidates.append({**base, **matches[0],
                                   "binding": "candidate_static",
                                   "limitation": "runtime symbol binding and interposition unverified"})
            elif matches:
                ambiguous.append({**base, "reason": "multiple_supplied_targets",
                                  "candidates": sorted(matches, key=lambda item: (
                                      item["to_module"], item["target_entry"]))})
            else:
                unmatched.append({**base, "reason": "no_supplied_target"})
    return {"schema": 1, "candidates": candidates,
            "ambiguous": ambiguous, "unmatched": unmatched}
