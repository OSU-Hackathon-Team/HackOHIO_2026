"""Invoke a plain C functional token-array implementation for comparison."""

from __future__ import annotations

import ctypes
import json
import sys

OPS = {"add_opcode": 1, "add_double": 2, "clear": 3, "finalize": 4, "copy": 5}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: c_token_array_candidate_adapter.py <candidate.so>")
    request = json.load(sys.stdin)
    steps, queries = request["steps"], request["queries"]
    if len(steps) > 48 or len(queries) > 16 or any(
            step.get("op") not in OPS for step in steps):
        raise ValueError("invalid token request")
    if any(type(q) is not int or not 0 <= q < 65536 for q in queries):
        raise ValueError("invalid query")
    n, m = len(steps), len(queries)
    codes = (ctypes.c_uint8 * max(n, 1))(*[OPS[x["op"]] for x in steps])
    opcodes = (ctypes.c_uint16 * max(n, 1))(*[
        x.get("value", 0) if x["op"] == "add_opcode" else 0 for x in steps])
    numbers = (ctypes.c_double * max(n, 1))(*[
        x.get("value", 0.0) if x["op"] == "add_double" else 0.0 for x in steps])
    query_data = (ctypes.c_uint16 * max(m, 1))(*queries)
    row_size = 4 + m
    output = (ctypes.c_uint8 * ((n + 1) * row_size))()
    function = getattr(ctypes.CDLL(sys.argv[1]), "token_array_run")
    function.argtypes = [ctypes.POINTER(ctypes.c_uint8),
                         ctypes.POINTER(ctypes.c_uint16),
                         ctypes.POINTER(ctypes.c_double), ctypes.c_uint32,
                         ctypes.POINTER(ctypes.c_uint16), ctypes.c_uint32,
                         ctypes.POINTER(ctypes.c_uint8)]
    function.restype = ctypes.c_int
    status = function(codes, opcodes, numbers, n, query_data, m, output)
    if status:
        raise RuntimeError(f"token_array_run failed: {status}")
    snapshots = []
    for i in range(n + 1):
        row = output[i * row_size:(i + 1) * row_size]
        snapshots.append({"nonempty": bool(row[0]),
                          "has_references": bool(row[1]),
                          "has_external_ref": bool(row[2]),
                          "has_name": bool(row[3]),
                          "has_opcode": [bool(value) for value in row[4:]]})
    print(json.dumps({"snapshots": snapshots}, sort_keys=True))


if __name__ == "__main__":
    main()
