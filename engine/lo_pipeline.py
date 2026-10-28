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
import os
import re
import subprocess
from pathlib import Path
import time
from typing import Callable

from engine.analysis.rea import RuntimeTracer, ReaSession, spawn_triage, static_triage
from engine.analysis.ghidra import file_hash
from engine.scope import resolve_seed
from engine.analysis.scoped import symbol_inventory, prepared_readers
from engine.libreoffice import (UNO_DRIVER, UnoDriver, case_display as display_case, formula_input, matches, observe_cases,
                                probe_report, resolve_targets, split_cases)
from engine.models import ScopeRequest
from model_config import get_model

DEFAULT_FRIDA_PATTERNS = ["*ScInterpreter*", "*ScCompiler*", "*FormulaCompiler*"]
OBSERVATION_FORMAT = ("a JSON object with value (a number) for numeric results, text (a string) for "
                      "text results, both error (the numeric LibreOffice error code) and text "
                      "(its display string such as #DIV/0!) for errors, or cells (an array of row "
                      "arrays) for Calc table-operation results.")


def _materialize_cached_result(root: Path, store, kind: str, result: dict) -> None:
    """Keep reused model records in the normal archive without charging old tokens again."""
    def hydrate(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key.endswith("_artifact") and isinstance(child, str) and len(child) == 64:
                    store.get(child)
                else:
                    hydrate(child)
        elif isinstance(value, list):
            for child in value:
                hydrate(child)
    hydrate(result)
    identifier = result["attempt_id" if kind == "attempts" else "review_id"]
    if not isinstance(identifier, str) or re.fullmatch(r"[a-f0-9]{32}", identifier) is None:
        raise RuntimeError("invalid cached model record identity")
    folder = root / kind / identifier
    folder.mkdir(parents=True, exist_ok=True)
    record = {**result, "cache_reused": True,
              "usage": {key: 0 for key in ("input", "output", "reasoning", "cost")}}
    (folder / "result.json").write_text(json.dumps(record, indent=2) + "\n")


def _restore_cached_analysis(engine, cache, identity: dict, entry: str,
                             evidence: dict) -> dict | None:
    saved = cache.get("semantic_review", identity)
    if saved is None:
        engine._emit(identity["campaign"], "semantic_cache_miss", subject=entry)
        return None
    from engine.worker import validate_answer
    from engine.validation.review import validate_review
    draft_artifact = saved.get("draft_artifact")
    review_artifact = saved.get("review_artifact")
    draft = json.loads(engine.store.get(draft_artifact))
    review = json.loads(engine.store.get(review_artifact))
    if (draft.get("campaign") != identity["campaign"] or
            draft.get("scope_artifact") != identity["scope_artifact"] or
            draft.get("subject") != entry or
            draft.get("evidence_artifact") != identity["evidence_artifact"] or
            draft.get("model") != identity["semantic_model"] or
            draft.get("state") != "unreviewed" or
            draft.get("structural_errors") != [] or
            validate_answer(draft.get("answer") or {}, evidence) or
            review.get("draft_artifact") != draft_artifact or
            review.get("campaign") != identity["campaign"] or
            review.get("subject") != entry or
            review.get("evidence_artifact") != identity["evidence_artifact"] or
            review.get("model") != identity["review_model"] or
            review.get("state") != "reviewed" or
            review.get("structural_errors") != [] or
            validate_review(review.get("answer") or {}, evidence,
                            len(draft["answer"]["claims"]))):
        raise RuntimeError("S3 semantic/review cache failed validation")
    _materialize_cached_result(engine.root, engine.store, "attempts",
                               {**draft, "artifact": draft_artifact})
    _materialize_cached_result(engine.root, engine.store, "reviews",
                               {**review, "artifact": review_artifact})
    engine._emit(identity["campaign"], "semantic_cache_hit", subject=entry,
                 artifact=draft_artifact)
    engine._emit(identity["campaign"], "review_cache_hit", subject=entry,
                 artifact=review_artifact)
    return {"entry": entry, "draft": {**draft, "artifact": draft_artifact},
            "review": {**review, "artifact": review_artifact}}


@dataclass
class LoPipelineConfig:
    cases: list[dict]
    query: str
    expected_observables: list[str]
    library: str = "calc"
    module: str = "libsclo.so"
    frida_patterns: list[str] = field(default_factory=lambda: list(DEFAULT_FRIDA_PATTERNS))
    seed_source: str = "runtime"            # "runtime", "rea_static" or "entry"
    entry_seeds: tuple[str, ...] = ()        # declared program entry symbols for "entry"
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
    # Target plug points (fixtures/decomp/targets). Defaults are LibreOffice driven over UNO.
    case_input: Callable[[dict], dict] = formula_input
    case_display: Callable[[dict], str] = display_case
    matches: Callable[[dict, dict], bool] = matches
    observation_format: str = OBSERVATION_FORMAT
    probe_kind: str = "uno_formula"
    probe_adapter: Path | None = None       # hashed into probe records; None = the UNO driver
    driver_name: str = "uno"
    tracing: str = "attach"                 # "spawn": one Frida spawn per case (short-lived programs)
    spawn_tracer: str = "frida"             # "frida": first-party spawn observation; "rea": MCP transport
    spawn_duration_ms: int = 3000           # observation window per spawned case
    program: str | None = None              # the spawned program when tracing == "spawn"
    target_name: str = "LibreOffice Calc"


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


def _trace_cases(config: "LoPipelineConfig", deps: "LoPipelineDeps", cases: list[dict], *,
                 image_base: int, offsets: dict[str, str]) -> dict:
    """Runtime hits per case: attach once to a long-running program, or spawn one per case."""
    if config.tracing == "spawn":
        if config.spawn_tracer == "frida":
            from engine.analysis.frida import cases_triage
            return cases_triage(cases, program=config.program, module=config.module,
                                patterns=config.frida_patterns, image_base=image_base,
                                offsets=offsets, duration_ms=config.spawn_duration_ms)
        with deps.rea_factory() as session:
            return spawn_triage(session, cases, program=config.program,
                                argv_for=lambda case: case["args"], module=config.module,
                                patterns=config.frida_patterns, image_base=image_base,
                                offsets=offsets)
    with deps.rea_factory() as session, deps.driver_factory() as driver:
        return runtime_triage(session, driver, cases, module=config.module,
                              patterns=config.frida_patterns, image_base=image_base,
                              tracer_cls=deps.tracer_cls, offsets=offsets)


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
    formulas = {case["id"]: display_case(case) for case in cases}
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
                     "target_name": config.target_name, "stages": stages}

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
            early_triage = timed('triage', lambda: _trace_cases(
                config, deps, public, image_base=original_base,
                offsets=hook_offsets(inventory, config.frida_patterns)))
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
        elif config.seed_source == 'entry':
            if not config.entry_seeds:
                raise ValueError('entry seeding needs at least one declared entry symbol')
            root_seeds = list(config.entry_seeds)
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
            return _trace_cases(config, deps, public, image_base=image_base,
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
    elif config.seed_source == "entry":
        # No runtime observation: the declared program entry roots the scope and the
        # engine expands it over the analyzed call graph.
        seeds = []
        for name in config.entry_seeds:
            matches = resolve_seed(name, index, manifest["campaign"])
            if not matches:
                raise RuntimeError(f"declared entry {name} is not in the analyzed program")
            item = next((f for f in index["functions"] if f["entry"] == matches[0]["entry"]), None)
            if item is None:
                raise RuntimeError(f"declared entry {name} resolved outside the analyzed index")
            seeds.append({"entry": item["entry"], "name": item["name"],
                          "cases": [], "count": 0, "reason": f"declared_entry:{name}"})
        summary["triage"] = {"hooked": None, "seeds": seeds, "source": "entry"}
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
    cache = getattr(engine, "cache", None)
    model_revision = ({str(path.relative_to(Path(__file__).parent)): file_hash(path)
                       for path in sorted(Path(__file__).parent.rglob("*.py"))}
                      if cache else {})
    opencode = getattr(deps.worker, "opencode", None)
    runtime_revision = file_hash(Path(opencode)) if cache and opencode and Path(opencode).is_file() else None

    def analyse(entry: str) -> dict:
        observations = per_entry.get(int(entry, 16))
        cache_identity = None
        if cache and not config.investigate:
            evidence = engine.function(manifest, entry)
            pointer = Path(manifest["project"]) / "functions" / (entry.replace(":", "_") + ".json")
            evidence_artifact = json.loads(pointer.read_text())["artifact"]
            cache_identity = {"schema": 1, "campaign": manifest["campaign"],
                              "scope_artifact": scope_artifact, "entry": entry,
                              "evidence_artifact": evidence_artifact,
                              "runtime_observations": observations,
                              "semantic_model": get_model("decomp_worker"),
                              "review_model": get_model(config.review_model_role),
                              "max_evidence_bytes": getattr(deps.worker, "max_evidence_bytes", None),
                              "code_sha256": model_revision,
                              "opencode_sha256": runtime_revision}
            reused = _restore_cached_analysis(engine, cache, cache_identity, entry, evidence)
            if reused is not None:
                return reused
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
        if cache_identity and review["state"] == "reviewed":
            cache.put("semantic_review", cache_identity,
                      {"draft_artifact": draft["artifact"], "review_artifact": review["artifact"]})
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
    log(f"[oracle] evaluating {len(config.cases)} cases in {config.target_name} {install.get('version')}")

    def oracle() -> dict[str, dict]:
        with deps.driver_factory() as driver:
            return observe_cases(driver, config.cases)
    observations = timed("oracle", oracle)
    probe_options = {"binary_sha256": manifest["binary_sha256"], "lo_version": install.get("version"),
                     "targets": targets, "kind": config.probe_kind, "case_input": config.case_input,
                     "adapter": config.probe_adapter or UNO_DRIVER, "match": config.matches,
                     "driver": config.driver_name}
    public_report = probe_report(engine.store, public, observations, **probe_options)
    held_report = probe_report(engine.store, held_out, observations, **probe_options)
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
            workers=config.workers, log=log, case_input=config.case_input,
            matches=config.matches, observation_format=config.observation_format))
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
                                       case_links=case_links, case_input=config.case_input,
                                       case_display=config.case_display)
    def write_spec():
        if cache is None or dossier["readiness"] not in ("ready_for_spec", "partial"):
            return spec_for_dossier(deps.persist_spec, engine.store, engine.root, dossier)
        from engine.specification import SCRIPT, WRITER, writer_revision
        identity = {"dossier_artifact": dossier["artifact"],
                    "writer_revision": writer_revision(), "model": get_model("spec_writer"),
                    "writer_available": WRITER.exists() and SCRIPT.exists(),
                    "llm_mode": os.environ.get("LLM_MODE")}
        saved = cache.get("native_spec", identity)
        if saved is not None:
            spec = saved.get("spec")
            audit = saved.get("audit_artifact")
            if not isinstance(spec, dict) or not isinstance(audit, str):
                raise RuntimeError("invalid cached native spec pointer")
            document = json.loads(engine.store.get(spec["artifact"]))
            engine.store.get(audit)
            if document.get("status") != spec.get("status"):
                raise RuntimeError("cached native spec status mismatch")
            engine._emit(manifest["campaign"], "spec_cache_hit", artifact=spec["artifact"])
            return {**spec, "markdown_path": None}, None
        engine._emit(manifest["campaign"], "spec_cache_miss", dossier_artifact=dossier["artifact"])
        spec, error = spec_for_dossier(deps.persist_spec, engine.store, engine.root, dossier)
        if spec is not None:
            audit = spec.get("audit_artifact")
            if audit:
                for artifact in (spec["artifact"], audit):
                    engine.store.put(engine.store.get(artifact))
                cache.put("native_spec", identity, {"spec": spec, "audit_artifact": audit})
        return spec, error

    summary["spec"], error = timed("spec", write_spec)
    if error:
        summary["spec_error"] = error
    log(f"[spec] {summary['spec']['status']} specification {summary['spec']['artifact']}"
        if summary["spec"] else f"[spec] not generated: {error or 'dossier not specifiable'}")
    return summary


def link_claims_to_cases(linker, analysed: list[dict], public: list[dict],
                         per_entry: dict[int, list[dict]], observations: dict[str, dict], *,
                         report_artifact: str, model_role: str, workers: int,
                         log: Callable[[str], None],
                         case_input: Callable[[dict], dict] = formula_input,
                         matches: Callable[[dict, dict], bool] = matches,
                         observation_format: str = OBSERVATION_FORMAT) -> dict:
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
        cases = [{"id": cid, "input": case_input(by_id[cid]),
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
                              observation_format=observation_format, model_role=model_role)
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
            "status": status, "requirements": spec.get("requirements"), "writer": writer,
            **({"audit_artifact": spec["audit_artifact"]} if spec.get("audit_artifact") else {})}, None


def build_handoff(store, analysed: list[dict], scope: dict, public: list[dict],
                  observations: dict[str, dict],
                  case_links: dict[tuple[str, int], list[dict]] | None = None,
                  case_input: Callable[[dict], dict] = formula_input,
                  case_display: Callable[[dict], str] = display_case) -> dict:
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
    # `formula` is the human-readable invocation; `input` is exactly what the oracle ran.
    cases = []
    for case in public:
        record = {"id": case["id"], "cells": case.get("cells", {}),
                  "input": case_input(case), "description": case.get("input_description"),
                  "observed": (observations.get(case["id"]) or {}).get("observed")}
        if "formula" in case:
            record["formula"] = case_display(case)
        else:
            record["operation"] = case_display(case)
        cases.append(record)
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
    target = summary.get("target_name") or "LibreOffice Calc"
    lines = [
        f"# {target}: decomp handoff", "",
        f"Dossier readiness: **{dossier.get('readiness')}**. "
        f"Functions drafted {drafted}/{len(handoff['functions'])}, independently reviewed {reviewed}.",
        "Claim verdicts: " + (", ".join(f"{k} {v}" for k, v in sorted(outcomes.items())) or "none") + ".", "",
        "## Using this for a FeatureSpec", "",
        "- `supported_static` claims are candidate requirements. `uncertain` claims need runtime "
        "confirmation. Drop `contradicted` claims. `unreviewed` claims are unverified.",
        f"- `observed_cases` are real results from {target} "
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
