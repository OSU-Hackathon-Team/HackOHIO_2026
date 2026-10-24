"""Cold and warm Ghidra integration check on stripped executable and library fixtures."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.validation.review import review_prompt  # noqa: E402
from engine.worker import prompt_for  # noqa: E402


def main() -> None:
    fixture_manifest = ROOT / "decomp-state" / "fixtures" / "manifest.json"
    if not fixture_manifest.exists():
        raise SystemExit("Run python scripts/build_decomp_fixtures.py first")
    builds = json.loads(fixture_manifest.read_text())["builds"]
    headless = Path("/opt/ghidra/support/analyzeHeadless")
    with tempfile.TemporaryDirectory(prefix="decomp-check-", dir=ROOT / "decomp-state") as scratch:
        engine = GhidraAnalysis(Path(scratch), headless)
        report = []
        for build in builds:
            if build["optimization"] != "O2":
                continue
            manifest = engine.analyze(Path(build["analysis_path"]))
            again = engine.analyze(Path(build["analysis_path"]))
            assert again["index_artifact"] == manifest["index_artifact"]
            inventory = engine.export_all(manifest)
            assert inventory["complete"], inventory["counts"]
            assert len(inventory["functions"]) == manifest["function_count"]
            index = engine.index(manifest)
            inventory_summary = index["static_inventory"]
            assert inventory_summary["executable_bytes"] > 0
            assert inventory_summary["assigned_instructions"] > 0
            assert (inventory_summary["unassigned_instructions"] ==
                    sum(region["instructions"] for region in
                        index["unassigned_instruction_regions"]))
            assert all(region["start"] <= region["end"] for region in
                       index["unassigned_instruction_regions"])
            assert index["executable_regions"]
            assert inventory["static_inventory"] == inventory_summary
            assert inventory["unassigned_instruction_regions"] == index[
                "unassigned_instruction_regions"]
            symbols = subprocess.check_output(["nm", "-n", build["debug_path"]], text=True)
            symbol_address = next(int(line.split()[0], 16) for line in symbols.splitlines()
                                  if line.split()[-1] == "parse_frame")
            possible_entries = {symbol_address,
                                int(index["image_base"], 16) + symbol_address}
            candidates = [item for item in index["functions"]
                          if int(item["entry"], 16) in possible_entries and not item["thunk"]]
            assert candidates, "parse_frame address from evaluator debug symbols was not discovered"
            evidence = [engine.function(manifest, item["entry"]) for item in candidates]
            assert any(item["status"] == "ok" and item["decompilation"] and
                       item["instructions"] for item in evidence)
            parsed = next(item for item in evidence if item["status"] == "ok")
            assert parsed["listing_parameters"] == []
            assert len(parsed["decompiler_prototype"]["parameters"]) == 4
            assert parsed["decompiler_signature"]
            assert any(item["status"] == "defined" for item in parsed["referenced_data"])
            context = {"request": {"query": "parse a frame", "expected_observables": []},
                       "included": [{"entry": parsed["entry"], "name": "parse_frame"}],
                       "boundaries": []}
            work_prompt, truncated = prompt_for({"question": "Explain parse_frame"}, context,
                                                parsed, max_evidence_bytes=60000)
            assert not truncated and "decompiler_prototype" in work_prompt
            assert "referenced_data" in work_prompt
            review = review_prompt({"answer": {"claims": []}}, parsed, context)
            assert "decompiler_prototype" in review and "referenced_data" in review
            repeated = engine.export_all(manifest)
            assert repeated["functions"] == inventory["functions"]
            report.append({"kind": build["kind"], "functions": len(inventory["functions"]),
                           "artifact": inventory["artifact"]})
        events = [json.loads(line) for line in (Path(scratch) / "progress.jsonl").read_text().splitlines()]
        assert sum(item["stage"] == "indexed" for item in events) == 2
        assert sum(item["stage"] == "bulk_export_finished" for item in events) == 2
        assert sum(item["stage"] == "function_exported" for item in events) == sum(
            item["functions"] for item in report)
        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
