"""LibreOffice Calc: triage -> scoped decompile -> evidence claims -> real probes -> dossier -> spec.

Each stage reuses the engine's existing, validated path:
  scope      engine.scope.persist_scope          (seeds come from runtime hits, not a hand list)
  claims     engine.worker.SemanticWorker        (OpenCode, evidence-only, cites addresses)
  review     engine.validation.review.IndependentReviewer
  probes     engine.libreoffice.probe_report     (observed = the running LibreOffice)
  readiness  engine.dossier.persist_dossier      (never set here)
  spec       engine.specification.persist_spec   (only when the dossier says ready_for_spec)
Dependencies are injected so the whole flow is unit-testable without Ghidra, REA or Bedrock.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
from pathlib import Path
import time
from typing import Callable

from engine.analysis.rea import RuntimeTracer, ReaSession, static_triage
from engine.libreoffice import (UnoDriver, observe_cases, probe_report, resolve_targets,
                                split_cases)
from engine.models import ScopeRequest

DEFAULT_FRIDA_PATTERNS = ["*ScInterpreter*", "*ScCompiler*", "*FormulaCompiler*"]


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


@dataclass
class LoPipelineDeps:
    engine: object
    rea_factory: Callable[[], ReaSession]
    driver_factory: Callable[[], UnoDriver]
    worker: object
    reviewer: object
    persist_scope: Callable
    persist_dossier: Callable
    persist_spec: Callable
    investigator: object | None = None
    tracer_cls: type = RuntimeTracer
    log: Callable[[str], None] = print


def runtime_triage(session: ReaSession, driver: UnoDriver, cases: list[dict], *, module: str,
                   patterns: list[str], image_base: int, tracer_cls: type = RuntimeTracer) -> dict:
    """Per case: which functions of `module` ran while LibreOffice evaluated its formula."""
    tracer = tracer_cls(session, pid=driver.pid, module=module, patterns=patterns,
                        image_base=image_base)
    started = tracer.start()
    observed = {}
    try:
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

    log(f"[analyze] {library['path']}")
    manifest = timed("analyze", lambda: engine.analyze(Path(library["path"])))
    if manifest["binary_sha256"] != library["sha256"]:
        raise ValueError("analyzed binary differs from the installed library LibreOffice loads")
    index = engine.index(manifest)
    image_base = int(index.get("image_base", "0"), 16)
    summary.update(campaign=manifest["campaign"], function_count=manifest["function_count"])

    runtime_cases: dict[str, dict] = {}
    if config.seed_source == "runtime":
        log(f"[triage] Frida via REA on {config.module}, {len(public)} public cases")

        def trace() -> dict:
            with deps.rea_factory() as session, deps.driver_factory() as driver:
                return runtime_triage(session, driver, public, module=config.module,
                                      patterns=config.frida_patterns, image_base=image_base,
                                      tracer_cls=deps.tracer_cls)
        triage = timed("triage", trace)
        runtime_cases = triage["cases"]
        seeds = seeds_from_runtime(index, runtime_cases, max_seeds=config.max_seeds)
        summary["triage"] = {"hooked": triage["hooked"], "seeds": seeds}
    elif config.seed_source == "rea_static":
        log(f"[triage] REA static search on {library['path']}")

        def search() -> dict:
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
    scope = timed("scope", lambda: deps.persist_scope(engine, manifest, request))
    scope_artifact = scope["artifact"]
    summary["scope"] = {"artifact": scope_artifact, "included": len(scope["included"])}
    log(f"[scope] {len(scope['included'])} functions from {len(seeds)} seeds")

    per_entry = observations_by_entry(runtime_cases, public)

    def analyse(entry: str) -> dict:
        observations = per_entry.get(int(entry, 16))
        draft = deps.worker.run(manifest, scope_artifact, entry, runtime_observations=observations)
        if draft["state"] != "unreviewed":
            return {"entry": entry, "draft": draft, "review": None}
        review = deps.reviewer.run(draft["artifact"])
        if (config.investigate and deps.investigator is not None and
                review["state"] == "reviewed"):
            investigation = deps.investigator.run(manifest, draft["artifact"], review["artifact"])
            if investigation and investigation["state"] == "answered":
                context = deps.investigator.revision_context(manifest, scope_artifact, investigation)
                revised = deps.worker.run(manifest, scope_artifact, entry, prior_artifact=context,
                                          runtime_observations=observations)
                if revised["state"] == "unreviewed":
                    second = deps.reviewer.run(revised["artifact"])
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

    dossier = timed("dossier", lambda: deps.persist_dossier(
        engine, manifest, scope_artifact, drafts, reviews, [public_report["artifact"]]))
    summary["dossier"] = {"artifact": dossier["artifact"], "readiness": dossier["readiness"],
                          "blockers": dossier.get("blockers", []),
                          "coverage": dossier.get("coverage")}
    log(f"[dossier] readiness {dossier['readiness']}")
    if dossier["readiness"] == "ready_for_spec":
        spec = timed("spec", lambda: deps.persist_spec(engine.root, dossier["artifact"]))
        summary["spec"] = {key: spec.get(key) for key in
                           ("artifact", "markdown_path", "status", "requirements")}
    else:
        summary["spec"] = None
    return summary


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
