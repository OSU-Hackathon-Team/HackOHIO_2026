"""Check coverage-driven evidence expansion: proposals must add coverage, not duplicates.

The synthetic interface below exercises the three properties the expander relies
on: contexts are counted per operation with reset truncation, weak contexts are
the ones with too little support to become rules, and proposals are unobserved
sequences whose arguments came from the evidence.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.expansion import (SUPPORTED_OCCURRENCES, context_support, propose,
                             propose_argument_isolation, select_evidence,
                             weak_contexts)


def case(case_id: str, steps: list[list]) -> dict:
    """A transition with rows that reveal which operation resets the state."""
    rows = [[0]]
    for step in steps:
        rows.append([0] if step[0] == 2 else [1])
    return {"id": case_id, "steps": steps, "rows": rows, "labels": ["value"]}


RICH = [[1, 7], [2], [1, 7], [1, 9], [2]]
RARE = [[4, 3.5], [3], [1, 7]]


def main() -> None:
    # Operation 2 resets; 1 and 4 take an argument; 3 takes none.
    cases = [case(chr(ord("a") + index), RICH) for index in range(3)]
    cases.append(case("g", RARE))
    support = context_support(cases)

    assert support[(1, ())] == 6, support
    assert support[(2, (1,))] == 3, support
    assert support[(1, (1,))] == 3, support
    assert support[(2, (1, 1))] == 3, support
    # A reset truncates the context: the second append never sees the first one.
    assert (1, (1, 1)) not in support, support
    assert (4, ()) == (4, ()) and support[(4, ())] == 1, support

    weak = weak_contexts(cases)
    assert (1, ()) not in weak, "a fully supported context is not weak"
    assert (2, (1,)) not in weak, "support at the threshold is not weak"
    assert weak == {(4, ()), (3, (4,)), (1, (4, 3))}, weak
    assert all(support[context] < SUPPORTED_OCCURRENCES for context in weak)
    single = [case("only", [[1, 7]])]
    assert not weak_contexts(single), "one context everywhere says nothing about gaps"

    plans = propose(cases, 4, seed=1, max_length=6)
    assert plans, "weak contexts exist, so proposals must be produced"
    observed = {tuple((step[0], step[1] if len(step) > 1 else None)
                      for step in item["steps"]) for item in cases}
    for plan in plans:
        key = tuple((step[0], step[1] if len(step) > 1 else None) for step in plan)
        assert key not in observed, f"proposal repeats an observed case: {plan}"
        assert 1 <= len(plan) <= 6, plan
        for step in plan:
            if len(step) > 1:
                assert step[1] in (7, 9, 3.5), f"argument outside evidence: {step}"
            else:
                assert step[0] != 1, "an operation with an argument lost it"
        assert 2 in {step[0] for step in plan} or 4 in {step[0] for step in plan}, plan
    assert propose(cases, 4, seed=1, max_length=6) == plans, "proposals are deterministic"

    # Every proposal must pay for itself with at least one context the evidence
    # exercises too rarely; otherwise it is padding.
    def contexts(plan: list[list]) -> set:
        since, reached = (), set()
        for step in plan:
            reached.add((step[0], since))
            since = () if step[0] == 2 else since + (step[0],)
        return reached

    reached = set()
    for plan in plans:
        assert contexts(plan) & (weak - reached), f"proposal adds no coverage: {plan}"
        reached |= contexts(plan) & weak
    assert len(reached) > 1, "one proposal would not cover several gaps"

    avoided = [[[4, 3.5], [3], [1, 7], [1, 9]]]
    guarded = propose(cases, 8, seed=1, max_length=8, avoid=avoided)
    def key(plan: list[list]) -> tuple:
        return tuple((step[0], step[1] if len(step) > 1 else None) for step in plan)

    assert key(avoided[0]) not in {key(plan) for plan in guarded}

    exhaustive = [case(f"e{index}", [[1, 7], [2], [1, 7], [1, 9], [2], [4, 1.5], [3]])
                  for index in range(3)]
    assert not weak_contexts(exhaustive), weak_contexts(exhaustive)
    assert not propose(exhaustive, 5, seed=1), "nothing to propose when coverage is full"

    # An argument only ever seen after other operations never reveals what it
    # implies, because the value it raises may already be present. Isolation
    # proposals put it on an empty state, twice, using a discovered reset.
    isolation_evidence = [
        case("late-1", [[1, "a"], [1, "z"]]),
        case("late-2", [[2], [1, "a"], [1, "z"]]),
        case("early-1", [[1, "a"]]),
        case("early-2", [[1, "a"]]),
        case("cleared", [[1, "a"], [2]]),
    ]
    isolated = propose_argument_isolation(isolation_evidence)
    assert [[1, "z"]] in isolated, isolated
    assert [[2], [1, "z"]] in isolated, isolated
    assert not [plan for plan in isolated if any(step[1] == "a" for step in plan
                                                if len(step) > 1)], \
        f"arguments already observed from empty need no isolation: {isolated}"
    assert all(plan[0][0] == 2 or plan[0] == [1, "z"] for plan in isolated), isolated

    # Evidence selection must shrink the corpus without losing a single operation
    # context or argument, and must keep the cases in their original order.
    selected = select_evidence(exhaustive, 10)
    assert 0 < len(selected) < len(exhaustive), (len(selected), len(exhaustive))
    assert [case["id"] for case in selected] == [case["id"] for case in exhaustive
                                                 if case["id"] in {c["id"] for c in selected}]
    assert set(context_support(selected, {2})) >= set(context_support(exhaustive, {2})), \
        "selection dropped an operation context"
    arguments = {(step[0], step[1]) for case in exhaustive for step in case["steps"]
                 if len(step) > 1}
    selected_arguments = {(step[0], step[1]) for case in selected for step in case["steps"]
                          if len(step) > 1}
    assert arguments <= selected_arguments, arguments - selected_arguments
    assert len(select_evidence(exhaustive, 1)) == 1, "the limit is a hard bound"

    print("expansion check passed: "
          f"{len(support)} contexts, {len(weak)} weak, {len(plans)} proposals, "
          f"{len(isolated)} isolation proposals, "
          f"{len(selected)} of {len(exhaustive)} selected")


if __name__ == "__main__":
    main()
