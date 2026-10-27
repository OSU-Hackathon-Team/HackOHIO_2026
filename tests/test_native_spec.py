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
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.specification import (_synthesize_cleanroom_draft, assemble_parts,  # noqa: E402
                                  generate_spec, prepare_handoff, spec_parts,
                                  validate_draft)

ENTRY, NAME = "00100000", "bc_add"
FUNCTIONS = [("00100010", "bc_parse"), ("00100020", "bc_add"), ("00100030", "bc_out")]
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


def multi_dossier(count: int = 5, functions: list[tuple[str, str]] | None = None) -> dict:
    """A subsystem with several functions, so claims can be split across parts."""
    functions = functions or FUNCTIONS
    claims = []
    for index in range(count):
        entry, _ = functions[index % len(functions)]
        item = claim(index, f"Behaves in observable way number {index}.")
        item["subject"] = entry
        claims.append(item)
    base = dossier(claims)
    base["scope"]["included"] = [{"entry": entry, "name": name} for entry, name in functions]
    base["functions"] = [{"subject": entry, "name": name, "inputs": "an input",
                          "outputs": "a result", "state": "none", "side_effects": "none",
                          "errors": "none"} for entry, name in functions]
    return base


class SpecPartTests(unittest.TestCase):
    def test_a_small_handoff_stays_one_part(self):
        handoff, _ = prepare_handoff(multi_dossier(3), "a" * 64)
        self.assertEqual(spec_parts(handoff), [handoff])

    def test_claims_are_partitioned_once_each_and_keep_their_global_ids(self):
        handoff, _ = prepare_handoff(multi_dossier(5), "a" * 64)
        parts = spec_parts(handoff, size=2)
        ids = [item["id"] for part in parts for item in part["claims"]]
        self.assertEqual(ids, [item["id"] for item in handoff["claims"]])
        for part in parts:
            self.assertEqual(part["part"]["count"], 3)
            named = {item["function"] for item in part["claims"]}
            self.assertTrue({item["name"] for item in part["functions"]} <= {f[1] for f in FUNCTIONS})
            self.assertTrue(named)  # functions are restricted to the part's own claims
            self.assertEqual(part["feature"], handoff["feature"])
            self.assertEqual(part["original_examples"], handoff["original_examples"])

    def test_assembly_renumbers_requirements_and_merges_repeated_sections(self):
        draft = {"title": "Whole subsystem", "purpose": "Describe it.",
                 "interface": {"inputs": ["An input."], "outputs": ["A result."],
                               "state": ["Nothing."]},
                 "behavior_steps": ["Evaluate the expression."],
                 "acceptance_criteria": ["Compare the printed result."],
                 "deviations": [], "exclusions": []}
        first = {**draft, "requirements": [
            {"id": "REQ-1", "statement": "First.", "claim_ids": ["C1"]},
            {"id": "REQ-2", "statement": "Second.", "claim_ids": ["C2"]}]}
        second = {**draft, "purpose": "Secondary wording.",
                  "requirements": [{"id": "REQ-1", "statement": "Third.", "claim_ids": ["C3"]}]}
        assembled = assemble_parts([first, second])
        self.assertEqual([item["id"] for item in assembled["requirements"]],
                         ["REQ-1", "REQ-2", "REQ-3"])
        self.assertEqual([item["statement"] for item in assembled["requirements"]],
                         ["First.", "Second.", "Third."])
        self.assertEqual(assembled["interface"]["inputs"], ["An input."])
        self.assertEqual(assembled["behavior_steps"], ["Evaluate the expression."])
        self.assertEqual(assembled["title"], "Whole subsystem")
        self.assertEqual(assembled["purpose"], "Describe it.")  # the larger part carries the prose

    def test_assembly_refuses_a_claim_specified_twice(self):
        draft = {"title": "T", "purpose": "P",
                 "interface": {"inputs": ["i"], "outputs": ["o"], "state": ["s"]},
                 "behavior_steps": ["b"], "acceptance_criteria": ["a"],
                 "deviations": [], "exclusions": []}
        twice = {**draft, "requirements": [
            {"id": "REQ-1", "statement": "Once.", "claim_ids": ["C1"]},
            {"id": "REQ-2", "statement": "Twice.", "claim_ids": ["C1"]}]}
        with self.assertRaises(ValueError):
            assemble_parts([twice])


class SpecPartWriterTests(unittest.TestCase):
    def _writer(self, seen: list, fails: tuple[int, ...] = ()):
        def run(command, **kwargs):
            part = json.loads(kwargs["input"])
            seen.append(part)
            if part["part"]["index"] in fails:
                return SimpleNamespace(returncode=1, stderr="stub failure", stdout="")
            claims = part["claims"]
            draft = {"title": "Whole subsystem", "purpose": "Describe it.",
                     "interface": {"inputs": ["An input."], "outputs": ["A result."],
                                   "state": ["Nothing."]},
                     "requirements": [{"id": f"REQ-{index + 1}",
                                       "statement": f"Part statement {index + 1}.",
                                       "claim_ids": [claim["id"]]}
                                      for index, claim in enumerate(claims)],
                     "behavior_steps": ["Evaluate the expression."],
                     "acceptance_criteria": ["Compare the printed result."],
                     "deviations": [], "exclusions": []}
            return SimpleNamespace(returncode=0, stderr="",
                                   stdout=json.dumps({"draft": draft, "model": "stub-writer"}))
        return run

    def test_every_part_is_written_and_the_assembled_spec_covers_every_claim(self):
        seen: list = []
        with patch("engine.specification.WRITER", Path(__file__)), \
                patch("engine.specification.SCRIPT", Path(__file__)), \
                patch("engine.specification.subprocess.run", self._writer(seen)):
            spec, audit = generate_spec(multi_dossier(25), "a" * 64)
        self.assertEqual(len(seen), 2)
        self.assertEqual([part["part"]["index"] for part in seen], [1, 2])
        self.assertEqual([len(part["claims"]) for part in seen], [20, 5])
        self.assertEqual(audit["spec_parts"], 2)
        self.assertEqual(audit["model"], "stub-writer")
        self.assertEqual(len(spec["requirements"]), 25)
        self.assertEqual([item["id"] for item in spec["requirements"]][:3],
                         ["REQ-1", "REQ-2", "REQ-3"])
        self.assertEqual(spec["interface"]["inputs"], ["An input."])
        self.assertEqual(spec["status"], "draft")

    def test_a_failed_part_keeps_the_parts_the_writer_delivered(self):
        seen: list = []
        with patch("engine.specification.WRITER", Path(__file__)), \
                patch("engine.specification.SCRIPT", Path(__file__)), \
                patch("engine.specification.subprocess.run", self._writer(seen, fails=(2,))):
            spec, audit = generate_spec(multi_dossier(25), "a" * 64)
        self.assertEqual(len(seen), 2)
        self.assertEqual(audit["model"], "stub-writer")
        self.assertEqual(audit["spec_part_fallbacks"], [2])
        self.assertIn("part 2 of 2", audit["writer_failure"])
        self.assertEqual(len(spec["requirements"]), 25)  # every claim still has a requirement
        self.assertEqual(spec["requirements"][0]["statement"], "Part statement 1.")
        # The failed part quotes its claims, because no writer text exists for them.
        self.assertEqual(spec["requirements"][20]["statement"],
                         "Behaves in observable way number 20.")

    def test_when_no_part_is_written_the_whole_spec_falls_back(self):
        seen: list = []
        with patch("engine.specification.WRITER", Path(__file__)), \
                patch("engine.specification.SCRIPT", Path(__file__)), \
                patch("engine.specification.subprocess.run", self._writer(seen, fails=(1, 2))):
            spec, audit = generate_spec(multi_dossier(25), "a" * 64)
        self.assertEqual(audit["model"], "cleanroom-spec-synthesizer")
        self.assertIn("part 1 of 2", audit["writer_failure"])
        self.assertEqual(len(spec["requirements"]), 25)


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
