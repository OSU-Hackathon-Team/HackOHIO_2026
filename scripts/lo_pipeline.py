"""Run the LibreOffice Calc pipeline end to end inside the worker container.

    python3 scripts/lo_pipeline.py [--cases ...] [--seed-source runtime|rea_static] [--investigate]

Default stages: analyze (Ghidra, light whole-module profile) -> triage (REA).
Explicit --analysis-profile scoped locates seeds before bounded preparation and
uses prepared read-only REA/Ghidra contexts. This requires observed or symbol seeds;
automatic application-wide subsystem discovery remains separate work.
-> scope from those seeds -> SemanticWorker claims + IndependentReviewer (OpenCode, Bedrock)
-> optional OpenCode investigator for open review questions -> probes in real LibreOffice
-> dossier (readiness decided by engine.dossier) -> spec only when ready_for_spec.
Writes a run summary to <state>/lo_runs/. Costs Bedrock tokens; see the handoff doc.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from launch import check_container_guard  # noqa: E402
from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.analysis.rea import ReaSession  # noqa: E402
from engine.dossier import persist_dossier  # noqa: E402
from engine.investigator import Investigator  # noqa: E402
from engine.libreoffice import UnoDriver, find_install, load_cases  # noqa: E402
from engine.lo_pipeline import (DEFAULT_FRIDA_PATTERNS, LoPipelineConfig, LoPipelineDeps,  # noqa: E402
                                run_pipeline, save_summary)
from engine.scope import persist_scope  # noqa: E402
from engine.specification import persist_spec  # noqa: E402
from engine.validation.review import IndependentReviewer  # noqa: E402
from engine.worker import SemanticWorker  # noqa: E402

DEFAULT_CASES = ROOT / "fixtures/decomp/libreoffice/formula_cases.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--state", type=Path, default=ROOT / "decomp-state")
    parser.add_argument("--library", default="calc", choices=["calc", "formula"])
    parser.add_argument("--seed-source", default="runtime", choices=["runtime", "rea_static"])
    parser.add_argument("--frida-pattern", action="append")
    parser.add_argument("--static-pattern", action="append", default=[])
    parser.add_argument("--max-functions", type=int, default=60)
    parser.add_argument("--max-depth", type=int, default=2)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--analysis-profile", default="light", choices=["scoped", "light", "full"],
                        help='scoped selects seeds first; light/full explicitly analyze the whole module')
    parser.add_argument("--investigate", action="store_true",
                        help="let an OpenCode agent with read-only REA/Ghidra tools answer review gaps")
    parser.add_argument("--uno-python", default=os.environ.get("LO_PYTHON", "/usr/bin/python3"))
    parser.add_argument("--opencode", type=Path,
                        default=Path(os.environ.get("OPENCODE_BIN", "/run/opencode-bin")))
    parser.add_argument("--headless", type=Path, default=Path(
        os.environ.get("GHIDRA_HEADLESS") or
        Path(os.environ.get("GHIDRA_INSTALL_DIR", "/opt/ghidra")) / "support/analyzeHeadless"))
    args = parser.parse_args()
    check_container_guard("lo-pipeline")

    state = args.state.resolve()
    os.environ["DECOMP_STATE"] = str(state)  # engine.scope looks up debug symbols through it
    suite = load_cases(args.cases)
    install = find_install()
    engine = GhidraAnalysis(state, args.headless,
                            analysis_profile='full' if args.analysis_profile == 'scoped' else args.analysis_profile,
                            timeout=int(os.environ.get("DECOMP_ANALYSIS_TIMEOUT", "3600")))
    config = LoPipelineConfig(
        cases=suite["cases"], query=suite["query"],
        expected_observables=suite["expected_observables"], library=args.library,
        module=Path(install["libraries"][args.library]["path"]).name,
        frida_patterns=args.frida_pattern or list(DEFAULT_FRIDA_PATTERNS),
        seed_source=args.seed_source, static_patterns=args.static_pattern,
        max_functions=args.max_functions, max_depth=args.max_depth, workers=args.workers,
        investigate=args.investigate, scoped_analysis=args.analysis_profile == 'scoped')
    deps = LoPipelineDeps(
        engine=engine, rea_factory=ReaSession.launch,
        driver_factory=lambda: UnoDriver(install["soffice"], python=args.uno_python),
        worker=SemanticWorker(engine, args.opencode),
        reviewer=IndependentReviewer(engine, args.opencode),
        investigator=Investigator(engine, args.opencode) if args.investigate else None,
        persist_scope=persist_scope, persist_dossier=persist_dossier, persist_spec=persist_spec)
    try:
        summary = run_pipeline(config, install, deps)
    finally:
        engine.close()
    path = save_summary(state, summary)
    print(json.dumps({k: summary.get(k) for k in ("stages", "scope", "claims", "probes", "dossier", "spec")},
                     indent=2, default=str))
    print(f"summary: {path}")
    return 0 if summary.get("spec") else 2


if __name__ == "__main__":
    sys.exit(main())
