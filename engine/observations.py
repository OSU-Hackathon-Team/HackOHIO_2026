"""Induce context conditions under which observed operations had no effect.

Inference is deterministic and uses original transitions only. An invariant is
promoted only when every occurrence of its operation in the evidence agrees, so
an artifact of the implementation cannot become a rule by accident, and its
support is reported with the cases that produced it. Nothing here knows the
interface: operations, arguments, and state columns come from the recorded
cases, and reset operations are discovered as ones that returned every column
to zero from a non-zero row.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations

MIN_SUPPORT = 2
MAX_CONDITIONS = 2
SUPPORTED_OCCURRENCES = 3
SUPPORTED_CASES = 2


def _zero(row: list[int]) -> bool:
    return not any(row)


def reset_operations(cases: list[dict]) -> set[int]:
    """Operations observed to return a non-zero row to an all-zero row."""
    resets = set()
    for case in cases:
        rows = case["rows"]
        for index, step in enumerate(case["steps"]):
            if not _zero(rows[index]) and _zero(rows[index + 1]):
                resets.add(step[0])
    return resets


def _occurrences(cases: list[dict]) -> list[dict]:
    resets = reset_operations(cases)
    records = []
    for case in cases:
        rows = case["rows"]
        labels = case["labels"]
        steps = case["steps"]
        for index, step in enumerate(steps):
            code, argument = step[0], (step[1] if len(step) > 1 else None)
            window = []
            for previous in range(index - 1, -1, -1):
                if steps[previous][0] in resets:
                    break
                window.append(previous)
            features = set()
            for previous in window:
                other = steps[previous][0]
                features.add(f"operation {other} ran since the last reset")
                for column, label in enumerate(labels):
                    if rows[previous][column]:
                        features.add(f"operation {other} ran while {label} was reported")
            if index:
                features.add(f"operation {steps[index - 1][0]} ran immediately before")
            if argument is not None and any(
                    steps[previous][0] == code and
                    (steps[previous][1] if len(steps[previous]) > 1 else None) == argument
                    for previous in window):
                features.add("the same argument was already supplied since the last reset")
            records.append({"case": case["id"], "index": index, "operation": code,
                            "argument": argument, "before": rows[index],
                            "after": rows[index + 1], "features": features,
                            "unchanged": rows[index] == rows[index + 1]})
    return records


def _candidates(records: list[dict], operation: int) -> list[dict]:
    pool = defaultdict(int)
    for record in records:
        if record["operation"] == operation and record["unchanged"]:
            for feature in record["features"]:
                pool[feature] += 1
    names = [name for name, count in pool.items() if count >= MIN_SUPPORT]
    occurrences = [record for record in records if record["operation"] == operation]
    if all(record["unchanged"] for record in occurrences):
        return []
    candidates = []
    for size in range(1, MAX_CONDITIONS + 1):
        for combination in combinations(sorted(names), size):
            matched = [record for record in occurrences
                       if all(feature in record["features"] for feature in combination)]
            if len(matched) < MIN_SUPPORT:
                continue
            if any(not record["unchanged"] for record in matched):
                continue
            candidates.append({"conditions": list(combination), "matched": matched})
    return candidates


def _tier(matched: list[dict]) -> str:
    cases = {record["case"] for record in matched}
    if len(matched) >= SUPPORTED_OCCURRENCES and len(cases) >= SUPPORTED_CASES:
        return "supported"
    return "provisional"


def derive_invariants(cases: list[dict]) -> dict:
    """Return context invariants plus the no-effect transitions they leave out."""
    records = _occurrences(cases)
    invariants, uncovered = [], []
    explained = set()
    for operation in sorted({record["operation"] for record in records}):
        occurrences = [record for record in records if record["operation"] == operation]
        unchanged = [record for record in occurrences if record["unchanged"]]
        if not unchanged or all(record["unchanged"] for record in occurrences):
            continue
        chosen, covered = [], set()
        for candidate in sorted(_candidates(records, operation),
                                key=lambda item: (-len(item["matched"]),
                                                  len(item["conditions"]))):
            keys = {(record["case"], record["index"])
                    for record in candidate["matched"]}
            if keys <= covered:
                continue
            chosen.append(candidate)
            covered |= keys
        for candidate in chosen:
            matched = candidate["matched"]
            tier = _tier(matched)
            invariants.append({
                "operation": operation,
                "effect": "leaves every reported value unchanged",
                "conditions": candidate["conditions"],
                "tier": tier,
                "support": len(matched),
                "cases": sorted({record["case"] for record in matched}),
                "counterexamples": 0})
            if tier == "supported":
                # Only replicated invariants suppress an uncovered observation;
                # a single-case pattern stays visible as a fact to explain.
                explained |= {(record["case"], record["index"]) for record in matched}
    effective = {record["operation"] for record in records if not record["unchanged"]}
    resets = reset_operations(cases)
    for record in records:
        if (not record["unchanged"] or record["operation"] not in effective
                or (record["case"], record["index"]) in explained):
            continue
        if record["operation"] in resets and _zero(record["before"]):
            # A reset of an already-empty state is the definition of the reset.
            continue
        uncovered.append({"operation": record["operation"], "case": record["case"],
                          "step": record["index"] + 1,
                          "before": record["before"], "after": record["after"]})
    for number, invariant in enumerate(invariants, start=1):
        invariant["id"] = f"INV-{number}"
    return {"schema": 1, "invariants": invariants, "uncovered_no_effect": uncovered,
            "unchanged_observations": sum(1 for record in records
                                          if record["unchanged"]),
            "changed_observations": sum(1 for record in records
                                        if not record["unchanged"])}


EFFECT_MIN_RAISES = 3
EFFECT_MIN_CASES = 2
EFFECT_MIN_RATIO = 0.5


def derive_effects(cases: list[dict]) -> list[dict]:
    """Report the reported values each operation was observed to raise.

    Only effects that hold in at least half of the operation's occurrences are
    reported, so an argument-dependent effect stays visible in the transitions
    instead of becoming a low-rate tally, and the remaining occurrences are
    listed as exceptions.
    """
    tally = defaultdict(lambda: {"raises": 0, "lowers": 0, "keeps": 0,
                                 "cases": [], "exceptions": []})
    occurrences = defaultdict(int)
    for case in cases:
        for step in case["steps"]:
            occurrences[step[0]] += 1
    for case in cases:
        for index, step in enumerate(case["steps"]):
            before, after = case["rows"][index], case["rows"][index + 1]
            for column, label in enumerate(case["labels"]):
                entry = tally[(step[0], label)]
                entry["cases"].append(case["id"])
                if not before[column] and after[column]:
                    entry["raises"] += 1
                elif before[column] and not after[column]:
                    entry["lowers"] += 1
                    entry["exceptions"].append(case["id"])
                else:
                    entry["keeps"] += 1
                    if not before[column]:
                        entry["exceptions"].append(case["id"])
    effects = []
    for (operation, label), entry in sorted(tally.items()):
        # The denominator is every occurrence of the operation, not only the
        # cases that queried this value, so an effect that depends on the
        # argument cannot masquerade as a general one.
        total = occurrences[operation]
        if (entry["raises"] < EFFECT_MIN_RAISES
                or len(set(entry["cases"])) < EFFECT_MIN_CASES
                or entry["raises"] < EFFECT_MIN_RATIO * total):
            continue
        effects.append({"operation": operation, "label": label,
                        "raises": entry["raises"], "total": total,
                        "exceptions": sorted(set(entry["exceptions"]))})
    for number, effect in enumerate(effects, start=1):
        effect["id"] = f"EFF-{number}"
    return effects


def describe_effects(effects: list[dict], names: dict[int, str]) -> list[str]:
    sentences = []
    for effect in effects:
        operation = names.get(effect["operation"], str(effect["operation"]))
        exceptions = (" except in " + ", ".join(effect["exceptions"])
                      if effect["exceptions"] else " in every observation")
        sentences.append(
            f"{effect['id']}: {operation} raised {effect['label']} in "
            f"{effect['raises']} of {effect['total']} observed transitions{exceptions}")
    return sentences


def describe(analysis: dict, names: dict[int, str], tiers: tuple[str, ...] = ()) -> list[str]:
    """Render invariants as sentences with operation names attached."""
    sentences = []
    for invariant in analysis["invariants"]:
        if tiers and invariant["tier"] not in tiers:
            continue
        operation = names.get(invariant["operation"], str(invariant["operation"]))
        when = " and ".join(invariant["conditions"])
        sentences.append(
            f"{invariant['id']} [{invariant['tier']}, {invariant['support']} observed "
            f"transitions in {', '.join(invariant['cases'])}]: {operation} "
            f"{invariant['effect']} when {when}")
    return sentences
