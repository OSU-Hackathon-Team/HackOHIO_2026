"""Conservative checks for explicit fixed-address memory overlap claims."""

from __future__ import annotations

import re


_WIDTH = {"byte": 1, "word": 2, "dword": 4, "qword": 8,
          "xmmword": 16, "ymmword": 32, "zmmword": 64}
_STORE = re.compile(
    r"^(?:V?MOV[A-Z0-9]*)\s+(byte|word|dword|qword|xmmword|ymmword|zmmword)\s+"
    r"ptr\s*\[0x([0-9a-f]+)\]\s*,", re.IGNORECASE)
_RANGE = re.compile(r"\bbytes\s+0x([0-9a-f]+)\s*[-–]\s*0x([0-9a-f]+)",
                    re.IGNORECASE)
_OVERLAP_WORD = re.compile(r"\boverlap\b|\bcleared\s+twice\b", re.IGNORECASE)
_ZERO_STORE = re.compile(
    r"^MOV(?:APS|UPS|DQA|DQU)\s+xmmword\s+ptr\s*\[0x([0-9a-f]+)\],XMM0$",
    re.IGNORECASE)
_IMMEDIATE_STORE = re.compile(
    r"^MOV\s+(byte|word|dword|qword)\s+ptr\s*\[0x([0-9a-f]+)\],"
    r"0x([0-9a-f]+)$", re.IGNORECASE)
_CLEAR_CLAIM = re.compile(
    r"^Clears\s+(\d+)\s+bytes\s+starting\s+at\s+address\s+0x([0-9a-f]+)"
    r"\s+to\s+zero$", re.IGNORECASE)
_OVERWRITE_CLAIM = re.compile(
    r"^Overwrites\s+the\s+first\s+(\d+)\s+bytes\s+at\s+address\s+"
    r"0x([0-9a-f]+)\s+with\s+0x([0-9a-f]+)$", re.IGNORECASE)
_FINAL_CLAIM = re.compile(
    r"^After\s+execution,\s+the\s+(\d+)-byte\s+value\s+at\s+address\s+"
    r"0x([0-9a-f]+)\s+equals\s+0x([0-9a-f]+)$", re.IGNORECASE)
_TWICE_CLAIM = re.compile(
    r"^Bytes\s+0x([0-9a-f]+)\s*[-–]\s*0x([0-9a-f]+)\s+are\s+cleared\s+twice\b",
    re.IGNORECASE)


def overlap_claim_errors(claim: dict, evidence: dict) -> list[str]:
    """Check a stated overlap only when cited instructions give fixed store ranges."""
    statement = claim.get("statement")
    refs = claim.get("evidence_addresses")
    if not isinstance(statement, str) or not isinstance(refs, list):
        return []
    match = _RANGE.search(statement)
    if match is None or _OVERLAP_WORD.search(statement) is None:
        return []
    start, end = (int(value, 16) for value in match.groups())
    if start > end:
        return ["claimed overlap byte range is reversed"]
    stores = []
    for instruction in evidence.get("instructions", []):
        if instruction.get("address") not in refs:
            continue
        store = _STORE.match(instruction.get("text", ""))
        if store:
            address = int(store.group(2), 16)
            stores.append((address, address + _WIDTH[store.group(1).lower()] - 1))
    if len(stores) < 2:
        return []
    common_start = max(item[0] for item in stores)
    common_end = min(item[1] for item in stores)
    if common_start > common_end or start < common_start or end > common_end:
        return [f"claimed overlap 0x{start:x}-0x{end:x} is outside cited store "
                f"intersection 0x{common_start:x}-0x{common_end:x}"]
    return []


def fixed_memory_effects(evidence: dict) -> list[dict]:
    """Interpret a straight-line subset of x86 absolute stores, or abstain."""
    effects = []
    xmm0_zero = False
    instructions = evidence.get("instructions", [])
    if not instructions or instructions[-1].get("text", "").upper() != "RET":
        raise ValueError("fixed memory review needs a straight-line function ending in RET")
    for instruction in instructions[:-1]:
        address, text = instruction["address"], instruction["text"]
        if text.upper() == "PXOR XMM0,XMM0":
            xmm0_zero = True
            continue
        zero_store = _ZERO_STORE.match(text)
        if zero_store and xmm0_zero:
            effects.append({"address": address, "start": int(zero_store.group(1), 16),
                            "bytes": [0] * 16})
            continue
        immediate = _IMMEDIATE_STORE.match(text)
        if immediate:
            width = _WIDTH[immediate.group(1).lower()]
            value = int(immediate.group(3), 16)
            if value >= 1 << (width * 8):
                raise ValueError(f"immediate at {address} exceeds store width")
            effects.append({"address": address, "start": int(immediate.group(2), 16),
                            "bytes": list(value.to_bytes(width, "little"))})
            continue
        raise ValueError(f"unsupported instruction for fixed memory review: {address} {text}")
    if not effects:
        raise ValueError("fixed memory review found no stores")
    return effects


def review_fixed_memory_claims(claims: list[dict], evidence: dict) -> dict:
    """Review only explicitly parsed store, overlap, and final-value claims."""
    effects = fixed_memory_effects(evidence)
    final_bytes = {}
    zero_counts = {}
    for effect in effects:
        for offset, value in enumerate(effect["bytes"]):
            address = effect["start"] + offset
            final_bytes[address] = value
            if value == 0:
                zero_counts[address] = zero_counts.get(address, 0) + 1
    reviews = []
    covered_effects = set()
    for index, claim in enumerate(claims):
        statement = claim.get("statement", "")
        refs = set(claim.get("evidence_addresses", []))
        reason = "claim wording is outside the fixed-memory review grammar"
        outcome = "uncertain"
        cited = []
        clear = _CLEAR_CLAIM.match(statement)
        overwrite = _OVERWRITE_CLAIM.match(statement)
        final = _FINAL_CLAIM.match(statement)
        twice = _TWICE_CLAIM.match(statement)
        if clear:
            width, start = int(clear.group(1)), int(clear.group(2), 16)
            matches = [effect for effect in effects if effect["address"] in refs and
                       effect["start"] == start and len(effect["bytes"]) == width]
            if matches:
                effect = matches[0]
                cited = [effect["address"]]
                outcome = "supported_static" if all(value == 0 for value in
                                                effect["bytes"]) else "contradicted"
                reason = (f"store at {effect['address']} writes {width} bytes starting "
                          f"at 0x{start:x}")
                if outcome == "supported_static":
                    covered_effects.add(effect["address"])
        elif overwrite:
            width, start, value = (int(overwrite.group(1)), int(overwrite.group(2), 16),
                                   int(overwrite.group(3), 16))
            matches = [effect for effect in effects if effect["address"] in refs and
                       effect["start"] == start and len(effect["bytes"]) == width]
            if matches:
                effect = matches[0]
                cited = [effect["address"]]
                expected = (list(value.to_bytes(width, "little"))
                            if value < 1 << (width * 8) else None)
                outcome = ("supported_static" if effect["bytes"] == expected
                           else "contradicted")
                reason = f"store at {effect['address']} writes {width} bytes at 0x{start:x}"
                if outcome == "supported_static":
                    covered_effects.add(effect["address"])
        elif final:
            width, start, value = (int(final.group(1)), int(final.group(2), 16),
                                   int(final.group(3), 16))
            actual = ([final_bytes.get(start + offset) for offset in range(width)]
                      if 0 < width <= 64 else [])
            matching = [effect["address"] for effect in effects
                        if effect["address"] in refs and
                        effect["start"] <= start < effect["start"] + len(effect["bytes"])]
            if actual and None not in actual and matching:
                cited = matching
                expected = (list(value.to_bytes(width, "little"))
                            if value < 1 << (width * 8) else None)
                outcome = ("supported_static" if actual == expected else "contradicted")
                reason = f"the last writes leave {bytes(actual).hex()} at 0x{start:x}"
        elif twice:
            start, end = int(twice.group(1), 16), int(twice.group(2), 16)
            matching = [effect["address"] for effect in effects
                        if effect["address"] in refs and
                        effect["start"] <= start and
                        effect["start"] + len(effect["bytes"]) - 1 >= end and
                        all(value == 0 for value in effect["bytes"][
                            start - effect["start"]:end - effect["start"] + 1])]
            if start <= end and end - start < 1024 and matching:
                cited = matching
                outcome = ("supported_static" if len(matching) >= 2 and all(
                    zero_counts.get(address, 0) >= 2 for address in range(start, end + 1))
                    else "contradicted")
                reason = (f"{len(matching)} cited zero stores cover each byte from "
                          f"0x{start:x} through 0x{end:x}")
        reviews.append({"claim_index": index, "outcome": outcome, "reason": reason,
                        "evidence_addresses": cited})
    missing = [f"unclaimed store at {effect['address']} writes "
               f"0x{effect['start']:x}-0x{effect['start'] + len(effect['bytes']) - 1:x}"
               for effect in effects if effect["address"] not in covered_effects]
    return {"reviews": reviews, "missing_behavior": missing, "unresolved": []}
