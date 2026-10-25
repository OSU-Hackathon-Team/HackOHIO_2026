"""Check invariant induction on a synthetic interface with hidden state.

The interface reports three values (nonempty, has_a, has_b) and has five
operations: append(argument), a passive probe, a reset, a halt that makes later
appends invisible, and a prune that drops a value. Two kinds of no-effect
transition are deliberately present:

* halting before an append suppresses a raise that the same argument produces
  elsewhere, so it is evidence about the interface;
* appending the same argument twice cannot raise anything a second time, so
  "unchanged" there is unavoidable and must stay a fact, never a rule.
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.observations import (derive_argument_effects, derive_effects,
                                 derive_invariants, describe,
                                 describe_argument_effects, describe_effects)

LABELS = ["nonempty", "has_a", "has_b"]


def case(case_id: str, steps: list[list], rows: list[list]) -> dict:
    return {"id": case_id, "labels": LABELS, "steps": steps, "rows": rows}


CASES = [
    case("case-empty", [], [[0, 0, 0]]),
    case("case-append", [[1, "a"]], [[0, 0, 0], [1, 1, 0]]),
    case("case-reset", [[1, "a"], [3], [1, "b"]],
         [[0, 0, 0], [1, 1, 0], [0, 0, 0], [1, 0, 1]]),
    case("case-passive", [[2]], [[0, 0, 0], [0, 0, 0]]),
    # Duplicate arguments: nothing is raised because nothing can be.
    case("case-duplicate", [[1, "a"], [1, "a"]],
         [[0, 0, 0], [1, 1, 0], [1, 1, 0]]),
    case("case-duplicate-b", [[1, "b"], [1, "b"]],
         [[0, 0, 0], [1, 0, 1], [1, 0, 1]]),
    # Each argument is known to raise values when the interface is open ...
    case("case-open-g", [[1, "g"]], [[0, 0, 0], [1, 0, 1]]),
    case("case-open-h", [[1, "h"]], [[0, 0, 0], [1, 1, 0]]),
    # ... and halting first suppresses those raises, which is the quirk.
    case("case-halt-g", [[4], [1, "g"]], [[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
    case("case-halt-h", [[4], [1, "h"]], [[0, 0, 0], [0, 0, 0], [0, 0, 0]]),
    case("case-halt-after", [[1, "h"], [4], [1, "g"]],
         [[0, 0, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]]),
    # A prune that never changed a row is treated like a passive operation: no
    # rule and no uncovered fact, because nothing suggests it should have acted.
    case("case-prune", [[1, "a"], [5]], [[0, 0, 0], [1, 1, 0], [1, 1, 0]]),
]

analysis = derive_invariants(CASES)
by_operation = {}
for item in analysis["invariants"]:
    by_operation.setdefault(item["operation"], []).append(item)

halted = [item for item in by_operation.get(1, [])
          if any("operation 4 ran" in condition for condition in item["conditions"])]
assert halted, "the halted-state quirk was not induced"
assert halted[0]["tier"] == "supported", halted[0]
assert halted[0]["support"] == 3, halted[0]
assert halted[0]["cases"] == ["case-halt-after", "case-halt-g", "case-halt-h"]
assert halted[0]["counterexamples"] == 0
assert set(halted[0]["declined"]) == {"has_a", "has_b", "nonempty"}, halted[0]
assert all(item["declined"] for item in analysis["invariants"]), \
    "an invariant that never declined a raise explains nothing"

assert not [item for item in by_operation.get(1, [])
            if any("already supplied" in condition for condition in item["conditions"])], \
    "repeating an argument cannot raise a value again, so it must not become a rule"
assert 2 not in by_operation, \
    "an operation that never changed the row must not get an invariant"
assert 3 not in by_operation, "reset operations are discovered, not asserted"

# Repeating an argument cannot raise anything again, so those transitions stay
# visible as facts a specification still has to account for.
assert {(item["operation"], item["case"], item["step"])
        for item in analysis["uncovered_no_effect"]} == {(1, "case-duplicate", 2),
                                                        (1, "case-duplicate-b", 2)}, \
    analysis["uncovered_no_effect"]
assert not [item for item in analysis["uncovered_no_effect"]
            if item["operation"] in (2, 3)], "expected no-ops must not be reported"

names = {1: "append", 2: "probe", 3: "reset", 4: "halt", 5: "prune"}
lines = describe(analysis, names)
assert all(line.startswith("INV-") for line in lines), lines
assert any("append leaves every reported value unchanged" in line for line in lines)
prompted = describe(analysis, names, tiers=("supported",))
assert len(prompted) == 1 and "halt" in prompted[0] or "operation 4" in prompted[0], prompted

# An operation that raises a value only while it is unset produces no-effect
# transitions where there was nothing left to raise; that pattern must stay a
# fact rather than becoming a rule about the interface.
VACUOUS = CASES + [case("case-saturated", [[7], [7]],
                        [[0, 0, 0], [0, 1, 0], [0, 1, 0]])]
saturated = derive_invariants(VACUOUS)
assert not [item for item in saturated["invariants"] if item["operation"] == 7], \
    saturated["invariants"]
assert any(item["operation"] == 7 and item["case"] == "case-saturated"
           for item in saturated["uncovered_no_effect"]), \
    "the unavoidable no-effect transition must remain visible as a fact"

effects = derive_effects(CASES)
assert [(item["operation"], item["label"]) for item in effects] == [(1, "nonempty")], effects
assert effects[0]["id"] == "EFF-1", effects[0]
assert effects[0]["exceptions"] == ["case-halt-g", "case-halt-h"], effects[0]
assert set(effects[0]["exceptions"]) == set(halted[0]["cases"]) - {"case-halt-after"}, \
    "the effect's exceptions are exactly the transitions the invariant explains"
appends = [step for item in CASES for step in item["steps"] if step[0] == 1]
raises = sum(1 for item in CASES for index, step in enumerate(item["steps"])
             if step[0] == 1 and not item["rows"][index][0] and item["rows"][index + 1][0])
assert effects[0]["total"] == len(appends) and effects[0]["raises"] == raises, effects[0]
assert not [item for item in effects if item["operation"] in (2, 3, 5)], \
    "rare or argument-dependent effects must not be reported"
assert describe_effects(effects, {1: "append"}) == [
    f"EFF-1: append raised nonempty in {raises} of {len(appends)} observed transitions "
    "except in case-halt-g, case-halt-h"], describe_effects(effects, {1: "append"})

# Argument effects are the categorical part of the interface: which value an
# argument implies whenever it was supplied with that value absent. Suppressed
# raises (halted appends) reduce the ratio, so they cannot become categorical,
# and a value the argument never raised is never claimed.
argument_effects = derive_argument_effects(CASES)
claims = {(item["operation"], item["argument"], item["label"])
          for item in argument_effects}
assert claims == {(1, "a", "has_a"), (1, "a", "nonempty"),
                  (1, "b", "has_b"), (1, "b", "nonempty")}, claims
assert all(item["raises"] == item["observable"] and not item["conditional"]
           for item in argument_effects), argument_effects
assert all(item["id"] == f"ARG-{index}"
           for index, item in enumerate(argument_effects, start=1))
assert describe_argument_effects(argument_effects, {1: "append"})[0].startswith(
    'ARG-1: append "a" always raised has_a in 4 of 4 transitions'), \
    describe_argument_effects(argument_effects, {1: "append"})

print(f"observation checks passed: {len(analysis['invariants'])} invariants, "
      f"{len(analysis['uncovered_no_effect'])} uncovered no-effect transitions, "
      f"{len(effects)} effects, {len(argument_effects)} argument effects")
