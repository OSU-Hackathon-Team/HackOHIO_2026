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
        draft = {"campaign": campaign, "subject": "00100000", "state": "unreviewed",
                 "scope_artifact": scope_artifact, "evidence_artifact": "e" * 64,
                 "answer": {"inputs": "none", "outputs": "counter", "state": "counter",
                            "side_effects": "increments", "errors": "none",
                            "pseudocode": "counter += 1", "unknowns": [],
                            "dependencies": [], "claims": [{"statement": "increments once",
                                                         "evidence_addresses": ["00100000"],
                                                         "assumptions": [],
                                                         "alternatives": []}]}}
        draft_artifact = put(store, draft)
        review = {"draft_artifact": draft_artifact, "state": "reviewed",
                  "answer": {"reviews": [{"claim_index": 0,
                                          "outcome": "supported_static", "reason": "instruction",
                                          "evidence_addresses": ["00100000"]}]}}
        review_artifact = put(store, review)
        report = {"results": [{"binary_sha256": binary, "case_id": "increment",
                               "kind": "shared", "input": {}, "expected": {"count": 1},
                               "observed": {"count": 1}, "outcome": "agreement",
                               "artifact": "p" * 64}]}
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
        print(json.dumps({"agreement": "case_agreement",
                          "tampered_expected": "case_disagreement",
                          "missing_field": "rejected"}))


if __name__ == "__main__":
    main()
