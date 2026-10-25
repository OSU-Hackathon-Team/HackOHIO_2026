"""Classify analysis notes that cannot serve as functional requirements."""

import re


NON_BEHAVIORAL = re.compile(
    r"^(?:The function treats .+ as .+ value|Spans \d+ static instructions|Invokes .+ as subordinate steps|"
    r"Serves invocations from |Reaches \d+ branch sites)|"
    r"\b(?:vtable|vptr|virtual table|RTTI|typeinfo|this pointer|"
    r"constructor|destructor|operator\.new|allocat(?:e|es|ed|ing|ions?)|"
    r"deallocat\w*|"
    r"call instruction|static instructions?|callee|register|stack slot|"
    r"decompiler|assembly|branch sites?|reference counting|quadword|"
    r"memory pointers|bit pattern|bitfield|memcpy|memmove|"
    r"pointer array|array slot|dereferenc(?:e|ed|ing))\b|"
    r"\b(?:token|memory|internal|object|data)\s+buffer\b|"
    r"\b(?:end|start|base|source|destination|token|array|buffer)\s+pointer\b|"
    r"\bbytes?\s+at\s+offsets?\b|"
    r"\b(?:bytes?|offsets?)\s*[+-]\s*\d+\b|"
    r"\b(?:new|previous|existing)\s+buffer\b|"
    r"\b(?:internal|token|count|object|memory)\s+field\b|"
    r"\b(?:storage|array|object)\s+slot\b|"
    r"\breleas(?:e|es|ed|ing)\s+(?:the\s+)?(?:previous|existing)\s+(?:storage|allocation|buffer)\b|"
    r"\b(?:internal|underlying)\s+(?:ranges?|tokens?|counts?|state)\b|"
    r"\bloop(?:s|ing)?\b|"
    r"\b(?:calls?|calling|invok(?:e|es|ed|ing))\b|"
    r"\b(?:object\s+)?offset\s+\d+\b|\bfield\s+at\s+offset\b|"
    r"\blocation\s+\d+\b|\biterates?\s+through\b|"
    r"\bcalls?\s+[A-Za-z_][A-Za-z_0-9]*\s+for\s+each\b|"
    r"@[0-9a-f]{8}\b|"
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


def numeric_claim_errors(statement: str) -> list[str]:
    errors = []
    for match in re.finditer(r"\bbit\s+(\d+)\s*\((\d+)\)", statement, re.I):
        bit, mask = int(match.group(1)), int(match.group(2))
        if mask > 0 and mask & (mask - 1) == 0 and bit != mask.bit_length() - 1:
            errors.append(f"bit {bit} disagrees with mask {mask} using zero-based bit positions")
    return errors
