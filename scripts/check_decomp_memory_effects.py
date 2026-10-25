"""Check fixed-store review against a real reset shape and a false overlap."""

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.validation.memory_ranges import review_fixed_memory_claims  # noqa: E402
from engine.worker import validate_answer  # noqa: E402


def main() -> None:
    evidence = {"entry": "00101270", "references": [], "instructions": [
        {"address": "00101270", "text": "PXOR XMM0,XMM0"},
        {"address": "00101274", "text": "MOVAPS xmmword ptr [0x00104050],XMM0"},
        {"address": "0010127b", "text": "MOVAPS xmmword ptr [0x00104040],XMM0"},
        {"address": "00101282", "text": "MOV dword ptr [0x00104050],0xffffffff"},
        {"address": "0010128c", "text": "MOVUPS xmmword ptr [0x0010405c],XMM0"},
        {"address": "00101293", "text": "RET"}]}
    claims = [
        {"statement": "Clears 16 bytes starting at address 0x00104040 to zero",
         "evidence_addresses": ["00101270", "0010127b"]},
        {"statement": "Clears 16 bytes starting at address 0x00104050 to zero",
         "evidence_addresses": ["00101270", "00101274"]},
        {"statement": "Overwrites the first 4 bytes at address 0x00104050 with 0xffffffff",
         "evidence_addresses": ["00101282"]},
        {"statement": "Clears 16 bytes starting at address 0x0010405c to zero",
         "evidence_addresses": ["00101270", "0010128c"]},
        {"statement": "After execution, the 4-byte value at address 0x00104050 "
                      "equals 0xffffffff", "evidence_addresses": ["00101282"]},
        {"statement": "Bytes 0x0010405c-0x0010405f are cleared twice",
         "evidence_addresses": ["00101274", "0010128c"]}]
    reviewed = review_fixed_memory_claims(claims, evidence)
    assert [item["outcome"] for item in reviewed["reviews"]] == [
        "supported_static"] * len(claims)
    assert reviewed["missing_behavior"] == []
    wrong = [*claims[:-1], {**claims[-1], "statement":
                            "Bytes 0x00104050-0x0010405b are cleared twice"}]
    assert review_fixed_memory_claims(wrong, evidence)["reviews"][-1]["outcome"] \
        == "contradicted"
    answer = {"inputs": "none", "outputs": "none", "state": "reset",
              "side_effects": "writes memory", "errors": "none",
              "pseudocode": "reset fields", "claims": [{**claim, "assumptions": [],
                                                   "alternatives": []} for claim in wrong],
              "dependencies": [], "unknowns": [], "evidence_requests": []}
    assert any("outside cited store intersection" in error for error in
               validate_answer(answer, evidence))
    assert review_fixed_memory_claims(claims[:2], evidence)["missing_behavior"]
    try:
        review_fixed_memory_claims(claims, {**evidence, "instructions": [
            *evidence["instructions"][:-1],
            {"address": "00101290", "text": "CALL unknown"},
            evidence["instructions"][-1]]})
    except ValueError:
        pass
    else:
        raise AssertionError("unsupported instruction was silently reviewed")
    print("fixed memory review: correct reset supported, false overlap rejected")


if __name__ == "__main__":
    main()
