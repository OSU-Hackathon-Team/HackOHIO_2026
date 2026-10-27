"""The published native spec: only publishable claim text may reach a spec writer.

The classification stage found that the deterministic spec fallback quoted claim statements
verbatim, so one claim whose wording tripped the published-text gate failed the whole spec
stage after a successful analysis run. Claim admission now uses the published-text rule, and
the fallback records why it was needed.
"""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.specification import (_synthesize_cleanroom_draft, generate_spec,  # noqa: E402
                                  prepare_handoff, validate_draft)

ENTRY, NAME = "00100000", "bc_add"
CLEAN = "Returns the sum of its two inputs."
REPORT_CARD = "Associates the provided stream with the buffer's data source field."


def claim(index: int, statement: str) -> dict:
    return {"subject": ENTRY, "claim_index": index, "statement": statement,
            "evidence": [{"artifact": "e" * 64, "address": ENTRY}],
            "reviews": [{"review_artifact": "r" * 64, "outcome": "supported_static",
                         "reason": "matches the evidence", "evidence_addresses": [ENTRY]}],
            "draft_artifact": "d" * 64, "review_state": "supported_static",
            "execution_state": "unmapped", "assumptions": [], "alternatives": []}


def dossier(claims: list[dict], exclusions: list[dict] | None = None) -> dict:
    return {
        "schema": 1, "campaign": "c" * 64, "binary_sha256": "b" * 64,
        "scope_artifact": "a" * 64, "scope_id": "5" * 64, "scope_revision": 1, "revision": 1,
        "readiness": "partial", "blockers": [],
        "scope": {"campaign": "c" * 64, "scope_id": "5" * 64, "revision": 1,
                  "request": {"query": "addition of two numbers", "mode": "subsystem",
                              "expected_observables": ["the sum"], "seeds": [NAME]},
                  "included": [{"entry": ENTRY, "name": NAME}], "unresolved": [],
                  "boundaries": [], "exclusions": exclusions or []},
        "functions": [{"subject": ENTRY, "name": NAME, "inputs": "two numbers",
                       "outputs": "the sum", "state": "none", "side_effects": "none",
                       "errors": "none"}],
        "claims": claims, "dependency_contracts": [], "uncovered_direct_calls": [],
        "independent_review_gaps": [], "probes": [],
    }


class HandoffAdmissionTests(unittest.TestCase):
    def test_unpublishable_claim_text_never_enters_the_handoff(self):
        source = dossier([claim(0, CLEAN), claim(1, REPORT_CARD)])
        handoff, audit = prepare_handoff(source, "a" * 64)
        self.assertEqual([item["statement"] for item in handoff["claims"]], [CLEAN])
        self.assertEqual([item["claim_index"] for item in audit["omitted_claims"]], [1])

    def test_the_fallback_quotes_only_admitted_claims(self):
        handoff, _ = prepare_handoff(dossier([claim(0, CLEAN), claim(1, REPORT_CARD)]), "a" * 64)
        draft = _synthesize_cleanroom_draft(handoff)["draft"]
        validate_draft(draft, handoff)
        self.assertEqual([item["statement"] for item in draft["requirements"]], [CLEAN])

    def test_the_fallback_omits_exclusions_it_cannot_publish(self):
        exclusions = [{"name": "ScMatrix::SubOp", "reason": "the subsystem boundary"},
                      {"name": None, "reason": "function budget"}]
        handoff, _ = prepare_handoff(dossier([claim(0, CLEAN)], exclusions), "a" * 64)
        draft = _synthesize_cleanroom_draft(handoff)["draft"]
        validate_draft(draft, handoff)
        self.assertEqual(draft["exclusions"],
                         ["Function boundary is excluded from the subsystem boundary "
                          "due to function budget."])


class FallbackReportingTests(unittest.TestCase):
    def test_an_unavailable_writer_is_recorded_with_its_reason(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("engine.specification.WRITER",
                       Path(folder) / "missing-tsx"):
                spec, audit = generate_spec(dossier([claim(0, CLEAN)]), "a" * 64)
        self.assertEqual(audit["model"], "cleanroom-spec-synthesizer")
        self.assertIn("unavailable", audit["writer_failure"])
        self.assertEqual(spec["status"], "draft")
        self.assertEqual(len(spec["requirements"]), 1)

    def test_the_spec_gate_still_refuses_report_text(self):
        handoff, _ = prepare_handoff(dossier([claim(0, CLEAN)]), "a" * 64)
        draft = _synthesize_cleanroom_draft(handoff)["draft"]
        draft["behavior_steps"] = ["Copy the vtable pointer into the object."]
        with self.assertRaises(ValueError):
            validate_draft(draft, handoff)


if __name__ == "__main__":
    unittest.main()
