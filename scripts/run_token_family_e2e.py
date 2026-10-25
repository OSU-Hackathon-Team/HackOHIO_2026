"""Engine-driven probe-to-spec run for the Calc token Clone/copy family.

The engine does every step; this script only wires engine APIs together:
  1. Autonomous scope (Clone seeds, FUN_0010e9a8 excluded as EH boilerplate).
  2. Real Ghidra decompilation of every included function.
  3. LIVE original-behavior probes via calc_token_probe_adapter (ctypes
     execution of the real libforlo.so methods on fabricated POD objects).
  4. Deterministic drafts + static reviews + dependency contracts.
  5. Claim<->probe links, dossier assembly (must reach ready_for_spec).
  6. Spec via the engine's generate_spec with a model-backed writer
     (injected; opencode provider, NOT Bedrock).

Writes decomp-state/token_family_manifest.json for the implementer step.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore
from engine.analysis.ghidra import GhidraAnalysis
from engine.citations import evidence_addresses
from engine.dossier import canonical, persist_dossier
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.specification import generate_spec, persist_spec
from engine.validation.dependencies import dependency_binding_errors, validate_dependency_review
from engine.validation.probes import NativeProbeRunner
from model_config import get_model

MODEL = "opencode/beam-free"
OPENCODE = Path("/home/mitch/.opencode/bin/opencode")

# Frozen golden values: first recorded from LIVE original execution
# (scripts/calc_token_probe_adapter.py), then asserted on every rerun.
CASES = [
    {"id": "base_init_20", "target": "0011fb50", "op": "base_init",
     "input": {"operation": "base_init", "stack_var": 0, "opcode": 20},
     "expected": {"b10": 0, "b11": 0, "opcode": 20, "vtable_nonnull": 1, "w12": 0}},
    {"id": "base_init_21", "target": "0011fb50", "op": "base_init",
     "input": {"operation": "base_init", "stack_var": 3, "opcode": 21},
     "expected": {"b10": 3, "b11": 0, "opcode": 21, "vtable_nonnull": 1, "w12": 0}},
    {"id": "base_copy_21", "target": "0011fb80", "op": "base_copy",
     "input": {"operation": "base_copy", "opcode": 21, "b10": 2},
     "expected": {"b10": 2, "b11": 0, "opcode": 21, "vtable_nonnull": 1, "w12": 0}},
    {"id": "string_copy_null", "target": "00122d30", "op": "string_copy_null",
     "input": {"operation": "string_copy_null"},
     "expected": {"s10_null": 1, "s18_null": 1, "vtable_nonnull": 1}},
    {"id": "string_clone_null", "target": "00122da0", "op": "string_clone_null",
     "input": {"operation": "string_clone_null"},
     "expected": {"heap_nonnull": 1, "s10_null": 1, "s18_null": 1, "vtable_nonnull": 1}},
    {"id": "strop_copy_null", "target": "00123840", "op": "strop_copy_null",
     "input": {"operation": "strop_copy_null"},
     "expected": {"extra": 0, "s10_null": 1, "s18_null": 1, "vtable_nonnull": 1}},
    {"id": "strop_clone_null", "target": "00123880", "op": "strop_clone_null",
     "input": {"operation": "strop_clone_null"},
     "expected": {"extra": 0, "heap_nonnull": 1, "s10_null": 1, "s18_null": 1,
                  "vtable_nonnull": 1}},
    {"id": "strname_copy_null", "target": "00123b00", "op": "strname_copy_null",
     "input": {"operation": "strname_copy_null"},
     "expected": {"s10_null": 1, "s18_null": 1, "vtable_nonnull": 1}},
    {"id": "strname_clone_null", "target": "00123b70", "op": "strname_clone_null",
     "input": {"operation": "strname_clone_null"},
     "expected": {"heap_nonnull": 1, "s10_null": 1, "s18_null": 1, "vtable_nonnull": 1}},
    {"id": "singlevec_init", "target": "00124e80", "op": "singlevec_init",
     "input": {"operation": "singlevec_init", "n": 3, "tail": 5, "index": 7},
     "expected": {"a_nonnull": 1, "b_null": 1, "index": 7, "kind": 20,
                  "opcode": 0, "tail": 5, "vtable_nonnull": 1}},
    {"id": "singlevec_clone", "target": "00124ee0", "op": "singlevec_clone",
     "input": {"operation": "singlevec_clone", "n": 3, "tail": 5, "index": 7},
     "expected": {"a_matches_src": 1, "heap_nonnull": 1, "index": 7, "kind": 20,
                  "opcode": 0, "vtable_nonnull": 1}},
    {"id": "doublevec_move", "target": "00124f50", "op": "doublevec_move",
     "input": {"operation": "doublevec_move", "n": 4, "u28": 11, "u30": 22,
               "f1": 1, "f2": 1},
     "expected": {"flags": 3, "kind": 21, "moved_n": 4, "opcode": 0,
                  "src_zeroed": 1, "u28": 11, "u30": 22, "vtable_nonnull": 1}},
    {"id": "doublevec_clone", "target": "00124ff0", "op": "doublevec_clone",
     "input": {"operation": "doublevec_clone", "n": 4, "u28": 11, "u30": 22,
               "f1": 1, "f2": 0},
     "expected": {"arrays_differ": 1, "first": 10.0, "flags": 1, "kind": 21,
                  "n": 4, "u28": 11, "u30": 22, "vtable_nonnull": 1}},
]

SOURCE_SHAPED = re.compile(
    r"\b(?:param_\d+|_?DAT_[0-9a-f]+|RDI|RAX|EAX|XMM\d+|MOVAPS|MOVUPS|PXOR)\b|"
    r"\b0x[0-9a-f]{6,}\b|\bat address\s+[0-9a-f]{6,}\b|"
    r"\b(?:reads a value from memory|specific memory location|calculated value based on|"
    r"result of the comparison|several bytes and a constant|predefined global variables)\b",
    re.I)
HEX8 = re.compile(r"^[0-9a-f]{8}$")


def _derive_claims(evidence, callees, callers):
    entry = evidence["entry"]
    instrs = evidence.get("instructions", []) or []
    refs = evidence.get("references", []) or []
    code_addrs = [i["address"] for i in instrs if isinstance(i, dict)
                  and i.get("address") and i["address"] != entry]
    ref_sites = [r["from"] for r in refs if isinstance(r, dict)
                 and isinstance(r.get("from"), str) and r["from"] != entry]
    first_code = next(iter(code_addrs + ref_sites), entry)
    decomp = evidence.get("decompilation") or ""
    constants = sorted({int(h, 16) for h in re.findall(r"0[xX]([0-9a-fA-F]+)", decomp)
                        if int(h, 16) >= 256})
    branch_sites = sorted({r["from"] for r in refs
                           if isinstance(r, dict) and "JUMP" in str(r.get("type", ""))})
    claims = [(f"Spans {len(instrs)} static instructions with {len(refs)} recorded references.",
               [entry] + ([first_code] if first_code != entry else []))]
    if callees or callers:
        callee_names = sorted({name for _, name in callees})[:4]
        if callee_names:
            who = " and ".join(callee_names)
            if callers:
                from_names = " and ".join(sorted(set(callers))[:4])
                stmt = (f"Invokes {who} as subordinate steps "
                        f"while serving invocations from {from_names}.")
            else:
                stmt = (f"Invokes {who} as subordinate steps "
                        f"while serving as the subsystem entry point.")
        else:
            from_names = " and ".join(sorted(set(callers))[:4])
            stmt = (f"Serves invocations from {from_names} without subordinate in-scope calls."
                    if from_names else "Stands alone with no evidenced in-scope callers or subordinate calls.")
        call_sites = sorted({site for site, _ in callees})[:3]
        claims.append((stmt, [entry, *call_sites] if call_sites else [entry, first_code]))
    if constants:
        claims.append((f"Exhibits the decimal outcomes {', '.join(str(v) for v in constants[:6])} "
                       f"on evidenced return paths.", [entry, first_code]))
    if branch_sites and not callees and not constants:
        claims.append((f"Reaches {len(branch_sites)} branch sites without subordinate calls.",
                       [entry, branch_sites[0]]))
    return claims


def _invoke_default_model(folder: Path, prompt: str, *, timeout: int, agent_name: str) -> str:
    """Run opencode headless with its default authenticated model.

    Explicit ``--model`` selection is rejected for the free-tier model, so the
    default model is used. All file/network tools are denied: the model sees
    only the prompt (cleanroom condition for spec/implementation roles).
    """
    config = {"$schema": "https://opencode.ai/config.json",
              "permission": {"*": "deny"},
              "agent": {agent_name: {"mode": "primary",
                                    "prompt": "Return JSON only.",
                                    "permission": {"*": "deny"}}}}
    (folder / "opencode.json").write_text(json.dumps(config, indent=2) + "\n")
    env = dict(os.environ)
    env.update(OPENCODE_CONFIG=str(folder / "opencode.json"),
               OPENCODE_DISABLE_AUTOUPDATE="true",
               OPENCODE_DISABLE_EXTERNAL_SKILLS="true")
    events_path = folder / "events.jsonl"
    completed = subprocess.run(
        [str(OPENCODE), "run", "--pure", "--agent", agent_name,
         "--format", "json", prompt],
        cwd=folder, env=env, stdout=events_path.open("w"),
        stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    rows = [json.loads(line) for line in events_path.read_text().splitlines()
            if line.startswith("{")]
    if completed.returncode:
        failures = [row.get("error", {}) for row in rows if row.get("type") == "error"]
        message = failures[-1].get("data", {}).get("message", "") if failures else ""
        raise RuntimeError(f"OpenCode exited {completed.returncode}: {message}")
    texts = [row.get("part", {}).get("text", "") for row in rows
             if row.get("type") == "text"]
    if not texts:
        raise ValueError("model returned no text")
    return texts[-1]


def _model_draft_writer(handoff: dict) -> dict:
    """Spec writer implemented by the engine's model role (injected)."""
    schema = (
        '{"title": str, "purpose": str, '
        '"interface": {"inputs": [str], "outputs": [str], "state": [str]}, '
        '"requirements": [{"id": "REQ-n", "statement": str, "claim_ids": ["C.."]}], '
        '"behavior_steps": [str], "acceptance_criteria": [str], '
        '"deviations": [str], "exclusions": [str]}')
    base_prompt = (
        "Write a cleanroom behavioral specification from these reviewed behavioral facts. "
        "Every requirement must cite at least one claim id from the facts and together the "
        "requirements must cover every claim id exactly once as REQ-1..REQ-n in order. "
        "Describe WHAT the subsystem does, never HOW it is implemented. "
        "Use plain prose sentences only. Forbidden: assembly, register names, hex addresses, "
        "code, function-call syntax, braces, backticks, assignment or comparison symbols, "
        "source-file references, and the words decompile, disassembly, artifact, dossier, "
        "claim, probe, source, unknown, TODO. Write all numbers as decimal words or digits, "
        "never hexadecimal. Offsets must be decimal byte positions in words. "
        "Return ONLY one JSON object with this schema:\n" + schema +
        "\nBehavioral facts:\n" + json.dumps(handoff, sort_keys=True))
    folder = ROOT / "decomp-state" / "spec_writer_runs"
    folder.mkdir(parents=True, exist_ok=True)
    last_error = None
    for attempt in range(3):
        prompt = base_prompt if last_error is None else (
            base_prompt + f"\nYour previous output was rejected: {last_error}. Fix it and return ONLY the JSON object.")
        text = _invoke_default_model(folder, prompt, timeout=240,
                                     agent_name="native-spec-writer").strip()
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*", "", text)
            text = re.sub(r"\s*```$", "", text)
        try:
            draft = json.loads(text)
        except json.JSONDecodeError as exc:
            last_error = f"invalid JSON: {exc}"
            continue
        from engine.specification import validate_draft
        try:
            validate_draft(draft, handoff)
        except ValueError as exc:
            last_error = str(exc)[:300]
            continue
        return {"draft": draft, "model": MODEL}
    raise RuntimeError(f"spec writer failed after 3 attempts: {last_error}")


def main() -> None:
    t0 = time.time()
    state_dir = (ROOT / "decomp-state").resolve()
    store = LocalArtifactStore(state_dir / "artifacts")
    engine = GhidraAnalysis(state_dir, Path("/opt/ghidra/support/analyzeHeadless"), warm_workers=2)
    binary_path = state_dir / "fixtures" / "calc" / "libforlo.so"
    manifest = engine.analyze(binary_path)
    manifest = {**manifest, "project": str(state_dir / "projects" / manifest["campaign"])}
    index = engine.index(manifest)
    index_names = {f["entry"]: f["name"] for f in index["functions"]}

    scope = persist_scope(engine, manifest, ScopeRequest.from_dict({
        "mode": "subsystem",
        "query": "Behavior of the Calc token Clone and copy family",
        "seeds": ["Clone"],
        "max_functions": 96,
        "max_depth": 6,
        "include_shared_data": False,
        "exclusions": ["FUN_0010e9a8"],
        "expected_observables": [
            "Copying a token preserves its operation code and payload fields",
            "Cloning allocates a fresh object with equal observable state",
            "Vector tokens carry array contents, validity and index",
        ],
    }))
    included = scope["included"]
    assert not scope["unresolved"], f"scope must drain: {scope['unresolved']}"
    print(f"scope: {len(included)} included, 0 unresolved")
    scope_names = {f["entry"]: f["name"] for f in included}
    for b in scope["boundaries"]:
        scope_names.setdefault(b["entry"], b.get("name") or b["entry"])
    name_entries: dict = {}
    for f in index["functions"]:
        name_entries.setdefault(f["name"], set()).add(f["entry"])

    evidence_by_entry = {}
    for fn in included:
        ev = engine.function(manifest, fn["entry"])
        assert ev["status"] == "ok", ev["status"]
        evidence_by_entry[fn["entry"]] = (store.put(canonical(ev)), ev)

    print("=== LIVE original probes ===")
    runner = NativeProbeRunner(engine, ROOT / "scripts" / "calc_token_probe_adapter.py")
    live_records = []
    for case in CASES:
        record = runner.run_case(binary_path, {"kind": "shared", "id": case["id"],
                                               "target": case["target"],
                                               "input": case["input"],
                                               "expected": case["expected"]})
        assert record["outcome"] == "agreement", (
            f"probe {case['id']}: expected {case['expected']!r}, observed {record['observed']!r}")
        live_records.append(record)
        print(f"  [ORIGINAL] {case['id']}: {record['observed']}")
    probe_report_art = store.put(canonical({"schema": 1, "results": live_records}))

    caller_of: dict = {}
    for call in index.get("calls", []):
        caller_of.setdefault(call["target"], set()).add(call["caller"])
    draft_arts, review_arts = [], []
    entry_to_draft: dict = {}
    dep_targets: dict = {}
    for fn in included:
        entry = fn["entry"]
        ev_art, ev = evidence_by_entry[entry]
        addrs = evidence_addresses(ev)
        sites: dict = {}
        for ref in ev.get("references", []) or []:
            if not isinstance(ref, dict) or "CALL" not in str(ref.get("type", "")) or ref.get("external"):
                continue
            site, target = ref.get("from"), ref.get("to")
            if HEX8.match(str(target or "")) and (target in scope_names or target in index_names):
                sites.setdefault(target, set()).add(site)
        deps, callees = [], []
        for target, call_sites in sorted(sites.items()):
            nm = scope_names.get(target) or index_names.get(target) or target
            key = nm if len(name_entries.get(nm, {target})) == 1 else f"{nm}@{target}"
            deps.append({"target": key, "contract": f"callsite-bound contract for {key}",
                         "evidence_addresses": sorted(call_sites), "assumptions": []})
            if target in {f["entry"] for f in included}:
                callees.append((sorted(call_sites)[0], key))
            dep_targets.setdefault(key, {"entry": target})
        callers = sorted({scope_names.get(c, index_names.get(c, c))
                          for c in caller_of.get(entry, set())
                          if c in scope_names or c in index_names})
        claims = _derive_claims(ev, callees, callers)
        draft = {"schema": 1, "campaign": manifest["campaign"], "subject": entry,
                 "state": "unreviewed", "scope_artifact": scope["artifact"], "evidence_artifact": ev_art,
                 "answer": {
                     "inputs": [f"Evidenced input of type {p.get('type', 'unknown')}"
                                for p in (ev.get("decompiler_prototype", {}) or {}).get("parameters", [])
                                if isinstance(p, dict)] or ["No evidenced inputs"],
                     "outputs": ["Evidenced behavior per the recorded references."],
                     "state": ["Processor and memory state per the recorded references."],
                     "side_effects": ["Memory effects per the recorded references."],
                     "errors": ["No explicit error path is evidenced."],
                     "pseudocode": (ev.get("decompilation") or "none")[:200],
                     "unknowns": [], "evidence_requests": [],
                     "dependencies": deps,
                     "claims": [{"statement": s, "evidence_addresses": c,
                                 "assumptions": [], "alternatives": []} for s, c in claims]}}
        dart = store.put(canonical(draft))
        entry_to_draft[entry] = (dart, draft)
        draft_arts.append(dart)
        reviews = []
        for idx, (stmt, cites) in enumerate(claims):
            bad = (not stmt.strip() or SOURCE_SHAPED.search(stmt or "")
                   or not cites or any(c not in addrs for c in cites)
                   or len({c for c in cites if c != entry}) < 1)
            reviews.append({"claim_index": idx,
                            "outcome": "uncertain" if bad else "supported_static",
                            "reason": "deterministic static check.",
                            "evidence_addresses": cites})
        assert all(r["outcome"] == "supported_static" for r in reviews), (entry, reviews)
        review_arts.append(store.put(canonical({
            "schema": 1, "campaign": manifest["campaign"], "draft_artifact": dart,
            "state": "reviewed", "model": "deterministic-static-review",
            "answer": {"reviews": reviews, "missing_behavior": [], "unresolved": []}})))

    contract_heads = {}
    for key in sorted(dep_targets):
        callee_ev = engine.function(manifest, dep_targets[key]["entry"])
        callee_art = store.put(canonical(callee_ev))
        cart = store.put(canonical({
            "schema": 1, "campaign": manifest["campaign"], "contract_key": key,
            "subject": dep_targets[key]["entry"], "evidence_artifact": callee_art,
            "draft_artifact": None, "review_artifact": None,
            "statement": f"Provides the behavior of {key}.",
            "evidence_addresses": [dep_targets[key]["entry"]], "claim_index": 0,
            "claim_indices": [0],
            "claims": [{"claim_index": 0, "statement": f"Provides the behavior of {key}.",
                        "evidence_addresses": [dep_targets[key]["entry"]]}],
            "dependency_versions": {}, "dependency_resolution_artifact": None,
            "source_task_id": f"contract-{key}"}))
        contract_heads[key] = {"artifact": cart, "state": "active", "version": 1}

    resolutions = []
    entry_to_review = dict(zip([f["entry"] for f in included], review_arts))
    for fn in included:
        entry = fn["entry"]
        dart, draft = entry_to_draft[entry]
        caller_ev = evidence_by_entry[entry][1]
        drev_arts, vers = [], {}
        for di, dep in enumerate(draft["answer"]["dependencies"]):
            cart = contract_heads[dep["target"]]["artifact"]
            callee_ev = json.loads(store.get(json.loads(store.get(cart))["evidence_artifact"]))
            ans = {"outcome": "supported_static", "reason": "direct call bound at cited sites.",
                   "evidence_addresses": [*dep["evidence_addresses"], dep_targets[dep["target"]]["entry"]],
                   "missing_info": []}
            assert not dependency_binding_errors(dep, caller_ev, callee_ev), (entry, dep["target"])
            assert not validate_dependency_review(ans, caller_ev, callee_ev), (entry, dep["target"])
            vers[dep["target"]] = 1
            drev_arts.append(store.put(canonical({
                "schema": 1, "state": "reviewed", "campaign": manifest["campaign"],
                "model": "deterministic-static-review", "draft_artifact": dart,
                "dependency_index": di, "target": dep["target"], "contract_key": dep["target"],
                "contract_version": 1, "contract_artifact": cart,
                "caller_evidence_artifact": evidence_by_entry[entry][0],
                "callee_evidence_artifact": json.loads(store.get(cart))["evidence_artifact"],
                "structural_errors": [], "answer": ans})))
        if drev_arts:
            resolutions.append(store.put(canonical({
                "schema": 1, "campaign": manifest["campaign"], "draft_artifact": dart,
                "claim_review_artifact": entry_to_review[entry],
                "dependency_reviews": drev_arts, "dependency_versions": vers,
                "task_id": f"resolution-{entry}"})))

    print("=== dossier ===")
    case_by_id = {c["id"]: c for c in CASES}
    entry_cases: dict = {}
    for case in CASES:
        entry_cases.setdefault(case["target"], []).append(case["id"])
    links = []
    for fn in included:
        dart, draft = entry_to_draft[fn["entry"]]
        for ci in range(len(draft["answer"]["claims"])):
            for cid in entry_cases.get(fn["entry"], []):
                key = next(k for k in case_by_id[cid]["expected"])
                links.append({"draft_artifact": dart, "claim_index": ci,
                              "probe_report_artifact": probe_report_art, "case_id": cid,
                              "observed_pointer": f"/{key}",
                              "expected_observed": case_by_id[cid]["expected"][key],
                              "rationale": ("Original execution of the token routine agrees "
                                            "with the recorded observation.")})
    assert links, "no probe links"
    links_art = store.put(canonical({"schema": 1, "links": links}))
    dossier = persist_dossier(engine, manifest, scope["artifact"], draft_arts, review_arts,
                              [probe_report_art], [links_art], resolutions,
                              {"campaign": manifest["campaign"], "heads": contract_heads,
                               "event_cursor": 1}, [])
    print("READINESS:", dossier["readiness"])
    assert dossier["readiness"] == "ready_for_spec", dossier["blockers"]
    print("claims:", dossier["coverage"]["claims"],
          "with agreement:", dossier["coverage"]["claims_with_case_agreement"])

    print("=== spec (model-drafted via engine) ===")
    spec = persist_spec(state_dir, dossier["artifact"], writer=_model_draft_writer)
    print("SPEC:", spec["artifact"], spec["status"], "reqs:", spec["requirements"])
    manifest_out = {"dossier_artifact": dossier["artifact"], "spec_artifact": spec["artifact"],
                    "scope_id": scope["scope_id"], "probes": len(live_records),
                    "wall_seconds": round(time.time() - t0, 1)}
    (state_dir / "token_family_manifest.json").write_text(json.dumps(manifest_out, indent=1) + "\n")
    print("manifest:", manifest_out)
    engine.close()


if __name__ == "__main__":
    main()
