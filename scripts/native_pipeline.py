"""Run the native decomp pipeline for one registered target inside the worker container.

    python3 scripts/native_pipeline.py --target <id> [--max-functions N] [--max-depth D]

Targets live in fixtures/decomp/targets/<id>.json (contract: DecompTargetSpec). The driver
decides how cases run: "uno" drives LibreOffice over UNO; "cli" installs an apt package, runs
each case's arguments, and uses the real program's stdout, stderr and exit code as the oracle.
Stages and evidence handling are those of engine.lo_pipeline. Writes <state>/lo_runs/.
Costs Bedrock tokens.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from launch import check_container_guard  # noqa: E402
from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.analysis.rea import ReaSession  # noqa: E402
from engine.dossier import persist_dossier  # noqa: E402
from engine.lo_pipeline import (LoPipelineConfig, LoPipelineDeps, run_pipeline,  # noqa: E402
                                save_summary, write_handoff)
from engine.scope import persist_scope  # noqa: E402
from engine.specification import persist_spec  # noqa: E402
from engine.validation.case_links import CaseLinker  # noqa: E402
from engine.validation.review import IndependentReviewer  # noqa: E402
from engine.worker import SemanticWorker  # noqa: E402

TARGETS = ROOT / "fixtures" / "decomp" / "targets"
TARGET_ID = re.compile(r"^[a-z0-9][a-z0-9-]{2,39}$")


def load_target(target_id: str, folder: Path = TARGETS) -> dict:
    if not TARGET_ID.match(target_id):
        raise ValueError(f"invalid target id {target_id!r}")
    target = json.loads((folder / f"{target_id}.json").read_text())
    if target.get("schema") != 1 or target.get("id") != target_id:
        raise ValueError(f"{target_id}: unknown target schema or mismatched id")
    if target.get("driver") not in {"uno", "cli"}:
        raise ValueError(f"{target_id}: unknown driver {target.get('driver')!r}")
    if target["driver"] == "cli" and not isinstance(target.get("install"), dict):
        raise ValueError(f"{target_id}: cli targets need an install recipe")
    return target


def target_setup(target: dict, args: argparse.Namespace) -> tuple[dict, dict, dict]:
    """(install, config fields, driver factory) for the target's driver."""
    cases_path = ROOT / target["cases"]
    if target["driver"] == "uno":
        from engine.libreoffice import UnoDriver, find_install, load_cases
        suite, install = load_cases(cases_path), find_install()
        fields = {"module": Path(install["libraries"][target["library"]]["path"]).name}
        return install, {"suite": suite, **fields}, {
            "driver_factory": lambda: UnoDriver(install["soffice"], python=args.uno_python)}
    from engine.cli_target import (OBSERVATION_FORMAT, CliDriver, cli_case_input, cli_display,
                                   cli_matches, ensure_cli_install, load_cli_cases,
                                   materialize_scripts)
    suite, install = load_cli_cases(cases_path), ensure_cli_install(target)
    program = install["program"]
    # A command-line target takes its input through the command line, so each case's
    # program text becomes a content-addressed file the spawned process can read.
    cases = materialize_scripts(suite["cases"], args.state / "cli-cases" /
                               str(target["id"]))
    suite = {**suite, "cases": cases}
    return install, {"suite": suite, "module": Path(program).name,
                     "case_input": cli_case_input,
                     "case_display": lambda case: cli_display(program, case),
                     "matches": cli_matches, "observation_format": OBSERVATION_FORMAT,
                     "probe_kind": "cli", "probe_adapter": ROOT / "engine" / "cli_target.py",
                     "driver_name": "cli", "tracing": "spawn", "program": program}, {
        "driver_factory": lambda: CliDriver(program)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", required=True)
    parser.add_argument("--state", type=Path, default=ROOT / "decomp-state")
    parser.add_argument("--max-functions", type=int, default=20)
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--review-model-role", default="decomp_worker")
    parser.add_argument("--link-model-role", default="decomp_worker")
    parser.add_argument("--no-case-links", action="store_true")
    parser.add_argument("--uno-python", default=os.environ.get("LO_PYTHON", "/usr/bin/python3"))
    parser.add_argument("--opencode", type=Path,
                        default=Path(os.environ.get("OPENCODE_BIN", "/run/opencode-bin")))
    parser.add_argument("--headless", type=Path, default=Path(
        os.environ.get("GHIDRA_HEADLESS") or
        Path(os.environ.get("GHIDRA_INSTALL_DIR", "/opt/ghidra")) / "support/analyzeHeadless"))
    args = parser.parse_args()
    check_container_guard("native-pipeline")

    target = load_target(args.target)
    state = args.state.resolve()
    os.environ["DECOMP_STATE"] = str(state)  # engine.scope looks up debug symbols through it
    print(f"[setup] {target['name']}: preparing the {target['driver']} target", flush=True)
    install, fields, factories = target_setup(target, args)
    suite = fields.pop("suite")
    engine = GhidraAnalysis(state, args.headless, analysis_profile="full",
                            timeout=int(os.environ.get("DECOMP_ANALYSIS_TIMEOUT", "3600")))
    config = LoPipelineConfig(
        cases=suite["cases"], query=suite["query"], expected_observables=suite["expected_observables"],
        library=target["library"], frida_patterns=list(target["trace_patterns"]),
        seed_source=target.get("seed_source", "runtime"),
        entry_seeds=tuple(target.get("entry_seeds", ())),
        scoped_analysis=bool(target.get("scoped_analysis", True)),
        spawn_tracer=target.get("spawn_tracer", "frida"),
        spawn_duration_ms=int(target.get("spawn_duration_ms", 3000)),
        max_functions=args.max_functions, max_depth=args.max_depth,
        workers=args.workers, review_model_role=args.review_model_role,
        link_model_role=args.link_model_role, target_name=target["name"], **fields)
    deps = LoPipelineDeps(
        engine=engine, rea_factory=ReaSession.launch, worker=SemanticWorker(engine, args.opencode),
        reviewer=IndependentReviewer(engine, args.opencode),
        linker=None if args.no_case_links else CaseLinker(engine, args.opencode),
        persist_scope=persist_scope, persist_dossier=persist_dossier, persist_spec=persist_spec,
        **factories)
    try:
        summary = run_pipeline(config, install, deps)
    finally:
        engine.close()
    summary["target_id"] = target["id"]
    handoff = summary.pop("handoff", None)
    path = save_summary(state, summary)
    folder = write_handoff(path.with_name(path.stem + "-handoff"), summary, handoff, engine.store)
    print(json.dumps({k: summary.get(k) for k in ("stages", "scope", "claims", "probes",
                                                  "case_links", "dossier", "spec")},
                     indent=2, default=str))
    print(f"summary: {path}")
    print(f"handoff: {folder}")
    return 0 if summary.get("spec") else 2


if __name__ == "__main__":
    sys.exit(main())
