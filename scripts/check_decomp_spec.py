"""Offline cleanroom handoff regression: readiness, containment, and persistence."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.dossier import canonical  # noqa: E402
from engine.specification import generate_spec, persist_spec  # noqa: E402


def fixture() -> dict:
    digest = lambda char: char * 64
    claim = {
        "subject": "00100000", "draft_artifact": digest("d"), "claim_index": 0,
        "statement": "The counter increases by one for each accepted input.",
        "review_state": "supported_static", "execution_state": "case_agreement",
        "evidence": [{"artifact": digest("e"), "address": "00100000"}],
        "reviews": [{"artifact": digest("f"), "outcome": "supported_static"}],
        "probe_links": [{"case_id": "once", "agreement": True}],
    }
    return {
        "schema": 1, "campaign": digest("c"), "binary_sha256": digest("b"),
        "scope_id": digest("a"), "scope_revision": 1, "scope_artifact": digest("s"),
        "revision": 1, "readiness": "ready_for_spec", "blockers": [],
        "scope": {
            "campaign": digest("c"), "scope_id": digest("a"), "revision": 1,
            "request": {"query": "counter", "mode": "subsystem",
                        "expected_observables": ["counter changes"]},
            "included": [{"entry": "00100000", "name": "count"}],
            "unresolved": [], "exclusions": [],
        },
        "functions": [{
            "subject": "00100000", "inputs": "accepted input", "outputs": "count",
            "state": "counter", "side_effects": "counter changes", "errors": "none",
            "pseudocode": "counter += 1; // never publish this",
        }],
        "claims": [claim], "dependency_contracts": [], "uncovered_direct_calls": [],
        "independent_review_gaps": [],
        "probes": [{"case_id": "once", "outcome": "observed",
                    "input": {"value": 1}, "observed": {"count": 1}}],
        "coverage": {"claims": 1},
    }


def writer(handoff: dict) -> dict:
    assert "pseudocode" not in json.dumps(handoff)
    assert "00100000" not in json.dumps(handoff)
    return {"model": "test-writer", "draft": {
        "title": "Counter behavior", "purpose": "Count accepted inputs.",
        "interface": {"inputs": ["An accepted input event."],
                      "outputs": ["The updated count."],
                      "state": ["The count starts at zero."]},
        "requirements": [{"id": "REQ-1",
                          "statement": "Each accepted input increases the count by one.",
                          "claim_ids": ["C1"]}],
        "behavior_steps": ["Update the count for each accepted input."],
        "acceptance_criteria": ["One accepted input produces a count of one."],
        "deviations": [], "exclusions": [],
    }}


def rejected(action) -> None:
    try:
        action()
    except ValueError:
        return
    raise AssertionError("unsafe or incomplete specification was accepted")


def main() -> None:
    dossier = fixture()
    partial = {**dossier, "readiness": "partial",
               "blockers": [{"kind": "claims_not_linked_to_original_probes", "count": 1}],
               "claims": [{**dossier["claims"][0], "execution_state": "unmapped",
                           "probe_links": []}], "probes": []}
    draft, draft_audit = generate_spec(partial, "0" * 64, writer=writer)
    assert draft["status"] == "draft" and draft["examples"] == []
    assert draft_audit["blockers"] == partial["blockers"]
    structural = {**partial, "claims": [{**partial["claims"][0],
                  "statement": "Spans 17 static instructions with 3 recorded references."}]}
    empty, empty_audit = generate_spec(structural, "0" * 64, writer=writer)
    assert empty["status"] == "draft" and empty["requirements"] == []
    assert len(empty_audit["omitted_claims"]) == 1
    source_shaped = {**partial, "claims": [{**partial["claims"][0],
                     "statement": "MOVAPS updates RDI at 0x00104040"}]}
    sanitized, sanitized_audit = generate_spec(source_shaped, "0" * 64, writer=writer)
    assert sanitized["requirements"] == [] and len(sanitized_audit["omitted_claims"]) == 1
    compiler_only_gap = {**dossier, "readiness": "partial",
                         "blockers": [{"kind": "claims_not_linked_to_original_probes", "count": 1}],
                         "claims": [dossier["claims"][0], structural["claims"][0]]}
    functional, functional_audit = generate_spec(compiler_only_gap, "0" * 64, writer=writer)
    assert functional["status"] == "ready_for_review"
    assert len(functional["requirements"]) == 1
    assert len(functional_audit["omitted_claims"]) == 1
    observed = {**dossier, "claims": [{**dossier["claims"][0], "probe_links": [
        {"report_artifact": "r" * 64, "case_id": "once", "agreement": True}]}],
        "probes": [
            {"report_artifact": "r" * 64, "case_id": "once",
             "outcome": "observed", "execution_mode": "original",
             "input": {"value": 1}, "observed": {"count": 1}},
            {"report_artifact": "r" * 64, "case_id": "held-out",
             "outcome": "observed", "execution_mode": "original",
             "input": {"value": 2}, "observed": {"count": 2}}]}
    observed_spec, _ = generate_spec(observed, "0" * 64, writer=writer)
    assert observed_spec["status"] == "ready_for_review"
    assert [item["name"] for item in observed_spec["examples"]] == ["once"]
    authored = {**observed, "probes": [{**observed["probes"][0],
        "outcome": "agreement", "expected": {"count": 1}}]}
    authored_spec, _ = generate_spec(authored, "0" * 64, writer=writer)
    assert authored_spec["status"] == "draft" and authored_spec["examples"] == []
    spec, audit = generate_spec(dossier, "0" * 64, writer=writer)
    assert spec["schema"] == 2 and spec["status"] == "ready_for_review"
    assert "pseudocode" not in json.dumps(spec)
    assert "00100000" not in json.dumps(spec)
    assert audit["claim_sources"]["C1"]["evidence"][0]["address"] == "00100000"
    def leaky(_):
        result = writer({})
        result["draft"]["behavior_steps"] = ["MOVAPS XMM0, [0x00100000]"]
        return result
    rejected(lambda: generate_spec(dossier, "0" * 64, writer=leaky))
    unsafe_case = {**dossier, "probes": [{**dossier["probes"][0],
        "input": {"source": "function secret() { return 1; }"}}]}
    rejected(lambda: generate_spec(unsafe_case, "0" * 64, writer=writer))
    with TemporaryDirectory() as temporary:
        state = Path(temporary)
        store = LocalArtifactStore(state / "artifacts")
        source = store.put(canonical(dossier))
        first = persist_spec(state, source, writer=writer)
        second = persist_spec(state, source, writer=lambda _: 1 / 0)
        assert first == second
        public = json.loads(store.get(first["artifact"]))
        private = json.loads(store.get(first["audit_artifact"]))
        assert public == spec and private["dossier_artifact"] == source
        markdown = Path(first["markdown_path"]).read_text()
        assert "REQ-1" in markdown and "MOVAPS" not in markdown
        assert "pseudocode" not in markdown and "00100000" not in markdown
        partial_source = store.put(canonical(partial))
        partial_pointer = persist_spec(state, partial_source, writer=writer)
        assert partial_pointer["status"] == "draft"
        assert persist_spec(state, partial_source, writer=lambda _: 1 / 0) == partial_pointer
    print(json.dumps({"status": spec["status"], "requirements": 1}))


if __name__ == "__main__":
    main()
