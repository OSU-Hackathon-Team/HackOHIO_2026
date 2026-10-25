"""Classify analysis notes that cannot serve as functional requirements."""

import re


NON_BEHAVIORAL = re.compile(
    r"^(?:Spans \d+ static instructions|Invokes .+ as subordinate steps|"
    r"Serves invocations from |Reaches \d+ branch sites)|"
    r"\b(?:vtable|vptr|virtual table|RTTI|typeinfo|this pointer|"
    r"constructor|destructor|operator\.new|allocation|allocated object|"
    r"call instruction|static instructions?|callee|register|stack slot|"
    r"decompiler|assembly|branch sites?)\b|@[0-9a-f]{8}\b|"
    r"\b(?:RAX|RDI|EAX|XMM\d+|param_\d+|_?DAT_[0-9a-f]+|address)\b|"
    r"\b0x[0-9a-f]+\b",
    re.I,
)


def is_observable_claim(statement: object) -> bool:
    return isinstance(statement, str) and bool(statement.strip()) and not NON_BEHAVIORAL.search(statement)


def normalize_input_names(statement: str) -> str:
    """Express parameter positions and numeric constants without source syntax."""
    named = re.sub(r"\bparam_(\d+)\b", lambda match: f"input {match.group(1)}",
                   statement, flags=re.I)
    return re.sub(r"\b0x[0-9a-f]+\b", lambda match: str(int(match.group(), 16)),
                  named, flags=re.I)
