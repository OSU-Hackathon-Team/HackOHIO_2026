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
        "probes": [{"case_id": "once", "outcome": "agreement",
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
    rejected(lambda: generate_spec({**dossier, "readiness": "partial",
                                    "blockers": [{"kind": "missing_case"}]},
                                   "0" * 64, writer=writer))
    rejected(lambda: generate_spec({**dossier, "claims": [{
        **dossier["claims"][0], "execution_state": "unmapped"}]},
        "0" * 64, writer=writer))
    rejected(lambda: generate_spec({**dossier, "claims": [{
        **dossier["claims"][0], "statement": "MOVAPS updates RDI at 0x00104040"}]},
        "0" * 64, writer=writer))
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
    print(json.dumps({"status": spec["status"], "requirements": 1}))


if __name__ == "__main__":
    main()
