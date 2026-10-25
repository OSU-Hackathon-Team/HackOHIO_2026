"""Verify original-probe cases and the discarded-result regression case."""

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.validation.probes import NativeProbeRunner  # noqa: E402


def main() -> None:
    manifest = ROOT / "decomp-state" / "fixtures" / "manifest.json"
    if not manifest.exists():
        raise SystemExit("Run python scripts/build_decomp_fixtures.py first")
    suite = ROOT / "fixtures" / "decomp" / "probes.json"
    engine = GhidraAnalysis(ROOT / "decomp-state",
                            Path("/opt/ghidra/support/analyzeHeadless"))
    runner = NativeProbeRunner(engine, ROOT / "scripts" / "native_probe_adapter.py")
    report = runner.run_suite(manifest, suite)
    assert report["complete"] and report["counts"] == {"agreement": 8}, report["counts"]

    builds = json.loads(manifest.read_text())["builds"]
    shared = next(item for item in builds if item["kind"] == "shared" and
                  item["optimization"] == "O2")
    case = next(item for item in json.loads(suite.read_text())["cases"]
                if item["id"] == "fold_nonzero")
    discarded = NativeProbeRunner(
        engine, ROOT / "scripts" / "native_probe_discard_adapter.py").run_case(
            Path(shared["analysis_path"]), case)
    assert discarded["outcome"] == "disagreement"
    assert discarded["observed"] == {"return": 0}
    print(json.dumps({"real_cases": report["counts"],
                      "discarded_result": discarded["outcome"],
                      "report_artifact": report["artifact"]}, indent=2))


if __name__ == "__main__":
    main()
