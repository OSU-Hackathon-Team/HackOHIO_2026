"""Differential check: clean-room vector slice vs the original libforlo.so.

Both sides construct onto a poison-filled buffer, so the comparison covers the
object bytes *and* the footprint: a routine that writes more than the three
fields leaves a different tail. Validity answers are compared for the states
the constructors produce plus hand-set flag bytes, including non-canonical
values a bool conversion has to collapse.
"""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT / "decomp-state" / "fixtures" / "calc" / "libforlo.so"
SOURCE = ROOT / "reimpl" / "vector_ref_array.c"
BUILD = ROOT / "decomp-state" / "reimpl"
LIBRARY = BUILD / "libvector_ref_array_reimpl.so"

LO_PROGRAM = "/usr/lib/libreoffice/program"
WINDOW = 0x20          # bytes compared around the 17-byte object
POISON = 0xAA          # tail marker in every fresh buffer

ORIGINAL_CTORS = {
    "empty": "_ZN7formula14VectorRefArrayC1Ev",
    "invalid": "_ZN7formula14VectorRefArrayC1ENS0_11InitInvalidE",
    "numbers": "_ZN7formula14VectorRefArrayC1EPKd",
    "strings": "_ZN7formula14VectorRefArrayC1EPP12_rtl_uString",
    "mixed": "_ZN7formula14VectorRefArrayC1EPKdPP12_rtl_uString",
}
ORIGINAL_IS_VALID = "_ZNK7formula14VectorRefArray7isValidEv"
REIMPL_CTORS = {
    "empty": "vrar_init_empty",
    "invalid": "vrar_init_invalid",
    "numbers": "vrar_init_numbers",
    "strings": "vrar_init_strings",
    "mixed": "vrar_init_mixed",
}
REIMPL_IS_VALID = "vrar_is_valid"


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


def bind(library: ctypes.CDLL, ctors: dict, is_valid: str) -> tuple[dict, object]:
    bound = {}
    for name, symbol in ctors.items():
        fn = getattr(library, symbol)
        fn.argtypes = [ctypes.c_void_p] * (1 + (name in ("numbers", "strings"))
                                           + 2 * (name == "mixed"))
        fn.restype = None
        bound[name] = fn
    valid = getattr(library, is_valid)
    valid.argtypes = [ctypes.c_void_p]
    valid.restype = ctypes.c_bool
    return bound, valid


def fresh_buffer() -> ctypes.Array:
    return ctypes.create_string_buffer(bytes([POISON]) * WINDOW, WINDOW)


def main() -> int:
    if not ORIGINAL.exists():
        raise SystemExit(f"missing original binary: {ORIGINAL}")
    _ensure_loader_path()
    build()
    original = ctypes.CDLL(str(ORIGINAL), mode=ctypes.RTLD_GLOBAL)
    reimpl = ctypes.CDLL(str(LIBRARY))
    o_ctors, o_valid = bind(original, ORIGINAL_CTORS, ORIGINAL_IS_VALID)
    r_ctors, r_valid = bind(reimpl, REIMPL_CTORS, REIMPL_IS_VALID)

    numbers = (ctypes.c_double * 4)(1.5, -2.25, 0.0, 1e308)
    strings = (ctypes.c_void_p * 3)(0, 0x1234567890, 0xFFFFFFFFFFFFFFFF)
    argument_sets = {
        "empty": [()],
        "invalid": [()],
        "numbers": [(ctypes.addressof(numbers),), (0,)],
        "strings": [(ctypes.addressof(strings),), (0,)],
        "mixed": [(ctypes.addressof(numbers), ctypes.addressof(strings)),
                  (0, ctypes.addressof(strings)),
                  (ctypes.addressof(numbers), 0),
                  (0, 0)],
    }

    failures: list[str] = []
    checks = 0
    for name, arg_sets in argument_sets.items():
        for args in arg_sets:
            left = fresh_buffer()
            o_ctors[name](ctypes.addressof(left), *args)
            right = fresh_buffer()
            r_ctors[name](ctypes.addressof(right), *args)
            checks += 1
            if bytes(left.raw) != bytes(right.raw):
                failures.append(f"{name}{args}: original={bytes(left.raw).hex()} "
                                f"reimpl={bytes(right.raw).hex()}")
            checks += 1
            want = o_valid(ctypes.addressof(left))
            got = r_valid(ctypes.addressof(right))
            if want != got:
                failures.append(f"{name}{args} isValid: original={want} reimpl={got}")

    # Non-canonical flag bytes: the query has to collapse them like a bool.
    for flag in (0, 1, 2, 0x7F, 0x80, 0xFF):
        left = fresh_buffer()
        right = fresh_buffer()
        left[0x10] = flag
        right[0x10] = flag
        checks += 1
        want = o_valid(ctypes.addressof(left))
        got = r_valid(ctypes.addressof(right))
        if want != got:
            failures.append(f"isValid(flag={flag:#04x}): original={want} reimpl={got}")

    print(f"cases: {checks}, mismatches: {len(failures)}")
    for failure in failures:
        print("  " + failure)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
