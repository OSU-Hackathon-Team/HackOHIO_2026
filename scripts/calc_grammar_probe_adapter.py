"""Evaluator-owned ctypes adapter for live FormulaGrammar probes.

Loads the target libforlo.so and invokes exported FormulaGrammar routines
with plain scalar arguments. Only allow-listed pure functions may be called.
LibreOffice program libraries are resolved via LD_LIBRARY_PATH; when the
current process lacks them, this adapter re-executes itself with the LibreOffice
program directory on the search path so NativeProbeRunner (which scrubs the
environment) still works.
"""

import ctypes
import json
import os
import sys


def _ensure_lo_libs() -> None:
    lodir = os.environ.get("LO_PROGRAM_DIR", "/usr/lib/libreoffice/program")
    if lodir in os.environ.get("LD_LIBRARY_PATH", "").split(":"):
        return
    if not os.path.isdir(lodir):
        raise SystemExit(
            f"LibreOffice program dir missing: {lodir} "
            "(set LO_PROGRAM_DIR to the directory holding libforlo.so)"
        )
    env = dict(os.environ)
    env["LD_LIBRARY_PATH"] = lodir + (":" + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else "")
    os.execve(sys.executable, [sys.executable, os.path.abspath(__file__), *sys.argv[1:]], env)


_ensure_lo_libs()


_MANGLED = {
    "mapAPItoGrammar": (
        "_ZN7formula14FormulaGrammar15mapAPItoGrammarEbb",
        ("bool", "bool"),
        "u64",
    ),
    "setEnglishBit": (
        "_ZN7formula14FormulaGrammar13setEnglishBitENS0_7GrammarEb",
        ("u32", "bool"),
        "u32",
    ),
    "isSupported": (
        "_ZN7formula14FormulaGrammar11isSupportedENS0_7GrammarE",
        ("u32",),
        "bool",
    ),
}


def _convert(value: object, kind: str) -> object:
    if kind == "bool":
        if isinstance(value, bool):
            return value
        raise ValueError(f"expected bool, got {value!r}")
    if kind in ("u32", "u64"):
        if isinstance(value, int) and 0 <= value < 2**64:
            return value
        raise ValueError(f"expected unsigned int, got {value!r}")
    raise ValueError(f"unknown arg kind {kind}")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: calc_grammar_probe_adapter.py <shared-library>")
    library = ctypes.CDLL(str(sys.argv[1]))
    request = json.load(sys.stdin)
    symbol = request.get("symbol")
    if symbol not in _MANGLED:
        raise ValueError(f"unknown probe symbol {symbol!r}")
    mangled, arg_kinds, restype = _MANGLED[symbol]
    args = request.get("args")
    if not isinstance(args, list) or len(args) != len(arg_kinds):
        raise ValueError(f"symbol {symbol} needs {len(arg_kinds)} args")
    func = getattr(library, mangled)
    func.argtypes = [
        ctypes.c_bool if kind == "bool" else ctypes.c_uint64 if kind == "u64" else ctypes.c_uint32
        for kind in arg_kinds
    ]
    func.restype = ctypes.c_bool if restype == "bool" else ctypes.c_uint32 if restype == "u32" else ctypes.c_uint64
    converted = [_convert(value, kind) for value, kind in zip(args, arg_kinds)]
    result = func(*converted)
    print(json.dumps({"return": int(result)}))


if __name__ == "__main__":
    main()
