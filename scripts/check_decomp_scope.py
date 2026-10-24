"""Check subsystem expansion against source-known state and callback relationships."""

from dataclasses import replace
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.models import ScopeRequest  # noqa: E402
from engine.scope import persist_scope  # noqa: E402


def main() -> None:
    fixture = ROOT / "decomp-state" / "fixtures" / "native_lab_O2_shared.so"
    if not fixture.exists():
        raise SystemExit("Run python scripts/build_decomp_fixtures.py first")
    engine = GhidraAnalysis(ROOT / "decomp-state",
                            Path("/opt/ghidra/support/analyzeHeadless"))
    manifest = engine.analyze(fixture)
    request = ScopeRequest.from_dict(json.loads(
        (ROOT / "fixtures" / "decomp" / "scope_request.json").read_text()))
    scope = persist_scope(engine, manifest, request)
    repeated = persist_scope(engine, manifest, request)
    assert scope["artifact"] == repeated["artifact"] and scope["revision"] == repeated["revision"]
    names = {item["name"] for item in scope["included"]}
    assert {"parse_frame", "reset_state", "read_total", "read_accepted", "read_last"} <= names
    assert len(scope["tasks"]) == len(scope["included"])
    assert len({task["deduplication_key"] for task in scope["tasks"]}) == len(scope["tasks"])
    assert all(not item["name"].startswith("FUN_") for item in scope["included"])
    assert any(edge["kind"] == "indirect_call" for edge in scope["unresolved"])
    assert any(item.get("contract") == "thunk alias" for item in scope["boundaries"])

    contracted = persist_scope(engine, manifest, replace(
        request, boundary_contracts={"reset_state": "resets all counters to zero"}))
    assert "reset_state" not in {item["name"] for item in contracted["included"]}
    assert any(item.get("contract") == "resets all counters to zero"
               for item in contracted["boundaries"])

    limited = persist_scope(engine, manifest, replace(request, max_functions=2))
    assert len(limited["included"]) <= 2
    assert limited["readiness"] == "partial"
    assert any(edge["kind"] == "function_budget_exhausted" for edge in limited["unresolved"])
    print(json.dumps({"scope": scope["scope_id"], "included": sorted(names),
                      "unresolved": scope["unresolved"],
                      "budget_unresolved": limited["unresolved"]}, indent=2))


if __name__ == "__main__":
    main()
