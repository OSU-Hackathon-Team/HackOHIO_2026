"""Differential check: clean-room formula grammar vs the original libforlo.so.

The reimplementation in reimpl/formula_grammar.c is written from the public
subsystem specification only. This script builds it, then drives it and the
original's exported grammar routines with the same inputs and requires
bit-identical results. Address-convention inputs are swept over their full
byte range; grammar words are swept over structured patterns plus a seeded
random sample so every failure is reproducible.
"""

from __future__ import annotations

import ctypes
import os
import random
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "decomp-state" / "fixtures" / "calc" / "libforlo.so"
SOURCE = ROOT / "reimpl" / "formula_grammar.c"
BUILD = ROOT / "decomp-state" / "reimpl"
LIBRARY = BUILD / "libformula_grammar_reimpl.so"

# Exported symbols of the original: formula::FormulaGrammar statics.
ORIGINAL_SYMBOLS = {
    "set_english": "_ZN7formula14FormulaGrammar13setEnglishBitENS0_7GrammarEb",
    "merge": "_ZN7formula14FormulaGrammar14mergeToGrammarENS0_7GrammarENS0_17AddressConventionE",
    "map_api": "_ZN7formula14FormulaGrammar15mapAPItoGrammarEbb",
    "is_supported": "_ZN7formula14FormulaGrammar11isSupportedENS0_7GrammarE",
}
REIMPL_SYMBOLS = {
    "set_english": "fg_set_english_bit",
    "merge": "fg_merge_to_grammar",
    "map_api": "fg_map_api_to_grammar",
    "is_supported": "fg_is_supported",
}

STANDARDS = (0x01030001, 0x00030003, 0x01020006, 0x00020003)

# libforlo.so needs its LibreOffice siblings on the loader path.
LO_PROGRAM = "/usr/lib/libreoffice/program"


def _ensure_loader_path() -> None:
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if LO_PROGRAM in current.split(":"):
        return
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = LO_PROGRAM + (":" + current if current else "")
    os.execve(sys.executable, [sys.executable, os.path.abspath(__file__), *sys.argv[1:]], env)


def build() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["gcc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-shared",
         "-fPIC", str(SOURCE), "-o", str(LIBRARY)],
        check=True, capture_output=True, text=True)


def bind(library: ctypes.CDLL, symbols: dict) -> dict:
    bound = {}
    for name, symbol in symbols.items():
        fn = getattr(library, symbol)
        if name == "set_english":
            fn.argtypes = [ctypes.c_uint32, ctypes.c_bool]
            fn.restype = ctypes.c_uint32
        elif name == "merge":
            fn.argtypes = [ctypes.c_uint32, ctypes.c_int]
            fn.restype = ctypes.c_uint32
        elif name == "map_api":
            fn.argtypes = [ctypes.c_bool, ctypes.c_bool]
            fn.restype = ctypes.c_uint32
        else:
            fn.argtypes = [ctypes.c_uint32]
            fn.restype = ctypes.c_bool
        bound[name] = fn
    return bound


def grammar_words(rng: random.Random) -> list[int]:
    words = [0, 0xFFFFFFFF, 0xFFFFFFFF & ~0x01000000, 0x00FFFFFF, 0xFFFFFF00]
    words += list(STANDARDS)
    words += [1 << bit for bit in range(32)]
    words += [word | 0x01000000 for word in STANDARDS]
    words += [word & ~0x01000000 for word in STANDARDS]
    words += [rng.getrandbits(32) for _ in range(20000)]
    words += [(bits << 16) | family
              for bits in range(0, 8) for family in (1, 2, 3, 6, 0xFFFF)]
    return words


def main() -> int:
    if not ORIGINAL.exists():
        raise SystemExit(f"missing original binary: {ORIGINAL}")
    _ensure_loader_path()
    build()
    original = bind(ctypes.CDLL(str(ORIGINAL), mode=ctypes.RTLD_GLOBAL), ORIGINAL_SYMBOLS)
    reimpl = bind(ctypes.CDLL(str(LIBRARY)), REIMPL_SYMBOLS)

    rng = random.Random(20261025)
    words = grammar_words(rng)
    failures: list[str] = []
    checks = 0

    def compare(kind: str, args: tuple, want: int, got: int) -> None:
        nonlocal checks
        checks += 1
        if want != got and len(failures) < 25:
            failures.append(f"{kind}{args}: original=0x{want:08X} reimpl=0x{got:08X}")

    for word in words:
        for english in (False, True):
            args = (word, english)
            compare("set_english", args, original["set_english"](*args),
                    reimpl["set_english"](*args))

    for word in words:
        for convention in list(range(-4, 12)) + [0x7F, 0x80, 0xFE, 0xFF, 0x100, 0x101]:
            args = (word, convention)
            compare("merge", args, original["merge"](*args), reimpl["merge"](*args))

    for english in (False, True):
        for odf in (False, True):
            args = (english, odf)
            compare("map_api", args, original["map_api"](*args), reimpl["map_api"](*args))

    # is_supported: sweep every family under several upper-word settings, then
    # every address/English combination for the interesting families.
    for english, convention in ((False, 0), (True, 0), (True, 1), (True, 2),
                                (False, 3), (True, 4), (True, 5), (True, 6),
                                (False, 0x0A), (True, 0xFF)):
        prefix = (int(english) << 24) | (convention << 16)
        for family in range(0x10000):
            word = prefix | family
            compare("is_supported", (word,), int(original["is_supported"](word)),
                    int(reimpl["is_supported"](word)))
    for english in (False, True):
        for convention in range(0x100):
            for family in (0, 1, 2, 3, 4, 5, 6, 0x10, 0x7FFF, 0x8000, 0x8001, 0xFFFF):
                word = (int(english) << 24) | (convention << 16) | family
                compare("is_supported", (word,), int(original["is_supported"](word)),
                        int(reimpl["is_supported"](word)))
    for _ in range(100000):
        word = rng.getrandbits(32)
        compare("is_supported", (word,), int(original["is_supported"](word)),
                int(reimpl["is_supported"](word)))

    print(f"cases: {checks}, mismatches: {len(failures)}")
    for failure in failures:
        print("  " + failure)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
