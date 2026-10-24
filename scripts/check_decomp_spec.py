"""Check the dossier-to-spec handoff with real artifact assembly and CLI persistence."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.dossier import assemble, canonical  # noqa: E402
from engine.specification import generate_spec, persist_spec  # noqa: E402


def put(store: LocalArtifactStore, value: dict) -> str:
    return store.put(canonical(value))


def main() -> None:
    with TemporaryDirectory(prefix="decomp-spec-check-") as temporary:
        state = Path(temporary)
        store = LocalArtifactStore(state / "artifacts")
        campaign, binary = "c" * 64, "b" * 64
        manifest = {"campaign": campaign, "binary_sha256": binary}
        scope = {"campaign": campaign, "scope_id": "a" * 64, "revision": 2,
                 "included": [{"entry": "00100000", "name": "count"}],
                 "unresolved": [{"kind": "indirect_call", "site": "00100003"},
                                {"kind": "unassigned_executable_instructions",
                                 "instructions": 2, "instruction_bytes": 10,
                                 "regions": [{"start": "00100020", "end": "00100029",
                                              "instructions": 2, "instruction_bytes": 10}]}],
                 "request": {"query": "counter", "mode": "subsystem",
                             "seeds": ["count"],
                             "expected_observables": ["counter changes"]},
                 "boundaries": [], "exclusions": []}
        scope_artifact = put(store, scope)
        evidence_artifact = put(store, {"entry": "00100000", "references": [],
                                        "instructions": [{"address": "00100000",
                                                          "text": "INC"}]})
        draft = {"campaign": campaign, "subject": "00100000", "state": "unreviewed",
                 "scope_artifact": scope_artifact, "evidence_artifact": evidence_artifact,
                 "answer": {"inputs": "none", "outputs": "counter", "state": "counter",
                            "side_effects": "increments", "errors": "none",
                            "pseudocode": "counter += 1", "unknowns": ["overflow"],
                            "evidence_requests": [], "dependencies": [],
                            "claims": [{"statement": "increments once",
                                        "evidence_addresses": ["00100000"],
                                        "assumptions": [], "alternatives": []},
                                       {"statement": "never overflows",
                                        "evidence_addresses": ["00100000"],
                                        "assumptions": [], "alternatives": []}]}}
        draft_artifact = put(store, draft)
        review = {"draft_artifact": draft_artifact, "state": "reviewed",
                  "model": "independent-reviewer",
                  "answer": {"reviews": [
                      {"claim_index": 0, "outcome": "supported_static",
                       "reason": "instruction", "evidence_addresses": ["00100000"]},
                      {"claim_index": 1, "outcome": "uncertain",
                       "reason": "width unknown", "evidence_addresses": ["00100000"]}],
                      "missing_behavior": ["overflow path"], "unresolved": []}}
        review_artifact = put(store, review)
        probe = {"binary_sha256": binary, "case_id": "increment", "target": "count",
                 "kind": "shared", "input": {"value": 0},
                 "expected": {"value": 1}, "observed": {"value": 1},
                 "outcome": "agreement", "execution_mode": "original"}
        report_artifact = put(store, {"schema": 1, "results": [
            {**probe, "artifact": put(store, probe)}]})
        link_artifact = put(store, {"schema": 1, "links": [{
            "draft_artifact": draft_artifact, "claim_index": 0,
            "probe_report_artifact": report_artifact, "case_id": "increment",
            "observed_pointer": "/value", "expected_observed": 1,
            "rationale": "original result"}]})
        dossier = assemble(SimpleNamespace(store=store), manifest, scope_artifact,
                           [draft_artifact], [review_artifact], [report_artifact],
                           [link_artifact])
        dossier["revision"] = 1
        dossier_artifact = put(store, dossier)
        spec = generate_spec(dossier, dossier_artifact)
        assert spec["status"] == "partial"
        assert len(spec["requirements"]) == 1
        assert spec["requirements"][0]["statement"] == "increments once"
        assert spec["requirements"][0]["execution_state"] == "case_agreement"
        assert spec["requirements"][0]["evidence"][0]["artifact"] == evidence_artifact
        assert [c["statement"] for c in spec["unresolved_claims"]] == ["never overflows"]
        assert any(b["kind"] == "independent_review_gaps" for b in spec["blockers"])
        assert spec["boundary"]["expected_observables_to_investigate"] == ["counter changes"]
        assert any(edge["kind"] == "unassigned_executable_instructions"
                   for edge in spec["boundary"]["unresolved_edges"])
        assert spec["provenance"]["analysis"]["reviews"][0]["model"] == "independent-reviewer"
        ambiguous = {**dossier, "draft_artifacts": [draft_artifact, "f" * 64],
                     "functions": [*dossier["functions"],
                                   {**dossier["functions"][0], "draft_artifact": "f" * 64}]}
        ambiguous_spec = generate_spec(ambiguous, dossier_artifact)
        assert ambiguous_spec["requirements"] == []
        assert len(ambiguous_spec["unresolved_claims"]) == 2
        assert all(item["reason"] == "multiple_drafts_for_subject"
                   for item in ambiguous_spec["unresolved_claims"])
        first = persist_spec(state, dossier_artifact)
        second = persist_spec(state, dossier_artifact)
        assert first == second
        persisted = json.loads(store.get(first["artifact"]))
        assert persisted == spec
        markdown = Path(first["markdown_path"]).read_text()
        assert "never overflows" in markdown and "increments once" in markdown
        assert dossier_artifact in markdown and "counter changes" in markdown
        try:
            generate_spec({**dossier, "schema": 99}, dossier_artifact)
        except ValueError:
            pass
        else:
            raise AssertionError("unsupported dossier schema accepted")
        try:
            generate_spec({key: value for key, value in dossier.items()
                           if key != "independent_review_gaps"}, dossier_artifact)
        except ValueError as error:
            assert "independent_review_gaps" in str(error)
        else:
            raise AssertionError("legacy dossier with missing review gaps accepted")
        print(json.dumps({"status": spec["status"], "requirements": 1,
                          "withheld_claims": 1, "artifact": first["artifact"]}))


if __name__ == "__main__":
    main()
