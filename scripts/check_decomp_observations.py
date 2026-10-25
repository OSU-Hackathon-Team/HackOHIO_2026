"""Check invariant induction on a synthetic interface with hidden state."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.observations import (derive_effects, derive_invariants, describe,
                                 describe_effects)

LABELS = ["nonempty", "has_a", "has_b"]

# Operation codes: 1 append (argument), 2 query-only no-op, 3 reset, 4 seal
# (a later append is invisible), 6 prune (sometimes drops a column).
CASES = [
    {"id": "case-empty", "labels": LABELS, "steps": [], "rows": [[0, 0, 0]]},
    {"id": "case-append", "labels": LABELS,
     "steps": [[1, "a"]], "rows": [[0, 0, 0], [1, 1, 0]]},
    {"id": "case-duplicate", "labels": LABELS,
     "steps": [[1, "a"], [1, "a"]], "rows": [[0, 0, 0], [1, 1, 0], [1, 1, 0]]},
    {"id": "case-duplicate-b", "labels": LABELS,
     "steps": [[1, "b"], [1, "b"]], "rows": [[0, 0, 0], [1, 0, 1], [1, 0, 1]]},
    {"id": "case-distinct", "labels": LABELS,
     "steps": [[1, "a"], [1, "b"]],
     "rows": [[0, 0, 0], [1, 1, 0], [1, 1, 1]]},
    {"id": "case-reset", "labels": LABELS,
     "steps": [[1, "a"], [3], [1, "b"]],
     "rows": [[0, 0, 0], [1, 1, 0], [0, 0, 0], [1, 0, 1]]},
    {"id": "case-seal-one", "labels": LABELS,
     "steps": [[1, "a"], [4], [1, "c"]],
     "rows": [[0, 0, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]]},
    {"id": "case-seal-two", "labels": LABELS,
     "steps": [[1, "b"], [4], [1, "d"]],
     "rows": [[0, 0, 0], [1, 0, 1], [1, 0, 1], [1, 0, 1]]},
    {"id": "case-seal-three", "labels": LABELS,
     "steps": [[1, "e"], [4], [1, "f"]],
     "rows": [[0, 0, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]]},
    {"id": "case-prune-a", "labels": LABELS,
     "steps": [[1, "a"], [6]], "rows": [[0, 0, 0], [1, 1, 0], [1, 1, 0]]},
    {"id": "case-prune-b", "labels": LABELS,
     "steps": [[1, "b"], [6]], "rows": [[0, 0, 0], [1, 0, 1], [1, 0, 0]]},
    {"id": "case-passive", "labels": LABELS,
     "steps": [[2]], "rows": [[0, 0, 0], [0, 0, 0]]},
]

analysis = derive_invariants(CASES)
by_operation = {}
for item in analysis["invariants"]:
    by_operation.setdefault(item["operation"], []).append(item)

duplicate = [item for item in by_operation.get(1, [])
             if any("already supplied" in condition for condition in item["conditions"])]
assert duplicate, "duplicate argument effect was not induced"
assert duplicate[0]["counterexamples"] == 0
assert duplicate[0]["support"] == 2 and duplicate[0]["tier"] == "provisional"
assert duplicate[0]["cases"] == ["case-duplicate", "case-duplicate-b"], duplicate[0]

sealed = [item for item in by_operation.get(1, [])
          if any("operation 4 ran" in condition for condition in item["conditions"])]
assert sealed, "sealed-state effect was not induced"
assert sealed[0]["tier"] == "supported", sealed[0]
assert sealed[0]["support"] == 3, sealed[0]
assert sealed[0]["cases"] == ["case-seal-one", "case-seal-three", "case-seal-two"]
assert sealed[0]["counterexamples"] == 0

assert 2 not in by_operation, \
    "an operation that never changed the row must not get an invariant"
assert 3 not in by_operation, "reset operations are discovered, not asserted"
# Only replicated invariants hide a no-effect observation: the duplicate-argument
# pattern was seen twice but in a single operation pair, so its transitions stay
# visible as facts a spec must explain.
assert {(item["operation"], item["case"])
        for item in analysis["uncovered_no_effect"]} == {(1, "case-duplicate"),
                                                        (1, "case-duplicate-b"),
                                                        (6, "case-prune-a")}, \
    analysis["uncovered_no_effect"]
assert not [item for item in analysis["uncovered_no_effect"]
            if item["operation"] in (2, 3)], "expected no-ops must not be reported"

lines = describe(analysis, {1: "append", 2: "probe", 3: "reset", 4: "seal", 6: "prune"})
assert all(line.startswith("INV-") for line in lines), lines
prompted = describe(analysis, {1: "append", 2: "probe", 3: "reset", 4: "seal", 6: "prune"},
                    tiers=("supported",))
assert len(prompted) == 1 and "seal" in prompted[0] or "operation 4" in prompted[0], prompted
assert any("append leaves every reported value unchanged" in line for line in lines)

effects = derive_effects(CASES)
assert [(item["operation"], item["label"]) for item in effects] == [(1, "nonempty")], effects
assert effects[0]["id"] == "EFF-1" and effects[0]["exceptions"] == []
assert effects[0]["raises"] == 11 and effects[0]["total"] == 17, effects[0]
assert not [item for item in effects if item["operation"] in (2, 3, 6)], \
    "rare or argument-dependent effects must not be reported"
assert describe_effects(effects, {1: "append"}) == [
    "EFF-1: append raised nonempty in 11 of 17 observed transitions in every observation"]

print(f"observation checks passed: {len(analysis['invariants'])} invariants, "
      f"{len(analysis['uncovered_no_effect'])} uncovered no-effect transitions, "
      f"{len(effects)} effects")
