"""Check a deliberately narrow class of scalar claims against original cases."""

from __future__ import annotations

import re


MAPPING = re.compile(
    r"\breturns?\s+(\d+)\s+when\s+(?:"
    r"both\s+input\s+1\s+and\s+input\s+2\s+are\s+(true|false)|"
    r"input\s+1\s+is\s+(true|false)\s+and\s+input\s+2\s+is\s+(true|false))\b",
    re.I,
)
EQUAL = re.compile(r"\breturns?\s+(\d+)\s+when\s+(?:the\s+)?input\s+equals\s+(\d+)\b", re.I)
RANGE = re.compile(
    r"\breturns?\s+(\d+)\s+when\s+(?:the\s+)?input\s+minus\s+(\d+)"
    r"(?:\s*\(\d+\))?\s+"
    r"(?:is|results\s+in\s+a\s+value)\s+between\s+0\s+and\s+1\s+inclusive\b",
    re.I,
)
MASKED_EQUAL = re.compile(
    r"\breturns?\s+(\d+)\s+when\s+(?:the\s+)?input,?\s+after\s+clearing\s+"
    r"bits?\s+\d+(?:\s*(?:,|and)\s*\d+)*\s*"
    r"\(mask\s+(\d+)\),?\s+equals\s+(\d+)\b", re.I,
)
BITWISE = re.compile(
    r"\bwhen\s+the\s+second\s+parameter\s+is\s+(nonzero|zero),\s+"
    r"the\s+function\s+returns\s+the\s+first\s+parameter\s+bitwise\s+"
    r"(OR|AND)'?d\s+with\s+(\d+)\b", re.I,
)
LOW_EXCEPT_ZERO = re.compile(
    r"\breturns?\s+(\d+)\s+for\s+all\s+inputs?\s+less\s+than\s+(\d+)\s+except\s+zero\b",
    re.I,
)
BIT_STATE = re.compile(
    r"\b(?:sets|clears)\s+bit\s+(\d+)\s*\((\d+)\).*"
    r"second\s+parameter\s+is\s+(nonzero|zero)", re.I,
)
BIT_RETURN = re.compile(
    r"\bwhen\s+the\s+boolean\s+parameter\s+is\s+(nonzero|zero),\s+"
    r"the\s+function\s+returns\s+the\s+Grammar\s+parameter\s+with\s+"
    r"bit\s+(\d+)\s+(set|cleared)\b", re.I,
)
LOW_BITS = re.compile(
    r"\breturns?\s+(\d+)\s+if\s+the\s+low\s+16\s+bits\s+of\s+the\s+input\s+"
    r"equal\s+(\d+)\b", re.I,
)


def matching_scalar_cases(statement: str, cases: list[dict]) -> list[dict]:
    """Return cases where a restricted claim predicate applies and predicts output."""
    mapping, equal, span, masked_equal, bitwise, low, bit_state, bit_return, low_bits = (
        pattern.search(statement) for pattern in
        (MAPPING, EQUAL, RANGE, MASKED_EQUAL, BITWISE, LOW_EXCEPT_ZERO,
         BIT_STATE, BIT_RETURN, LOW_BITS))
    matched = []
    for case in cases:
        arguments = case.get("input", {}).get("args")
        observed = case.get("observed", {}).get("return")
        if not isinstance(arguments, list) or not isinstance(observed, int):
            continue
        expected = None
        if mapping and len(arguments) == 2 and all(isinstance(x, bool) for x in arguments):
            first = (mapping.group(2) or mapping.group(3)).lower() == "true"
            second = (mapping.group(2) or mapping.group(4)).lower() == "true"
            if arguments == [first, second]:
                expected = int(mapping.group(1))
        elif equal and len(arguments) == 1 and arguments[0] == int(equal.group(2)):
            expected = int(equal.group(1))
        elif span and len(arguments) == 1 and isinstance(arguments[0], int):
            if arguments[0] in (int(span.group(2)), int(span.group(2)) + 1):
                expected = int(span.group(1))
        elif masked_equal and len(arguments) == 1 and isinstance(arguments[0], int):
            if arguments[0] & int(masked_equal.group(2)) == int(masked_equal.group(3)):
                expected = int(masked_equal.group(1))
        elif bitwise and len(arguments) == 2 and isinstance(arguments[0], int):
            flag = bool(arguments[1])
            if flag == (bitwise.group(1).lower() == "nonzero"):
                mask = int(bitwise.group(3))
                expected = ((arguments[0] | mask) if bitwise.group(2).upper() == "OR"
                            else (arguments[0] & mask)) & 0xffffffff
        elif low and len(arguments) == 1 and isinstance(arguments[0], int):
            if 0 < arguments[0] < int(low.group(2)):
                expected = int(low.group(1))
        elif bit_state and len(arguments) == 2 and isinstance(arguments[0], int):
            if bool(arguments[1]) == (bit_state.group(3).lower() == "nonzero"):
                mask = int(bit_state.group(2))
                wanted_set = statement.lower().lstrip().startswith("sets") or " sets " in statement.lower()
                predicted_state = mask if wanted_set else 0
                expected = (observed if observed & mask == predicted_state
                            else observed ^ mask)
        elif (bit_return and 1 <= int(bit_return.group(2)) <= 32 and
              len(arguments) == 2 and isinstance(arguments[0], int)):
            if bool(arguments[1]) == (bit_return.group(1).lower() == "nonzero"):
                # Semantic claims number bits from one (bit 25 is 0x01000000).
                mask = 1 << (int(bit_return.group(2)) - 1)
                expected = ((arguments[0] | mask) if bit_return.group(3).lower() == "set"
                            else (arguments[0] & ~mask)) & 0xffffffff
        elif low_bits and len(arguments) == 1 and isinstance(arguments[0], int):
            if arguments[0] & 0xffff == int(low_bits.group(2)):
                expected = int(low_bits.group(1))
        if expected is not None:
            matched.append({"case_id": case["case_id"], "expected": expected,
                            "observed": observed, "agreement": expected == observed})
    return matched


def scalar_counterexamples(statement: str, cases: list[dict]) -> list[str]:
    return [item["case_id"] for item in matching_scalar_cases(statement, cases)
            if not item["agreement"]]
