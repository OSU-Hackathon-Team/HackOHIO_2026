"""Classify analysis notes that cannot serve as functional requirements."""

import re


NON_BEHAVIORAL = re.compile(
    r"^(?:Spans \d+ static instructions|Invokes .+ as subordinate steps|"
    r"Serves invocations from |Reaches \d+ branch sites)|"
    r"\b(?:vtable|vptr|virtual table|RTTI|typeinfo|this pointer|"
    r"constructor address|destructor address)\b|@[0-9a-f]{8}\b",
    re.I,
)


def is_observable_claim(statement: object) -> bool:
    return isinstance(statement, str) and bool(statement.strip()) and not NON_BEHAVIORAL.search(statement)
