"""The stupid loop: ask agents, run the tools they name, collect JSON.

Code never judges. It routes: orchestrator action -> tool calls or
parallel worker fan-out -> results back into the next prompt. Bounded
rounds; the orchestrator agent alone decides DONE and readiness.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from engine.stupid import prompts
from engine.stupid.tools import StupidTools
from model_config import get_model

STATE = Path("decomp-state")


def _load_aws_env() -> None:
    env_file = Path(".env")
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key.strip().startswith("AWS_") and value.strip():
            os.environ.setdefault(key.strip(), value.strip())


def call_model(prompt_text: str, *, role: str, max_tokens: int = 4096) -> str:
    import boto3

    _load_aws_env()
    model_id = get_model(role)
    bare = model_id.split("/", 1)[1] if "/" in model_id else model_id
    client = boto3.client("bedrock-runtime", region_name=os.environ.get(
        "AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-2")))
    reply = client.converse(
        modelId=bare,
        messages=[{"role": "user", "content": [{"text": prompt_text}]}],
        inferenceConfig={"maxTokens": max_tokens})
    return reply["output"]["message"]["content"][0]["text"]


def parse_json(text: str) -> dict:
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        value = json.loads(match.group(1))
    else:
        # First complete object wins; trailing chatter is ignored, not fatal.
        start = text.find("{")
        if start < 0:
            raise ValueError("model output contains no JSON object")
        value, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(value, dict):
        raise ValueError("model output is not a JSON object")
    return value


def _safe(fn):
    def wrapper(entry: str):
        try:
            return fn(entry)
        except Exception as error:  # one bad entry must not kill the run
            return entry, {"_error": str(error)}
    return wrapper


def run_stupid(binary: Path, goal: str, *, max_workers: int = 4,
               max_rounds: int = 8, warm_workers: int = 2,
               state_dir: Path = STATE,
               headless: Path = Path("/opt/ghidra/support/analyzeHeadless"),
               model_fn=call_model) -> dict:
    run_id = uuid.uuid4().hex[:12]
    run_dir = Path(state_dir) / "stupid" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    log: list[dict] = []

    def record(kind: str, payload: dict) -> dict:
        entry = {"kind": kind, **payload}
        log.append(entry)
        return entry

    tools = StupidTools(state_dir, headless, warm_workers=warm_workers)
    try:
        manifest = tools.analyze(Path(binary))
        summary = tools.inventory_summary(manifest)
        large = summary["function_count"] > 150
        inventory = None if large else tools.inventory(manifest)
        pages: list[dict] = []
        explored: dict[str, dict] = {}
        if large:
            # The export list is meaning-free inventory, not a judgment: every
            # exported address is a candidate the agent may accept or ignore.
            try:
                table = tools.export_entries(manifest)
            except RuntimeError as error:
                record("analyzed", {"campaign": manifest["campaign"], **summary,
                                    "paged": large,
                                    "export_error": str(error)[:200]})
            else:
                for e in table["entries"]:
                    explored.setdefault(e, {"entry": e, "exported": True})
                record("analyzed", {"campaign": manifest["campaign"], **summary,
                                    "paged": large,
                                    "exported": table["count"]})
        else:
            record("analyzed", {"campaign": manifest["campaign"], **summary,
                                "paged": large})
        drafts: dict[str, dict] = {}
        reviews: dict[str, dict] = {}
        probes: list[dict] = []

        def effective(entries: list[str], have: dict) -> list[str]:
            seen = []
            for e in entries or []:
                try:
                    key = tools.resolve_entry(manifest, e)
                except ValueError:
                    record("unknown_entry", {"entry": e})
                    continue
                if large and key not in explored:
                    record("unexplored_entry", {"entry": key})
                    continue
                if key not in have and key not in seen:
                    seen.append(key)
            return seen

        redraft_counts: dict[str, int] = {}
        total_redrafts = 0
        REDRAFT_RUN_BUDGET = 12

        def decompile(entries: list[str]) -> None:
            nonlocal noop_streak

            def one(entry: str) -> tuple[str, dict]:
                key = tools.resolve_entry(manifest, entry)
                pack = tools.read_function(manifest, key)
                prompt = prompts.DECOMP.format(
                    goal=goal, entry=entry,
                    evidence=json.dumps(pack["evidence"])[:60000])
                if key in drafts:
                    prior = drafts[key]
                    review = reviews.get(key, {})
                    prompt += ("\nA previous draft of this function was reviewed "
                               f"as: {review.get('verdict', 'unreviewed')}. "
                               "Reviewer reasons (untrusted, verify each against "
                               "the raw evidence): " +
                               json.dumps(review.get("reasons", []))[:4000] +
                               "\nPrior claims (untrusted, repair or replace with "
                               "better-evidenced claims): " +
                               json.dumps(prior.get("claims", []))[:6000])
                text = model_fn(prompt, role="decomp_worker")
                draft = parse_json(text)
                draft["entry"] = key
                draft["evidence_artifact"] = pack["artifact"]
                return key, draft

            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                for outcome in pool.map(_safe(one), entries):
                    name, payload = outcome
                    if isinstance(payload, dict) and "_error" not in payload:
                        fingerprint = hashlib.sha256(json.dumps(
                            {k: payload.get(k) for k in
                             ("claims", "dependencies", "unknowns", "pseudocode")},
                            sort_keys=True).encode()).hexdigest()
                        if name in drafts and drafts[name].get(
                                "_fingerprint") == fingerprint:
                            record("redundant_redraft", {"entry": name})
                            noop_streak += 1
                            continue
                        payload["_fingerprint"] = fingerprint
                        drafts[name] = payload
                        artifact = tools.store.put(json.dumps(
                            {k: val for k, val in payload.items()
                             if k != "_fingerprint"},
                            sort_keys=True).encode())
                        record("draft", {"entry": name,
                                         "artifact": artifact,
                                         "claims": len(payload.get("claims", [])),
                                         "unknowns": len(payload.get("unknowns", []))})
                    else:
                        record("draft_error", {"entry": name,
                                               "error": str(payload.get("_error", payload))[:500]})

        def review(entries: list[str]) -> None:
            nonlocal noop_streak

            def one(entry: str) -> tuple[str, dict]:
                key = tools.resolve_entry(manifest, entry)
                pack = tools.read_function(manifest, key)
                text = model_fn(prompts.REVIEW.format(
                    goal=goal, draft=json.dumps(drafts[entry])[:20000],
                    evidence=json.dumps(pack["evidence"])[:60000]),
                    role="decomp_worker")
                return key, parse_json(text)

            with ThreadPoolExecutor(max_workers=max_workers) as pool:
                for outcome in pool.map(_safe(one), entries):
                    name, payload = outcome
                    if isinstance(payload, dict) and "_error" not in payload:
                        reviews[name] = payload
                        artifact = tools.store.put(json.dumps(
                            payload, sort_keys=True).encode())
                        record("review", {"entry": name,
                                          "artifact": artifact,
                                          "verdict": payload.get("verdict")})
                    else:
                        record("review_error", {"entry": name,
                                                "error": str(payload.get("_error", payload))[:500]})

        def digest(mapping: dict, fields: tuple[str, ...]) -> dict:
            out = {}
            for entry_key, doc in mapping.items():
                short = {"entry": entry_key}
                for field in fields:
                    vals = doc.get(field, [])
                    short[field + "_count"] = len(vals) if isinstance(vals, list) else 0
                claims = doc.get("claims", [])
                if isinstance(claims, list):
                    short["claim_sample"] = [
                        str(c.get("statement", ""))[:200] for c in claims[:2]
                        if isinstance(c, dict)]
                unknowns = doc.get("unknowns", [])
                if isinstance(unknowns, list):
                    short["unknown_sample"] = [str(u)[:200] for u in unknowns[:2]]
                deps = doc.get("dependencies", [])
                if isinstance(deps, list):
                    short["dependency_targets"] = [
                        d.get("target") for d in deps[:5] if isinstance(d, dict)]
                if "verdict" in doc:
                    short["verdict"] = doc.get("verdict")
                    short["reasons"] = [str(x)[:200] for x in
                                        doc.get("reasons", [])[:2]]
                out[entry_key] = short
            return out

        search_log: list[dict] = []
        neighbor_queries: set[str] = set()
        seen_resolves: set[str] = set()
        seen_searches: set[str] = set()
        exports_listed = True
        explore_help = ('{{"action": "page", "offset": 0, "limit": 100, "reason": "..."}}\n'
                        '{{"action": "neighbors", "entry": "00101000", "reason": "..."}}'
                        if large else
                        '(page/neighbors unavailable: the inventory above is already complete. '
                        'Work directly from it.)')

        final: dict | None = None
        noop_streak = 0
        NOOP_STREAK_LIMIT = 5
        last_result: dict = {"note": "no actions taken yet"}
        last_signature: str | None = None
        for _ in range(max_rounds):
            state = {"inventory": inventory or {"paged": True,
                                                "pages_fetched": len(pages)},
                     "summary": summary,
                     "explored": explored,
                     "searches": search_log[-6:],
                     "last_result": last_result,
                     "paging": {"fetched_offsets": sorted(
                         {p["offset"] for p in pages}),
                         "total": summary["function_count"],
                         "next_offset": next(
                             (off for off in range(
                                 0, summary["function_count"], 100)
                              if off not in {p["offset"] for p in pages}),
                             None)} if large else None,
                     "drafted": sorted(drafts),
                     "needs_review": [e for e in sorted(drafts) if e not in reviews],
                     "draft_digest": digest(drafts, ("claims", "unknowns",
                                                     "dependencies")),
                     "reviewed": digest(reviews, ()),
                     "probes": probes}
            state_json = json.dumps(state)
            state_json = state_json[:60000]
            prompt_text = prompts.ORCHESTRATOR.format(
                goal=goal, state=state_json, explore=explore_help)
            if os.environ.get("STUPID_DUMP_PROMPTS"):
                dump = run_dir / "prompts"
                dump.mkdir(exist_ok=True)
                (dump / f"round{len([e for e in log if e['kind'] == 'orchestrator'])}.txt"
                 ).write_text(prompt_text)
            try:
                response = parse_json(model_fn(prompt_text,
                                               role="decomp_worker"))
            except (ValueError, json.JSONDecodeError) as error:
                # One malformed reply must not kill the run; say so in state.
                record("orchestrator_unparseable", {"error": str(error)[:200]})
                last_result = {"produced": ["unparseable"],
                               "warning": "reply was not a JSON object; "
                                          "send exactly one JSON object"}
                noop_streak += 1
                if noop_streak >= NOOP_STREAK_LIMIT:
                    final = {"action": "done", "scope": sorted(drafts),
                             "readiness": "partial",
                             "notes": "orchestrator repeated no-op actions; "
                                      "round budget exhausted"}
                    break
                continue
            plan = response.get("plan") or [response]
            if isinstance(plan, dict):
                plan = [plan]
            plan = [step for step in plan[:5] if isinstance(step, dict)]
            if not plan:
                record("orchestrator", response)
                record("invalid_action", {"response": response})
                noop_streak += 1
                last_result = {"produced": ["invalid_action"],
                               "warning": "emit a plan: a list of up to 5 "
                                          "action objects"}
                if noop_streak >= NOOP_STREAK_LIMIT:
                    final = {"action": "done", "scope": sorted(drafts),
                             "readiness": "partial",
                             "notes": "orchestrator repeated no-op actions; "
                                      "round budget exhausted"}
                    break
                continue
            record("orchestrator", {"plan": plan,
                                   "reason": response.get("reason", "")})
            mark = len(log)
            signature = json.dumps(plan, sort_keys=True)
            if signature == last_signature:
                # Fixation guard: repeating the identical plan teaches nothing.
                # The result is a no-op so the budget trips unless the agent varies.
                record("noop", {"plan": plan, "repeat": True})
                last_result = {"noop": True,
                               "reason": "identical to the previous plan; "
                                         "its results are already in the state above"}
                noop_streak += 1
                if noop_streak >= NOOP_STREAK_LIMIT:
                    final = {"action": "done", "scope": sorted(drafts),
                             "readiness": "partial",
                             "notes": "orchestrator repeated no-op actions; "
                                      "round budget exhausted"}
                    break
                continue
            last_signature = signature
            halt = False

            def step(action: dict) -> None:
                nonlocal noop_streak, halt, final, exports_listed, total_redrafts
                kind = action.get("action")
                if kind == "decompile":
                    work = effective(action.get("entries", []), {})
                    fresh = []
                    for e in work:
                        if e in drafts:
                            if (redraft_counts.get(e, 0) >= 4 or
                                    total_redrafts >= REDRAFT_RUN_BUDGET):
                                record("redraft_exhausted",
                                       {"entry": e,
                                        "note": "repair budget spent; widen instead"})
                                noop_streak += 1
                                continue
                            redraft_counts[e] = redraft_counts.get(e, 0) + 1
                            total_redrafts += 1
                            record("redraft", {"entry": e,
                                               "attempt": redraft_counts[e],
                                               "cleared_review": e in reviews})
                            reviews.pop(e, None)
                        fresh.append(e)
                    if fresh:
                        decompile(fresh)
                        noop_streak = 0
                    elif not work:
                        record("noop", {"action": action})
                        noop_streak += 1
                elif kind == "review":
                    work = [e for e in effective(action.get("entries", []), reviews)
                            if e in drafts]
                    if work:
                        review(work)
                        noop_streak = 0
                    else:
                        record("noop", {"action": action})
                        noop_streak += 1
                elif kind == "page":
                    if not large:
                        record("noop", {"action": action})
                        noop_streak += 1
                        return
                    limit = int(action.get("limit", 100))
                    want = int(action.get("offset", 0))
                    fetched = {(p["offset"], p.get("limit", 100)) for p in pages}
                    if (want, limit) in fetched:
                        # Agent asked for an already-seen slice: serve intent
                        # ("keep paging") mechanically with the next unfetched one.
                        want = next((off for off in range(0, summary["function_count"], limit)
                                     if (off, limit) not in fetched), None)
                        if want is None:
                            record("noop", {"action": action})
                            noop_streak += 1
                            return
                        advanced = True
                    else:
                        advanced = False
                    page = tools.inventory_page(manifest, want, limit)
                    pages.append({"offset": page["offset"], "limit": page["limit"],
                                  "entries": [f["entry"] for f in page["functions"]]})
                    for f in page["functions"]:
                        explored.setdefault(f["entry"], f)
                    record("page", {"offset": page["offset"],
                                    "returned": len(page["functions"]),
                                    "total": page["total"],
                                    "advanced": advanced})
                    noop_streak = 0
                elif kind == "neighbors":
                    try:
                        resolved = tools.resolve_entry(manifest, action.get("entry", ""))
                    except ValueError:
                        record("unknown_entry", {"entry": action.get("entry", "")})
                        noop_streak += 1
                        return
                    if not large or resolved in neighbor_queries:
                        record("noop", {"action": action})
                        noop_streak += 1
                        return
                    try:
                        links = tools.neighbors(manifest, action.get("entry", ""))
                    except ValueError as error:
                        record("unknown_entry", {"entry": action.get("entry", "")})
                        links = None
                    if links is None:
                        noop_streak += 1
                    else:
                        neighbor_queries.add(action.get("entry", ""))
                        neighbor_queries.add(links["entry"])
                        explored[links["entry"]] = {"entry": links["entry"]}
                        for other in links["callers"] + links["callees"]:
                            explored.setdefault(other, {"entry": other})
                        record("neighbors", links)
                        noop_streak = 0
                elif kind == "export_entries":
                    if exports_listed:
                        record("noop", {"action": action, "repeat": True})
                        noop_streak += 1
                        return
                    exports_listed = True
                    try:
                        table = tools.export_entries(manifest)
                    except RuntimeError as error:
                        record("export_error", {"error": str(error)[:200]})
                        noop_streak += 1
                        return
                    for e in table["entries"]:
                        explored.setdefault(e, {"entry": e, "exported": True})
                    record("export_entries", {"count": table["count"]})
                    noop_streak = 0
                elif kind == "resolve_symbol":
                    if str(action.get("substring", "")) in seen_resolves:
                        record("noop", {"action": action, "repeat": True})
                        noop_streak += 1
                        return
                    seen_resolves.add(str(action.get("substring", "")))
                    try:
                        hit = tools.resolve_symbol(
                            manifest, str(action.get("substring", "")))
                    except RuntimeError as error:
                        record("export_error", {"error": str(error)[:200]})
                        noop_streak += 1
                        return
                    for e in hit["entries"]:
                        explored.setdefault(e, {"entry": e})
                    record("resolve_symbol", {"substring": hit["substring"],
                                              "entries": hit["entries"]})
                    noop_streak = 0
                elif kind == "search_strings":
                    if str(action.get("substring", "")) in seen_searches:
                        record("noop", {"action": action, "repeat": True})
                        noop_streak += 1
                        return
                    seen_searches.add(str(action.get("substring", "")))
                    hits = tools.search_strings(
                        manifest, str(action.get("substring", "")),
                        int(action.get("limit", 50)))
                    record("search_strings", {"substring": hits["substring"],
                                              "matches": hits["matches"]})
                    for item in hits["items"]:
                        for func in item.get("referenced_by", []):
                            explored.setdefault(func, {"entry": func})
                    search_log.append({"substring": hits["substring"],
                                       "matches": hits["matches"],
                                       "items": hits["items"][:10]})
                    noop_streak = 0
                elif kind == "probe":
                    probes.append({"asked": action.get("cases", []),
                                   "note": "probe execution is harness-driven; "
                                           "see scripts/native_probe_adapter.py"})
                    record("probe", {"asked": len(action.get("cases", []))})
                    noop_streak = 0
                elif kind == "done":
                    final = action
                    noop_streak = 0
                    halt = True
                    return
                else:
                    record("invalid_action", {"action": action})
                    noop_streak += 1

            for sub in plan:
                step(sub)
                if halt:
                    break

            produced = [e["kind"] for e in log[mark:]
                        if e["kind"] != "orchestrator"]
            last_result = {"produced": produced or ["nothing"]}
            if produced == ["noop"] or not produced:
                last_result["warning"] = ("that action changed nothing; "
                                          "varying the action is the only way forward")
            if noop_streak:
                # Facts the agent can act on, not advice from the harness.
                undrafted = [e for e in sorted(explored) if e not in drafts]
                last_result["noop_streak"] = noop_streak
                last_result["undrafted_count"] = len(undrafted)
                last_result["undrafted_sample"] = undrafted[:40]
                last_result["needs_review"] = [e for e in sorted(drafts)
                                               if e not in reviews][:40]
            if noop_streak >= NOOP_STREAK_LIMIT:
                final = {"action": "done", "scope": sorted(drafts),
                         "readiness": "partial",
                         "notes": "orchestrator repeated no-op actions; "
                                  "round budget exhausted"}
                break
        if final is None:
            final = {"action": "done", "scope": sorted(drafts),
                     "readiness": "partial",
                     "notes": "round budget exhausted"}
        facts = [{**drafts[e], "review_verdict": reviews.get(e, {}).get(
            "verdict", "unreviewed")} for e in final.get("scope", [])
            if e in drafts]
        spec_text = model_fn(prompts.SPEC.format(
            goal=goal, facts=json.dumps(facts)[:60000]), role="spec_writer")
        try:
            spec = parse_json(spec_text)
            markdown = spec.get("spec_markdown", "")
        except (ValueError, json.JSONDecodeError) as error:
            record("spec_error", {"error": str(error)[:200]})
            markdown = ""
        forbidden = re.findall(r"\bFUN_[0-9A-Za-z_:]+\b|"
                                 r"\bparam_\d+\b|\buVar\d+\b|\b_DAT_[0-9A-Fa-f]+\b",
                                 markdown)
        record("spec", {"chars": len(markdown),
                        "forbidden_refs": forbidden[:10]})
        result = {"run_id": run_id, "campaign": manifest["campaign"],
                  "readiness": final.get("readiness"), "scope": final.get("scope"),
                  "drafts": len(drafts), "reviews": len(reviews),
                  "verdicts": {verdict: sum(
                      1 for rev in reviews.values()
                      if rev.get("verdict") == verdict)
                      for verdict in ("supported", "uncertain",
                                      "contradicted")},
                  "spec_chars": len(markdown),
                  "spec_leaks_addresses": bool(forbidden),
                  "log": log}
        (run_dir / "result.json").write_text(json.dumps(result, indent=2))
        (run_dir / "spec.md").write_text(markdown)
        return result
    finally:
        tools.close()
