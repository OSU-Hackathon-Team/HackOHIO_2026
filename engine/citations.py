"""Map harmless hexadecimal spelling variants to exact exported evidence addresses."""

from __future__ import annotations

import re


def evidence_addresses(evidence: dict) -> set[str]:
    addresses = {evidence["entry"]}
    addresses.update(value for value in (evidence.get("body_min"), evidence.get("body_max"))
                     if isinstance(value, str))
    addresses.update(item["address"] for item in evidence.get("instructions", []))
    for item in evidence.get("references", []):
        addresses.update((item["from"], item["to"]))
    return addresses


def normalize_references(refs: object, addresses: set[str]) -> tuple[object, list[dict]]:
    if not isinstance(refs, list):
        return refs, []
    numeric: dict[int, set[str]] = {}
    for address in addresses:
        if re.fullmatch(r"(?:0[xX])?[0-9a-fA-F]+", address):
            numeric.setdefault(int(address.removeprefix("0x").removeprefix("0X"), 16),
                               set()).add(address)
    normalized = []
    changes = []
    for address in refs:
        canonical = address
        if isinstance(address, str) and address not in addresses and re.fullmatch(
                r"(?:0[xX])?[0-9a-fA-F]+", address):
            choices = numeric.get(int(address.removeprefix("0x").removeprefix("0X"), 16),
                                  set())
            if len(choices) == 1:
                canonical = next(iter(choices))
                changes.append({"original": address, "canonical": canonical})
        normalized.append(canonical)
    return normalized, changes
