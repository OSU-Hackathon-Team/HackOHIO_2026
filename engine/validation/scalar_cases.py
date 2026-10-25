"""Check a deliberately narrow class of scalar claims against original cases."""

from __future__ import annotations

import re


MAPPING = re.compile(
    r"\breturns?\s+(\d+)\s+when\s+(?:"
    r"both\s+input\s+1\s+and\s+input\s+2\s+are\s+(true|false)|"
    r"input\s+1\s+is\s+(true|false)\s+and\s+input\s+2\s+is\s+(true|false))\b",
    re.I,
)


def scalar_counterexamples(statement: str, cases: list[dict]) -> list[str]:
    match = MAPPING.search(statement)
    if not match:
        return []
    expected = int(match.group(1))
    first = (match.group(2) or match.group(3)).lower() == "true"
    second = (match.group(2) or match.group(4)).lower() == "true"
    conflicts = []
    for case in cases:
        args = case.get("input", {}).get("args")
        observed = case.get("observed", {}).get("return")
        if (isinstance(args, list) and len(args) == 2 and
                all(isinstance(value, bool) for value in args) and
                args == [first, second] and isinstance(observed, int) and
                observed != expected):
            conflicts.append(case["case_id"])
    return conflicts
