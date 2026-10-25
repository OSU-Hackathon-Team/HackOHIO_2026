"""Verification check for LibreOffice Calc Formula & Equation Engine subsystem.

Indexes and inspects compiled `libforlo.so` (LibreOffice Fresh 26.8.0-2 x86-64 Linux),
verifying that the recursive-descent formula compiler operator hierarchy,
the formula grammar bitmask mappings, and vectorized column array structures
are accurately extracted from binary evidence.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore


EXPECTED_SHA256 = "5fb252ad878732c08d8a7b6374f8e42009d1fac0b45d1909b11413f1e51cd03c"

COMPILER_OPERATORS = [
    ("CompileTokenArray", "0011b900"),
    ("Expression", "00118dc0"),
    ("CompareLine", "0011b790"),
    ("ConcatLine", "0011b630"),
    ("AddSubLine", "0011b4c0"),
    ("MulDivLine", "0011b350"),
    ("PowLine", "0011b1f0"),
    ("PostOpLine", "0011b130"),
    ("UnaryLine", "0011afd0"),
    ("UnionLine", "0011aef0"),
    ("IntersectionLine", "0011ac50"),
    ("RangeLine", "0011ab20"),
    ("Factor", "00118f90"),
]

GRAMMAR_FUNCTIONS = [
    ("mapAPItoGrammar", "0011fa10"),
    ("isSupported", "0011fa60"),
    ("setEnglishBit", "0011fb10"),
    ("mergeToGrammar", "0011fb30"),
]

VECTOR_FUNCTIONS = [
    ("VectorRefArray (default)", "00124e00"),
    ("VectorRefArray (invalid)", "00124e10"),
    ("VectorRefArray (double)", "00124e20"),
    ("VectorRefArray (string)", "00124e40"),
    ("VectorRefArray (mixed)", "00124e60"),
    ("isValid", "00124e70"),
]


def verify_calc_subsystem(state_dir: Path | None = None) -> dict:
    if state_dir is None:
        state_dir = ROOT / "decomp-state"
    state_dir = Path(state_dir).resolve()

    binary_path = state_dir / "fixtures" / "calc" / "libforlo.so"
    if not binary_path.exists():
        sys_lib = Path("/usr/lib/libreoffice/program/libforlo.so")
        if sys_lib.exists():
            binary_path.parent.mkdir(parents=True, exist_ok=True)
            binary_path.write_bytes(sys_lib.read_bytes())
        else:
            raise FileNotFoundError(f"Missing {binary_path} and system fallback {sys_lib}")

    # 1. SHA-256 verification
    file_bytes = binary_path.read_bytes()
    calc_sha256 = hashlib.sha256(file_bytes).hexdigest()
    print(f"=== Step 1: Binary Verification ===")
    print(f"  Binary: {binary_path.name} ({len(file_bytes)} bytes)")
    print(f"  SHA-256: {calc_sha256}")
    assert calc_sha256 == EXPECTED_SHA256, f"Expected {EXPECTED_SHA256}, got {calc_sha256}"

    # 2. Ghidra Headless Indexing
    print(f"\n=== Step 2: Ghidra Headless Intake & Indexing ===")
    headless = Path("/opt/ghidra/support/analyzeHeadless")
    engine = GhidraAnalysis(state_dir, headless, warm_workers=0)
    manifest = engine.analyze(binary_path)
    campaign = manifest["campaign"]
    print(f"  Campaign: {campaign}")
    print(f"  Indexed Functions: {manifest['function_count']}")
    assert manifest["function_count"] >= 600, f"Expected >= 600 functions, got {manifest['function_count']}"

    # 3. Artifact Store Verification
    store = LocalArtifactStore(state_dir / "artifacts")
    index = json.loads(store.get(manifest["index_artifact"]))
    functions_by_entry = {f["entry"]: f for f in index["functions"]}

    # 4. Verify Recursive-Descent Formula Compiler Functions
    print(f"\n=== Step 3: Verifying Recursive-Descent Operator Hierarchy ===")
    verified_compiler = []
    for name, entry in COMPILER_OPERATORS:
        fn = functions_by_entry.get(entry)
        assert fn is not None, f"Missing function {name} at entry {entry}"
        assert name.lower() in fn["name"].lower(), f"Name mismatch for {entry}: expected {name}, got {fn['name']}"
        print(f"  [OK] {entry}: {fn['name']}")
        verified_compiler.append({"entry": entry, "name": fn["name"]})

    # 5. Verify FormulaGrammar Subsystem
    print(f"\n=== Step 4: Verifying FormulaGrammar Subsystem ===")
    verified_grammar = []
    for name, entry in GRAMMAR_FUNCTIONS:
        fn = functions_by_entry.get(entry)
        assert fn is not None, f"Missing grammar function {name} at {entry}"
        print(f"  [OK] {entry}: {fn['name']}")
        verified_grammar.append({"entry": entry, "name": fn["name"]})

    # 6. Verify VectorRefArray Subsystem
    print(f"\n=== Step 5: Verifying VectorRefArray Subsystem ===")
    verified_vector = []
    for name, entry in VECTOR_FUNCTIONS:
        fn = functions_by_entry.get(entry)
        assert fn is not None, f"Missing vector function {name} at {entry}"
        print(f"  [OK] {entry}: {fn['name']}")
        verified_vector.append({"entry": entry, "name": fn["name"]})

    summary = {
        "binary": binary_path.name,
        "sha256": calc_sha256,
        "total_functions_indexed": len(index["functions"]),
        "compiler_operators_verified": len(verified_compiler),
        "grammar_functions_verified": len(verified_grammar),
        "vector_functions_verified": len(verified_vector),
        "status": "verified",
    }
    print("\n=======================================================")
    print("LIBREOFFICE CALC FORMULA SUBSYSTEM VERIFIED SUCCESSFULLY")
    print(json.dumps(summary, indent=2))
    print("=======================================================")
    return summary


if __name__ == "__main__":
    verify_calc_subsystem()
