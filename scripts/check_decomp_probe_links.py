"""Exercise probe case linkage, disagreement, and invalid observation paths."""

import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.dossier import assemble  # noqa: E402


def put(store: LocalArtifactStore, data: dict) -> str:
    return store.put(json.dumps(data, sort_keys=True).encode())


def main() -> None:
    with TemporaryDirectory() as temporary:
        store = LocalArtifactStore(Path(temporary))
        engine = SimpleNamespace(store=store)
        campaign = "c" * 64
        binary = "b" * 64
        manifest = {"campaign": campaign, "binary_sha256": binary}
        scope = {"campaign": campaign, "scope_id": "s" * 64, "revision": 1,
                 "included": [{"entry": "00100000", "name": "count"}],
                 "unresolved": [], "request": {"query": "count calls", "mode": "subsystem",
                                               "seeds": ["count"],
                                               "expected_observables": []},
                 "boundaries": []}
        scope_artifact = put(store, scope)
        evidence_artifact = put(store, {"entry": "00100000", "references": [],
                                        "instructions": [{"address": "00100000",
                                                          "text": "RET"}]})
        draft = {"campaign": campaign, "subject": "00100000", "state": "unreviewed",
                 "scope_artifact": scope_artifact, "evidence_artifact": evidence_artifact,
                 "answer": {"inputs": "none", "outputs": "counter", "state": "counter",
                            "side_effects": "increments", "errors": "none",
                            "pseudocode": "counter += 1", "unknowns": [],
                            "dependencies": [], "claims": [{"statement": "increments once",
                                                         "evidence_addresses": ["00100000"],
                                                         "assumptions": [],
                                                         "alternatives": []}]}}
        draft_artifact = put(store, draft)
        review = {"draft_artifact": draft_artifact, "state": "reviewed",
                  "model": "review-model",
                  "answer": {"reviews": [{"claim_index": 0,
                                          "outcome": "supported_static", "reason": "instruction",
                                          "evidence_addresses": ["00100000"]}]}}
        review_artifact = put(store, review)
        probe_record = {"binary_sha256": binary, "case_id": "increment",
                        "target": "count", "kind": "shared", "input": {},
                        "expected": {"count": 1}, "observed": {"count": 1},
                        "outcome": "agreement", "execution_mode": "original",
                        "runner_sha256": "r" * 64, "adapter_sha256": "a" * 64}
        report = {"schema": 1, "results": [{**probe_record,
                   "artifact": put(store, probe_record)}]}
        report_artifact = put(store, report)
        link = {"draft_artifact": draft_artifact, "claim_index": 0,
                "probe_report_artifact": report_artifact, "case_id": "increment",
                "observed_pointer": "/count", "expected_observed": 1,
                "rationale": "original counter was one"}

        def dossier(item: dict) -> dict:
            artifact = put(store, {"schema": 1, "links": [item]})
            return assemble(engine, manifest, scope_artifact, [draft_artifact],
                            [review_artifact], [report_artifact], [artifact])

        agreed = dossier(link)
        assert agreed["claims"][0]["execution_state"] == "case_agreement"
        assert agreed["coverage"]["claims_with_case_agreement"] == 1
        repeat_report = put(store, {**report, "repeat": True})
        repeated = assemble(engine, manifest, scope_artifact, [draft_artifact],
                            [review_artifact], [report_artifact, repeat_report])
        assert repeated["coverage"]["original_probe_runs"] == 2
        assert repeated["coverage"]["original_probe_cases"] == 1
        assert repeated["coverage"]["original_probe_agreements"] == 1
        disputed_case = {**probe_record, "observed": {"count": 2},
                         "outcome": "disagreement"}
        disputed_report = put(store, {"schema": 1, "results": [
            {**disputed_case, "artifact": put(store, disputed_case)}]})
        disputed = assemble(engine, manifest, scope_artifact, [draft_artifact],
                            [review_artifact], [report_artifact, disputed_report])
        assert disputed["coverage"]["original_probe_cases"] == 1
        assert disputed["coverage"]["original_probe_agreements"] == 0
        flagged_review = {**review, "answer": {**review["answer"],
                           "missing_behavior": ["check decrement path"]}}
        flagged = assemble(engine, manifest, scope_artifact, [draft_artifact],
                           [put(store, flagged_review)], [report_artifact])
        assert flagged["coverage"]["independent_review_gaps"] == 1
        assert any(item["kind"] == "independent_review_gaps"
                   for item in flagged["blockers"])
        flagged_review_artifact = put(store, flagged_review)
        adjudication = {"state": "reviewed", "structural_errors": [],
                        "campaign": campaign, "draft_artifact": draft_artifact,
                        "review_artifact": flagged_review_artifact,
                        "evidence_artifact": evidence_artifact,
                        "probe_report_artifact": report_artifact,
                        "probe_case_ids": ["increment"], "model": "other-model",
                        "answer": {"items": [{"kind": "missing_behavior", "index": 0,
                                              "decision": "nonblocking",
                                              "reason": "Decrement is outside this function",
                                              "evidence_addresses": ["00100000"],
                                              "probe_case_ids": ["increment"]}]}}
        adjudication_artifact = put(store, adjudication)
        adjudicated = assemble(
            engine, manifest, scope_artifact, [draft_artifact],
            [flagged_review_artifact], [report_artifact],
            gap_adjudication_artifacts=[adjudication_artifact])
        assert adjudicated["coverage"]["blocking_review_gaps"] == 0
        assert not any(item["kind"] == "independent_review_gaps"
                       for item in adjudicated["blockers"])
        try:
            assemble(engine, manifest, scope_artifact, [draft_artifact],
                     [flagged_review_artifact], [report_artifact],
                     gap_adjudication_artifacts=[put(store, {**adjudication,
                         "model": "review-model"})])
        except ValueError:
            pass
        else:
            raise AssertionError("same-model gap adjudication was accepted")
        disagreed = dossier({**link, "expected_observed": 2})
        assert disagreed["claims"][0]["execution_state"] == "case_disagreement"
        assert any(item["kind"] == "claim_probe_disagreements"
                   for item in disagreed["blockers"])
        try:
            dossier({**link, "observed_pointer": "/missing"})
        except ValueError:
            pass
        else:
            raise AssertionError("missing observation field was accepted")
        try:
            dossier({**link, "specified_artifact": "s" * 64})
        except ValueError:
            pass
        else:
            raise AssertionError("human-specified expectation was accepted")
        print(json.dumps({"agreement": "case_agreement",
                          "tampered_expected": "case_disagreement",
                          "missing_field": "rejected",
                          "specified_expectation": "rejected"}))


if __name__ == "__main__":
    main()
