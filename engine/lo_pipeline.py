"""LibreOffice Calc: triage -> scoped decompile -> evidence claims -> real probes -> dossier -> spec.

Each stage reuses the engine's existing, validated path:
  scope      engine.scope.persist_scope          (seeds come from runtime hits, not a hand list)
  claims     engine.worker.SemanticWorker        (OpenCode, evidence-only, cites addresses)
  review     engine.validation.review.IndependentReviewer
  probes     engine.libreoffice.probe_report     (observed = the running LibreOffice)
  links      engine.validation.case_links         (blind claim predictions vs those observations)
  readiness  engine.dossier.persist_dossier      (never set here)
  spec       engine.specification.persist_spec   (only when the dossier says ready_for_spec)
Dependencies are injected so the whole flow is unit-testable without Ghidra, REA or Bedrock.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import fnmatch
import json
import re
import subprocess
from pathlib import Path
import time
from typing import Callable

from engine.analysis.rea import RuntimeTracer, ReaSession, static_triage
from engine.analysis.scoped import symbol_inventory, prepared_readers
from engine.libreoffice import (UnoDriver, matches, observe_cases, probe_report, resolve_targets,
                                split_cases)
from engine.models import ScopeRequest

DEFAULT_FRIDA_PATTERNS = ["*ScInterpreter*", "*ScCompiler*", "*FormulaCompiler*"]
OBSERVATION_FORMAT = ("a JSON object with value (a number) for numeric results, text (a string) for "
                      "text results, or both error (the numeric LibreOffice error code) and text "
                      "(its display string such as #DIV/0!) for errors.")


@dataclass
class LoPipelineConfig:
    cases: list[dict]
    query: str
    expected_observables: list[str]
    library: str = "calc"
    module: str = "libsclo.so"
    frida_patterns: list[str] = field(default_factory=lambda: list(DEFAULT_FRIDA_PATTERNS))
    seed_source: str = "runtime"            # "runtime" (Frida via REA) or "rea_static"
    static_patterns: list[str] = field(default_factory=list)
    max_seeds: int = 12
    max_functions: int = 60
    max_depth: int = 2
    workers: int = 4
    investigate: bool = False
    review_model_role: str = "legal_verification"   # models.json role for the independent review
    link_model_role: str = "decomp_worker"           # models.json role for blind claim-to-case links
    # Explicit until application-wide discovery can supply candidate scopes without known features.
    scoped_analysis: bool = False


@dataclass
class LoPipelineDeps:
    engine: object
    rea_factory: Callable[..., ReaSession]
    driver_factory: Callable[[], UnoDriver]
    worker: object
    reviewer: object
    persist_scope: Callable
    persist_dossier: Callable
    persist_spec: Callable
    investigator: object | None = None
    linker: object | None = None          # engine.validation.case_links.CaseLinker; None skips links
    tracer_cls: type = RuntimeTracer
    log: Callable[[str], None] = print


def hook_offsets(inventory: dict, patterns: list[str], *, limit: int = 1500) -> dict[str, str]:
    """Module-relative offsets of sized functions matching the Frida globs, earlier patterns first.

    Built from our ELF + build-id debug-file inventory because Frida only sees exports there.
    Compiler-split fragments (.cold / [clone]) are not function entries and are skipped.
    """
    base = int(inventory['elf_image_base'], 16)
    offsets: dict[str, str] = {}
    for pattern in patterns:
        for symbol in inventory['symbols']:
            display = symbol.get('display_name', symbol['name'])
            if '.cold' in symbol['name'] or '[clone' in display:
                continue
            if fnmatch.fnmatchcase(symbol['name'], pattern) or fnmatch.fnmatchcase(display, pattern):
                offsets.setdefault(hex(int(symbol['address'], 16) - base), symbol['name'])
                if len(offsets) >= limit:
                    return offsets
    return offsets


def runtime_triage(session: ReaSession, driver: UnoDriver, cases: list[dict], *, module: str,
                   patterns: list[str], image_base: int, tracer_cls: type = RuntimeTracer,
                   offsets: dict[str, str] | None = None) -> dict:
    """Per case: which functions of `module` ran while LibreOffice evaluated its formula."""
    tracer = tracer_cls(session, pid=driver.pid, module=module, patterns=patterns,
                        image_base=image_base, **({'offsets': offsets} if offsets else {}))
    started = tracer.start()
    observed = {}
    try:
        # LibreOffice initialises lazily on the first formula (op-code maps, add-ins); without a
        # discarded warm-up that one-time code looks specific to whichever case runs first.
        if cases:
            tracer.observe("__warmup__", lambda: driver.evaluate(cases[0]))
        for case in cases:
            observed[case["id"]] = tracer.observe(case["id"], lambda case=case: driver.evaluate(case))
    finally:
        tracer.close()
    return {"hooked": started["hooked"], "cases": observed}


def seeds_from_runtime(index: dict, runtime_cases: dict[str, dict], *, max_seeds: int) -> list[dict]:
    """Rank functions the cases actually entered.

    Functions hit by only some cases are operator-specific and are preferred; a couple of
    functions hit by every case (the interpreter loop) are kept as the subsystem root.
    """
    functions = {int(item["entry"], 16): item for item in index["functions"]
                 if not item.get("thunk")}
    stats: dict[str, dict] = {}
    for case_id, observation in runtime_cases.items():
        for hit in observation["hits"]:
            item = functions.get(int(hit["entry"], 16))
            if item is None:
                continue  # hit outside the analyzed program's functions
            entry = stats.setdefault(item["entry"], {"entry": item["entry"], "name": item["name"],
                                                     "cases": set(), "count": 0})
            entry["cases"].add(case_id)
            entry["count"] += int(hit["count"])
    total = len(runtime_cases)
    specific = sorted((s for s in stats.values() if len(s["cases"]) < total),
                      key=lambda s: (len(s["cases"]), -s["count"], s["entry"]))
    common = sorted((s for s in stats.values() if len(s["cases"]) == total),
                    key=lambda s: (-s["count"], s["entry"]))
    chosen = common[:2] + specific[:max(0, max_seeds - min(2, len(common)))]
    return [{"entry": s["entry"], "name": s["name"], "cases": sorted(s["cases"]),
             "count": s["count"], "reason": "runtime_all_cases" if len(s["cases"]) == total
             else "runtime_specific"} for s in chosen[:max_seeds]]


def observations_by_entry(runtime_cases: dict[str, dict], cases: list[dict]) -> dict[int, list[dict]]:
    formulas = {case["id"]: case["formula"] for case in cases}
    found: dict[int, list[dict]] = {}
    for case_id, observation in runtime_cases.items():
        for hit in observation["hits"]:
            found.setdefault(int(hit["entry"], 16), []).append(
                {"case": case_id, "formula": formulas.get(case_id), "entries": int(hit["count"])})
    return found


def run_pipeline(config: LoPipelineConfig, install: dict, deps: LoPipelineDeps) -> dict:
    engine, log = deps.engine, deps.log
    stages: dict[str, float] = {}
    summary: dict = {"schema": 1, "library": config.library, "lo_version": install.get("version"),
                     "stages": stages}

    def timed(name: str, fn: Callable):
        started = time.monotonic()
        try:
            return fn()
        finally:
            stages[name] = round(time.monotonic() - started, 3)

    library = install["libraries"].get(config.library)
    if library is None:
        raise FileNotFoundError(f"{config.module} not found in {install['program_dir']}")
    if not library["symbols"]["named"]:
        log(f"warning: {library['path']} has no symbols or debug file; names will be FUN_*")
    public, held_out = split_cases(config.cases)
    summary["cases"] = {"public": len(public), "held_out": len(held_out)}

    runtime_cases: dict[str, dict] = {}
    early_triage = None
    discovery_unresolved = []
    if config.scoped_analysis:
        inventory = symbol_inventory(Path(library['path']))
        original_base = int(inventory['elf_image_base'], 16)
        if config.seed_source == 'runtime':
            log('[triage] Frida observations before scoped Ghidra preparation')
            def trace_first():
                with deps.rea_factory() as session, deps.driver_factory() as driver:
                    return runtime_triage(session, driver, public, module=config.module,
                        patterns=config.frida_patterns, image_base=original_base,
                        tracer_cls=deps.tracer_cls,
                        offsets=hook_offsets(inventory, config.frida_patterns))
            early_triage = timed('triage', trace_first)
            runtime_cases = early_triage['cases']
            metadata_index = {'functions': [{'entry': s['address'], 'name': s['name']}
                                           for s in inventory['symbols']]}
            known_extents = {int(s['address'], 16) for s in inventory['symbols']}
            missing_extents = sorted({hit['entry'] for case in runtime_cases.values()
                for hit in case['hits'] if int(hit['entry'], 16) not in known_extents})
            if missing_extents:
                discovery_unresolved.append({'kind': 'runtime_seed_extent_missing',
                    'entries': missing_extents, 'address_space': 'original ELF virtual addresses'})
            root_seeds = [s['entry'] for s in seeds_from_runtime(metadata_index, runtime_cases,
                                                                max_seeds=config.max_seeds)]
        elif config.seed_source == 'rea_static':
            # Resolve only sized symbols before launching REA's expensive native provider.
            patterns = [re.compile(p) for p in config.static_patterns]
            candidates = {s['address'] for s in inventory['symbols'] if any(
                p.search(s['name']) or p.search(s.get('display_name', s['name'])) for p in patterns)}
            root_seeds = sorted(candidates, key=lambda s: int(s, 16))[:config.max_seeds]
            if len(candidates) > len(root_seeds):
                discovery_unresolved.append({'kind': 'seed_candidate_budget_exhausted',
                    'candidates': len(candidates), 'selected': len(root_seeds)})
        else:
            raise ValueError('seed_source must be runtime or rea_static')
        if not root_seeds:
            raise RuntimeError('no observed/symbol-bounded seeds; refusing whole-module analysis fallback')
        summary['seed_discovery'] = {'source': config.seed_source, 'roots': root_seeds,
                                     'unresolved': discovery_unresolved}
        manifest = timed('analyze', lambda: engine.analyze_scoped(Path(library['path']), root_seeds,
                            max_functions=config.max_functions, max_depth=config.max_depth))
    else:
        log(f"[analyze] {library['path']}")
        manifest = timed("analyze", lambda: engine.analyze(Path(library["path"])))
    if manifest["binary_sha256"] != library["sha256"]:
        raise ValueError("analyzed binary differs from the installed library LibreOffice loads")
    index = engine.index(manifest)
    image_base = int(index.get("image_base", "0"), 16)
    summary.update(campaign=manifest["campaign"], function_count=manifest["function_count"],
                   binary_sha256=manifest["binary_sha256"])

    if config.seed_source == "runtime":
        log(f"[triage] Frida via REA on {config.module}, {len(public)} public cases")

        def trace() -> dict:
            with deps.rea_factory() as session, deps.driver_factory() as driver:
                return runtime_triage(session, driver, public, module=config.module,
                                      patterns=config.frida_patterns, image_base=image_base,
                                      tracer_cls=deps.tracer_cls,
                                      offsets=hook_offsets(symbol_inventory(Path(library['path'])),
                                                           config.frida_patterns))
        if early_triage is not None:
            triage = early_triage
            delta = image_base - original_base
            for observation in triage['cases'].values():
                for hit in observation['hits']:
                    hit['entry'] = format(int(hit['entry'], 16) + delta, '08x')
        else:
            triage = timed("triage", trace)
        runtime_cases = triage["cases"]
        seeds = seeds_from_runtime(index, runtime_cases, max_seeds=config.max_seeds)
        summary["triage"] = {"hooked": triage["hooked"], "seeds": seeds}
    elif config.seed_source == "rea_static":
        log(f"[triage] REA static search on {library['path']}")

        def search() -> dict:
            if config.scoped_analysis:
                import tempfile
                with tempfile.TemporaryDirectory(dir=engine.root) as scratch:
                    servers = prepared_readers(manifest, Path(scratch) / 'readers',
                                               engine.headless.parent.parent)
                    with deps.rea_factory(env=servers['rea']['environment']) as session:
                        return static_triage(session, Path(library['path']),
                                             procedure_patterns=config.static_patterns)
            with deps.rea_factory() as session:
                return static_triage(session, Path(library["path"]),
                                     procedure_patterns=config.static_patterns)
        triage = timed("triage", search)
        known = {int(item["entry"], 16) for item in index["functions"]}
        seeds = [{"entry": format(int(c["address"], 16), "08x"), "name": c["name"],
                  "reason": ",".join(c["reasons"])} for c in triage["candidates"]
                 if int(c["address"], 16) in known][:config.max_seeds]
        summary["triage"] = {"overview": triage["overview"], "seeds": seeds,
                             "provider_open_seconds": triage["provider_open_seconds"]}
    else:
        raise ValueError("seed_source must be runtime or rea_static")
    if not seeds:
        raise RuntimeError("triage found no seed functions in the analyzed library; check "
                           "debug symbols and frida_patterns (no hand-picked fallback)")

    request = ScopeRequest.from_dict({
        "mode": "subsystem", "query": config.query,
        "seeds": [seed["entry"] for seed in seeds], "max_functions": config.max_functions,
        "max_depth": config.max_depth, "include_callers": False,
        "include_shared_data": False, "expected_observables": config.expected_observables})
    boundary = tuple([*discovery_unresolved, *({'kind': 'scoped_analysis_boundary', **item}
                     for item in manifest.get('scope', {}).get('frontier', []))])
    scope = timed("scope", lambda: deps.persist_scope(engine, manifest, request,
                   **({'additional_unresolved': boundary} if config.scoped_analysis else {})))
    scope_artifact = scope["artifact"]
    summary["scope"] = {"artifact": scope_artifact, "included": len(scope["included"])}
    log(f"[scope] {len(scope['included'])} functions from {len(seeds)} seeds")

    per_entry = observations_by_entry(runtime_cases, public)

    def analyse(entry: str) -> dict:
        observations = per_entry.get(int(entry, 16))
        draft = deps.worker.run(manifest, scope_artifact, entry, runtime_observations=observations)
        if draft["state"] != "unreviewed":
            return {"entry": entry, "draft": draft, "review": None}
        review = deps.reviewer.run(draft["artifact"], model_role=config.review_model_role)
        if (config.investigate and deps.investigator is not None and
                review["state"] == "reviewed"):
            investigation = deps.investigator.run(manifest, draft["artifact"], review["artifact"])
            if investigation and investigation["state"] == "answered":
                context = deps.investigator.revision_context(manifest, scope_artifact, investigation)
                revised = deps.worker.run(manifest, scope_artifact, entry, prior_artifact=context,
                                          runtime_observations=observations)
                if revised["state"] == "unreviewed":
                    second = deps.reviewer.run(revised["artifact"],
                                               model_role=config.review_model_role)
                    if second["state"] == "reviewed":
                        return {"entry": entry, "draft": revised, "review": second,
                                "investigation": investigation["artifact"]}
        return {"entry": entry, "draft": draft, "review": review}

    entries = [item["entry"] for item in scope["included"]]
    log(f"[claims] {len(entries)} functions, {config.workers} workers")
    with ThreadPoolExecutor(max_workers=max(1, config.workers)) as pool:
        analysed = timed("claims", lambda: list(pool.map(analyse, entries)))
    drafts = [a["draft"]["artifact"] for a in analysed if a["draft"]["state"] == "unreviewed"]
    reviews = [a["review"]["artifact"] for a in analysed
               if a["review"] is not None and a["review"]["state"] == "reviewed"]
    summary["claims"] = {
        "drafted": len(drafts), "reviewed": len(reviews),
        "draft_states": _count(a["draft"]["state"] for a in analysed),
        "investigated": sum("investigation" in a for a in analysed)}

    targets = resolve_targets(config.cases, scope,
                              {cid: obs["hits"] for cid, obs in runtime_cases.items()})
    log(f"[oracle] evaluating {len(config.cases)} formulas in LibreOffice {install.get('version')}")

    def oracle() -> dict[str, dict]:
        with deps.driver_factory() as driver:
            return observe_cases(driver, config.cases)
    observations = timed("oracle", oracle)
    public_report = probe_report(engine.store, public, observations,
                                 binary_sha256=manifest["binary_sha256"],
                                 lo_version=install.get("version"), targets=targets)
    held_report = probe_report(engine.store, held_out, observations,
                               binary_sha256=manifest["binary_sha256"],
                               lo_version=install.get("version"), targets=targets)
    summary["probes"] = {"public": public_report["counts"], "held_out": held_report["counts"],
                         "public_report_artifact": public_report["artifact"],
                         "held_out_report_artifact": held_report["artifact"],
                         "unlinked_cases": sorted(cid for cid, t in targets.items() if t is None),
                         "disagreements": [r["case_id"] for r in public_report["results"] +
                                           held_report["results"] if r["outcome"] != "agreement"]}

    link_artifacts, case_links = [], {}
    if deps.linker is not None:
        linked = timed("links", lambda: link_claims_to_cases(
            deps.linker, analysed, public, per_entry, observations,
            report_artifact=public_report["artifact"], model_role=config.link_model_role,
            workers=config.workers, log=log))
        link_artifacts, case_links = linked["link_artifacts"], linked["case_links"]
        summary["case_links"] = linked["summary"]

    dossier = timed("dossier", lambda: deps.persist_dossier(
        engine, manifest, scope_artifact, drafts, reviews, [public_report["artifact"]],
        link_artifacts))
    summary["dossier"] = {"artifact": dossier["artifact"], "readiness": dossier["readiness"],
                          "blockers": dossier.get("blockers", []),
                          "coverage": dossier.get("coverage")}
    log(f"[dossier] readiness {dossier['readiness']}")
    summary["handoff"] = build_handoff(engine.store, analysed, scope, public, observations,
                                       case_links=case_links)
    summary["spec"], error = timed("spec", lambda: spec_for_dossier(
        deps.persist_spec, engine.store, engine.root, dossier))
    if error:
        summary["spec_error"] = error
    log(f"[spec] {summary['spec']['status']} specification {summary['spec']['artifact']}"
        if summary["spec"] else f"[spec] not generated: {error or 'dossier not specifiable'}")
    return summary


def link_claims_to_cases(linker, analysed: list[dict], public: list[dict],
                         per_entry: dict[int, list[dict]], observations: dict[str, dict], *,
                         report_artifact: str, model_role: str, workers: int,
                         log: Callable[[str], None]) -> dict:
    """Blind-link each reviewed function's claims to the public cases that ran it.

    A linker failure leaves that function's claims unlinked; it never fails the run.
    """
    by_id = {case["id"]: case for case in public}
    jobs = []
    for item in analysed:
        if item["draft"]["state"] != "unreviewed" or not item["review"] or \
                item["review"]["state"] != "reviewed":
            continue
        ran = {hit["case"] for hit in per_entry.get(int(item["entry"], 16), [])}
        cases = [{"id": cid, "input": {"formula": by_id[cid]["formula"],
                                       "cells": by_id[cid].get("cells", {})},
                  "description": by_id[cid].get("input_description")}
                 for cid in sorted(ran) if cid in by_id]
        if cases:
            jobs.append((item, cases))
    log(f"[links] {len(jobs)} functions with runtime-observed public cases")

    def run(job):
        item, cases = job
        try:
            return linker.run(item["draft"]["artifact"], item["review"]["artifact"], cases,
                              observations, report_artifact=report_artifact, matches=matches,
                              observation_format=OBSERVATION_FORMAT, model_role=model_role)
        except Exception as error:
            return {"state": "failed", "subject": item["entry"], "error": f"{type(error).__name__}: {error}",
                    "links": []}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        results = list(pool.map(run, jobs))
    links = [link for result in results for link in result["links"]]
    case_links: dict[tuple[str, int], list[dict]] = {}
    for link in links:
        case_links.setdefault((link["draft_artifact"], link["claim_index"]), []).append(
            {"case_id": link["case_id"], "agreement": link["agreement"]})
    store = linker.engine.store
    result_artifacts = [store.put(json.dumps(result, sort_keys=True).encode()) for result in results]
    link_artifacts = []
    if links:
        link_artifacts.append(store.put(json.dumps({"schema": 1, "links": links,
            "linker_results": result_artifacts}, sort_keys=True).encode()))
    claims = list(case_links.values())
    summary = {"functions": len(jobs), "states": _count(r["state"] for r in results),
               "links": len(links), "agreements": sum(l["agreement"] for l in links),
               "claims_with_agreement": sum(any(c["agreement"] for c in v) and
                                            all(c["agreement"] for c in v) for v in claims),
               "claims_with_disagreement": sum(any(not c["agreement"] for c in v) for v in claims),
               "artifacts": link_artifacts}
    log(f"[links] {summary['links']} links, {summary['agreements']} agree; "
        f"{summary['claims_with_agreement']} claims linked without disagreement")
    return {"link_artifacts": link_artifacts, "case_links": case_links, "summary": summary}


def spec_for_dossier(persist_spec: Callable, store, root: Path, dossier: dict) -> tuple[dict | None, str | None]:
    """persist_spec writes "ready_for_review" for verified dossiers and "draft" for partial ones.

    A writer failure is returned rather than raised: the evidence handoff is useful without a spec.
    """
    if dossier["readiness"] not in ("ready_for_spec", "partial"):
        return None, None
    try:
        spec = persist_spec(root, dossier["artifact"])
        status = json.loads(store.get(spec["artifact"])).get("status")
        # Which writer ran: the LLM spec_writer, or the deterministic fallback when Node is missing.
        writer = (json.loads(store.get(spec["audit_artifact"])).get("model")
                  if spec.get("audit_artifact") else None)
    except Exception as error:
        return None, f"{type(error).__name__}: {error}"
    return {"artifact": spec["artifact"], "markdown_path": spec.get("markdown_path"),
            "status": status, "requirements": spec.get("requirements"), "writer": writer}, None


def build_handoff(store, analysed: list[dict], scope: dict, public: list[dict],
                  observations: dict[str, dict],
                  case_links: dict[tuple[str, int], list[dict]] | None = None) -> dict:
    """Evidence a spec author can turn into a FeatureSpec, even when the dossier is not ready.

    Claims carry the independent review verdict; observed cases are real LibreOffice results.
    Held-out cases are never passed in: they stay hidden from spec authors and implementers.
    """
    names = {item["entry"]: item.get("name") for item in scope["included"]}
    readable = _demangle([name for name in names.values() if name])
    functions = []
    for item in analysed:
        draft, review = item["draft"], item["review"]
        symbol = names.get(item["entry"])
        record = {"entry": item["entry"], "name": readable.get(symbol, symbol), "symbol": symbol,
                  "draft_state": draft["state"], "review_state": review and review["state"],
                  "claims": [], "dependencies": [], "unknowns": []}
        if draft["state"] == "unreviewed":
            answer = json.loads(store.get(draft["artifact"]))["answer"]
            verdicts, missing = {}, []
            if review is not None and review["state"] == "reviewed":
                reviewed = json.loads(store.get(review["artifact"])).get("answer") or {}
                verdicts = {r["claim_index"]: r for r in reviewed.get("reviews", [])}
                missing = reviewed.get("missing_behavior", [])
            record.update(
                behavior={key: answer.get(key) for key in
                          ("inputs", "outputs", "state", "side_effects", "errors")},
                claims=[{"statement": claim["statement"],
                         "evidence_addresses": claim.get("evidence_addresses", []),
                         "assumptions": claim.get("assumptions", []),
                         "review": ({"outcome": verdicts[i]["outcome"], "reason": verdicts[i]["reason"]}
                                    if i in verdicts else None),
                         # Public cases whose blind prediction from this claim was compared with
                         # the real result; held-out cases are never linked.
                         "case_links": (case_links or {}).get((draft["artifact"], i), [])}
                        for i, claim in enumerate(answer.get("claims", []))],
                dependencies=answer.get("dependencies", []), unknowns=answer.get("unknowns", []),
                missing_behavior=missing)
        functions.append(record)
    cases = [{"id": case["id"], "formula": case["formula"], "cells": case.get("cells", {}),
              "description": case.get("input_description"),
              "observed": (observations.get(case["id"]) or {}).get("observed")}
             for case in public]
    return {"functions": functions, "observed_cases": cases}


def write_handoff(folder: Path, summary: dict, handoff: dict | None, store) -> Path:
    """evidence.json + README.md (+ native_spec.json when a spec was generated) for Engineer 2."""
    folder.mkdir(parents=True, exist_ok=True)
    handoff = handoff or {"functions": [], "observed_cases": []}
    dossier = summary.get("dossier") or {}
    outcomes = _count(claim["review"]["outcome"] if claim["review"] else "unreviewed"
                      for function in handoff["functions"] for claim in function["claims"])
    evidence = {"schema": 1,
                "source": {"library": summary.get("library"), "lo_version": summary.get("lo_version"),
                           "binary_sha256": summary.get("binary_sha256"),
                           "campaign": summary.get("campaign")},
                "readiness": dossier.get("readiness"), "blockers": dossier.get("blockers", []),
                "coverage": dossier.get("coverage"), "claim_outcomes": outcomes,
                "held_out_cases_withheld": (summary.get("cases") or {}).get("held_out", 0),
                "spec": summary.get("spec"), "spec_error": summary.get("spec_error"),
                **handoff}
    (folder / "evidence.json").write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n")
    spec = summary.get("spec")
    if spec and spec.get("artifact"):
        (folder / "native_spec.json").write_bytes(store.get(spec["artifact"]))
    drafted = sum(f["draft_state"] == "unreviewed" for f in handoff["functions"])
    reviewed = sum(f["review_state"] == "reviewed" for f in handoff["functions"])
    lines = [
        "# LibreOffice Calc formula evaluation: decomp handoff", "",
        f"Dossier readiness: **{dossier.get('readiness')}**. "
        f"Functions drafted {drafted}/{len(handoff['functions'])}, independently reviewed {reviewed}.",
        "Claim verdicts: " + (", ".join(f"{k} {v}" for k, v in sorted(outcomes.items())) or "none") + ".", "",
        "## Using this for a FeatureSpec", "",
        "- `supported_static` claims are candidate requirements. `uncertain` claims need runtime "
        "confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.",
        "- `observed_cases` are real results from LibreOffice "
        f"{summary.get('lo_version')}; use them as acceptance-test examples.",
        f"- {evidence['held_out_cases_withheld']} held-out cases are deliberately withheld for "
        "independent checking. Do not ask for them.",
        "- C++ mechanics (offsets, vtables, constructors) are not requirements; list them under "
        "`stripped_glue` if needed.",
    ]
    if spec and spec.get("status") == "ready_for_review":
        lines += [f"- `native_spec.json` (artifact `{spec['artifact']}`) is ready for review. Convert "
                  "it with `POST /api/native-specs/adapt` and body `{\"spec\": <native_spec.json>}`."]
    elif spec:
        lines += [f"- `native_spec.json` (artifact `{spec['artifact']}`) is a **draft**: the evidence "
                  "is incomplete, so the adapter refuses it. Use it as a starting point and "
                  "hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`."]
    else:
        lines += ["- No spec was generated" +
                  (f" ({summary['spec_error']})" if summary.get("spec_error") else "") +
                  ". Hand-author the FeatureSpec in the format of `fixtures/hand-authored/specs/*.json`."]
    if evidence["blockers"]:
        kinds = _count(b.get("kind", "other") if isinstance(b, dict) else str(b)
                       for b in evidence["blockers"])
        lines += ["", "## Readiness blockers (details in evidence.json)", ""]
        lines += [f"- {kind}: {count}" for kind, count in sorted(kinds.items())]
    lines += ["", "## Functions", ""]
    for function in handoff["functions"]:
        lines.append(f"### `{function['name'] or function['entry']}` ({function['entry']})")
        lines.append(f"Draft {function['draft_state']}, review {function['review_state']}.")
        for claim in function["claims"]:
            verdict = claim["review"]["outcome"] if claim["review"] else "unreviewed"
            lines.append(f"- [{verdict}] {claim['statement']}")
        lines.append("")
    (folder / "README.md").write_text("\n".join(lines) + "\n")
    return folder


def _demangle(names: list[str]) -> dict[str, str]:
    """C++ display names via c++filt when available; the mangled symbol stays in the record."""
    try:
        result = subprocess.run(["c++filt"], input="\n".join(names) + "\n", capture_output=True,
                                text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return {}
    lines = result.stdout.splitlines()
    return dict(zip(names, lines)) if result.returncode == 0 and len(lines) == len(names) else {}


def _count(values) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def save_summary(root: Path, summary: dict) -> Path:
    folder = Path(root) / "lo_runs"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / time.strftime("%Y%m%dT%H%M%S.json")
    path.write_text(json.dumps(summary, indent=2, sort_keys=True, default=str) + "\n")
    return path
