"""Reject compiler mechanics as functional claims while allowing honest unknowns."""

from __future__ import annotations

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.worker import normalize_answer_claims, validate_answer


def answer(statement: str | None) -> dict:
    return {"inputs": "one source value", "outputs": "a copy of the value",
            "state": "none known", "side_effects": "none known",
            "errors": "unknown", "pseudocode": "copy source value",
            "claims": ([{"statement": statement,
                        "evidence_addresses": ["00100000"],
                        "assumptions": [], "alternatives": []}]
                       if statement is not None else []),
            "dependencies": [], "unknowns": ["Constructor effects are unknown"],
            "evidence_requests": ["Inspect the constructor and probe copies"]}


evidence = {"entry": "00100000", "instructions": [{"address": "00100000"}],
            "references": []}
for statement in (
    "The function requests allocation of exactly 0x28 bytes.",
    "The allocated object is passed to the constructor.",
    "The vtable pointer is copied from the source.",
    "Returns 1 when the field at object offset 8 is nonzero.",
    "Traverses a pointer array with reference counting.",
):
    assert validate_answer(answer(statement), evidence)
assert not validate_answer(answer("A copied value preserves its visible text."), evidence)
assert not validate_answer(answer(None), evidence)
parameterized = answer("When param_1 is true and param_2 is false, returns 7.")
assert normalize_answer_claims(parameterized)
assert parameterized["claims"][0]["statement"] == (
    "When input 1 is true and input 2 is false, returns 7.")
assert not validate_answer(parameterized, evidence)
numeric = answer("Returns 1 for grammar identifier 0x20003.")
assert normalize_answer_claims(numeric)
assert numeric["claims"][0]["statement"] == "Returns 1 for grammar identifier 131075."
assert not validate_answer(numeric, evidence)
assert any("disagrees" in item for item in validate_answer(
    answer("Sets bit 25 (16777216) in the result."), evidence))
print("semantic quality checks passed")
