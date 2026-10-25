"""Observe FormulaTokenArray behavior through exported C++ methods.

The original adapter owns an opaque, aligned object and invokes constructors and
methods. It never reads object bytes, pointers, vtables, or the implementation's
allocation layout. Its JSON output contains only functional query results.
"""

from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import sys

LO_PROGRAM = "/usr/lib/libreoffice/program"
MAX_STEPS = 48
MAX_QUERIES = 16


def _loader_path() -> None:
    current = os.environ.get("LD_LIBRARY_PATH", "")
    if LO_PROGRAM not in current.split(":"):
        env = dict(os.environ)
        env["LD_LIBRARY_PATH"] = LO_PROGRAM + (":" + current if current else "")
        os.execve(sys.executable, [sys.executable, str(Path(__file__).resolve()), *sys.argv[1:]], env)


def _bind(library, symbol, args, result=None):
    method = getattr(library, symbol)
    method.argtypes = args
    method.restype = result
    return method


def _validate(request):
    steps = request.get("steps")
    queries = request.get("queries")
    if not isinstance(steps, list) or len(steps) > MAX_STEPS:
        raise ValueError("invalid token steps")
    if not isinstance(queries, list) or len(queries) > MAX_QUERIES or not all(
            type(value) is int and 0 <= value < 65536 for value in queries):
        raise ValueError("invalid token queries")
    for step in steps:
        if not isinstance(step, dict) or step.get("op") not in {
                "add_opcode", "add_double", "clear", "finalize", "copy"}:
            raise ValueError("unsupported token operation")
        if step["op"] == "add_opcode" and not (
                type(step.get("value")) is int and 0 <= step["value"] < 65536):
            raise ValueError("invalid opcode")
        if step["op"] == "add_double" and not (
                type(step.get("value")) in (int, float) and
                abs(step["value"]) < 1e100):
            raise ValueError("invalid number")
    return steps, queries


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: calc_token_array_probe_adapter.py <libforlo.so>")
    _loader_path()
    steps, queries = _validate(json.load(sys.stdin))
    library = ctypes.CDLL(sys.argv[1])
    ptr = ctypes.c_void_p
    constructor = _bind(library, "_ZN7formula17FormulaTokenArrayC1Ev", [ptr])
    destructor = _bind(library, "_ZN7formula17FormulaTokenArrayD1Ev", [ptr])
    add_opcode = _bind(library, "_ZN7formula17FormulaTokenArray9AddOpCodeE6OpCode",
                       [ptr, ctypes.c_uint16], ptr)
    add_double = _bind(library, "_ZN7formula17FormulaTokenArray9AddDoubleEd",
                       [ptr, ctypes.c_double], ptr)
    clear = _bind(library, "_ZN7formula17FormulaTokenArray5ClearEv", [ptr])
    finalize = _bind(library, "_ZN7formula17FormulaTokenArray8FinalizeEv", [ptr])
    assign = _bind(library, "_ZN7formula17FormulaTokenArray6AssignERKS0_", [ptr, ptr])
    first = _bind(library, "_ZNK7formula17FormulaTokenArray10FirstTokenEv", [ptr], ptr)
    has_opcode = _bind(library, "_ZNK7formula17FormulaTokenArray9HasOpCodeE6OpCode",
                       [ptr, ctypes.c_uint16], ctypes.c_bool)
    has_refs = _bind(library, "_ZNK7formula17FormulaTokenArray13HasReferencesEv",
                     [ptr], ctypes.c_bool)
    has_external = _bind(library, "_ZNK7formula17FormulaTokenArray14HasExternalRefEv",
                         [ptr], ctypes.c_bool)
    has_name = _bind(library, "_ZNK7formula17FormulaTokenArray19HasNameOrColRowNameEv",
                     [ptr], ctypes.c_bool)
    # This is adapter-only storage for a constructed object, not a decoded ABI.
    storage = (ctypes.c_longdouble * 256)()
    address = ctypes.addressof(storage)
    constructor(address)
    snapshots = []
    try:
        def snapshot():
            return {"nonempty": bool(first(address)),
                    "has_opcode": [bool(has_opcode(address, value)) for value in queries],
                    "has_references": bool(has_refs(address)),
                    "has_external_ref": bool(has_external(address)),
                    "has_name": bool(has_name(address))}
        snapshots.append(snapshot())
        for step in steps:
            operation = step["op"]
            if operation == "add_opcode":
                add_opcode(address, step["value"])
            elif operation == "add_double":
                add_double(address, step["value"])
            elif operation == "clear":
                clear(address)
            elif operation == "finalize":
                finalize(address)
            else:
                other = (ctypes.c_longdouble * 256)()
                other_address = ctypes.addressof(other)
                constructor(other_address)
                try:
                    assign(other_address, address)
                    destructor(address)
                    constructor(address)
                    assign(address, other_address)
                finally:
                    destructor(other_address)
            snapshots.append(snapshot())
    finally:
        destructor(address)
    print(json.dumps({"snapshots": snapshots}, sort_keys=True))


if __name__ == "__main__":
    main()
