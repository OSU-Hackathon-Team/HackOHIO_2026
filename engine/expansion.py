"""Propose original observations that cover operation contexts the evidence misses.

A derived invariant can only be trusted where the evidence exercised it, so
learning stalls when an interface has transitions nobody observed. This module
treats the observed operation contexts as a coverage problem: it counts contexts
(an operation together with the operations that ran since the last reset), keeps
the ones with too little support to become rules, and proposes new sequences that
reach the largest number of those weak contexts per step. Proposals reuse only
operations and arguments already observed, so nothing here invents interface
knowledge or touches held-out inputs; the caller observes the proposals against
the original binary exactly like any other case.
"""

from __future__ import annotations

import random
from collections import Counter, defaultdict

from engine.observations import SUPPORTED_OCCURRENCES, reset_operations


def _contexts(steps: list[list], resets: set[int]) -> list[tuple[int, tuple[int, ...]]]:
    """Context of every step in one sequence: (operation, operations since reset)."""
    since: tuple[int, ...] = ()
    contexts = []
    for step in steps:
        code = step[0]
        contexts.append((code, since))
        since = () if code in resets else since + (code,)
    return contexts


def context_support(cases: list[dict], resets: set[int] | None = None) -> Counter:
    """How many observed transitions each operation context has.

    ``resets`` lets a caller project contexts onto sequences that have not been
    observed yet, reusing the reset operations the evidence already established.
    """
    if resets is None:
        resets = reset_operations(cases)
    support: Counter = Counter()
    for case in cases:
        support.update(_contexts(case["steps"], resets))
    return support


def weak_contexts(cases: list[dict], resets: set[int] | None = None
                  ) -> set[tuple[int, tuple[int, ...]]]:
    """Contexts seen too few times to become a rule on their own."""
    support = context_support(cases, resets)
    if len(support) <= 1:
        # One context observed everywhere says nothing about what is untested.
        return set()
    return {context for context, count in support.items() if count < SUPPORTED_OCCURRENCES}


def _canonical(steps: list[list]) -> tuple:
    return tuple((step[0], step[1] if len(step) > 1 else None) for step in steps)


def _exemplars(cases: list[dict], resets: set[int]) -> dict[tuple, list[list]]:
    """For each context, sequences that reached it, with their real arguments."""
    seen: dict[tuple, list[list]] = defaultdict(list)
    for case in cases:
        steps = case["steps"]
        since: list[list] = []
        for index, step in enumerate(steps):
            key = (step[0], tuple(previous[0] for previous in since))
            if len(seen[key]) < 3:
                seen[key].append(steps[max(0, index - len(since)): index + 1])
            if step[0] in resets:
                since = []
            else:
                since.append(step)
    return seen


def _arguments(cases: list[dict]) -> dict[int, list]:
    """Observed argument values per operation, so proposals stay inside the interface."""
    values: dict[int, list] = defaultdict(list)
    for case in cases:
        for step in case["steps"]:
            if len(step) > 1 and step[1] is not None and step[1] not in values[step[0]]:
                values[step[0]].append(step[1])
    return values


def select_evidence(cases: list[dict], limit: int) -> list[dict]:
    """Pick the fewest observations that still exhibit every operation context.

    Long transition dumps dilute what a reader can attend to, while the derived
    tables already summarise the rules. This keeps one case per operation context
    (an operation and the operations since the last reset) and one per argument,
    choosing greedily so the smallest set covers the most, and keeps the selected
    cases in their original order.
    """
    resets = reset_operations(cases)
    features = []
    for case in cases:
        case_features = set(_contexts(case["steps"], resets))
        case_features |= {(step[0], ("argument", step[1])) for step in case["steps"]
                          if len(step) > 1 and step[1] is not None}
        features.append(case_features)
    covered, chosen = set(), set()
    while len(chosen) < max(limit, 0):
        best, best_gain = None, 0
        for index, case_features in enumerate(features):
            if index in chosen:
                continue
            gain = len(case_features - covered)
            if gain > best_gain or (gain == best_gain and gain and best is not None
                                    and len(cases[index]["steps"]) < len(cases[best]["steps"])):
                best, best_gain = index, gain
        if best is None or not best_gain:
            break
        chosen.add(best)
        covered |= features[best]
    return [case for index, case in enumerate(cases) if index in chosen]


def propose_argument_isolation(cases: list[dict], minimum: int = 2) -> list[list[list]]:
    """Sequence each observed argument from an empty state so its raise is visible.

    An argument's effect can only be read where the value it raises is still
    absent, so an argument that only ever appeared after other operations teaches
    nothing about what it implies. These proposals place each such argument on an
    empty state, using a discovered reset operation for the repeat observation so
    the two cases are not duplicates of each other or of existing evidence.
    """
    resets = sorted(reset_operations(cases))
    from_empty = Counter()
    arguments: dict[tuple[int, object], None] = {}
    for case in cases:
        for index, step in enumerate(case["steps"]):
            argument = step[1] if len(step) > 1 else None
            if argument is None:
                continue
            arguments[(step[0], argument)] = None
            if index == 0:
                from_empty[(step[0], argument)] += 1
    keys = sorted((key for key in arguments if from_empty[key] < minimum),
                  key=lambda key: (key[0], str(key[1])))
    plans = []
    for operation, argument in keys:
        # Every label is absent in the initial state, so a leading operation is
        # fully observable there. Resetting first gives a second, distinct case.
        plans.append([[operation, argument]])
        if resets:
            plans.append([[resets[0]], [operation, argument]])
    return plans


def propose(cases: list[dict], count: int, *, seed: int = 0, pool_size: int = 600,
            max_extension: int = 4, max_length: int = 8,
            avoid: list[list[list]] = ()) -> list[list[list]]:
    """Choose unobserved sequences that reach the most weakly supported contexts.

    Sequences are built from observed contexts (keeping the argument values that
    really produced them) and extended with operations sampled from the same
    evidence. Selection is greedy: each round takes the candidate that covers the
    most still-uncovered weak contexts, so the proposals do not repeat coverage
    the evidence already has. ``avoid`` lists sequences that must not be proposed
    even though their contexts are weak, which keeps new observations from
    duplicating cases reserved for evaluation.
    """
    resets = reset_operations(cases)
    support = context_support(cases)
    weak = weak_contexts(cases)
    if not weak or count <= 0:
        return []
    codes = sorted({code for code, _ in support})
    arguments = _arguments(cases)
    exemplars = _exemplars(cases, resets)
    observed = {_canonical(case["steps"]) for case in cases}
    observed |= {_canonical(steps) for steps in avoid}
    rng = random.Random(seed)

    def sample_step() -> list:
        code = rng.choice(codes)
        values = arguments.get(code)
        return [code, rng.choice(values)] if values else [code]

    pool: list[list[list]] = []
    for key in sorted(weak):
        for exemplar in exemplars.get(key, [])[:2]:
            for _ in range(2):
                plan = [list(step) for step in exemplar]
                plan.extend(sample_step() for _ in range(rng.randint(0, max_extension)))
                if len(plan) <= max_length:
                    pool.append(plan)
    for _ in range(pool_size):
        length = rng.randint(1, max_length)
        pool.append([sample_step() for _ in range(length)])

    unique, plans = set(), []
    for plan in pool:
        key = _canonical(plan)
        if key in observed or key in unique:
            continue
        unique.add(key)
        plans.append(plan)

    chosen, covered, chosen_keys = [], set(), set()
    while len(chosen) < count:
        best, best_key, best_covered = None, None, set()
        for plan in plans:
            key = _canonical(plan)
            if key in chosen_keys:
                continue
            reached = set(_contexts(plan, resets)) & (weak - covered)
            if len(reached) > len(best_covered):
                best, best_key, best_covered = plan, key, reached
        if best is None or not best_covered:
            break
        chosen.append(best)
        chosen_keys.add(best_key)
        covered |= best_covered
    return chosen
