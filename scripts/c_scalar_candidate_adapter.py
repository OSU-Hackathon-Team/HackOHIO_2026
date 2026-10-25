"""Invoke plain C scalar exports from a generated shared library."""

from __future__ import annotations

import ctypes
import json
import re
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: c_scalar_candidate_adapter.py <shared-library>")
    request = json.load(sys.stdin)
    symbol = request.get("symbol")
    arguments = request.get("args")
    if not isinstance(symbol, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", symbol):
        raise ValueError("invalid C export name")
    if not isinstance(arguments, list) or len(arguments) > 8:
        raise ValueError("invalid scalar argument list")
    function = getattr(ctypes.CDLL(sys.argv[1]), symbol)
    function.argtypes = [ctypes.c_bool if isinstance(value, bool) else ctypes.c_uint32
                         for value in arguments]
    function.restype = ctypes.c_uint32
    if any(not isinstance(value, (bool, int)) or
           (isinstance(value, int) and not isinstance(value, bool) and
            not 0 <= value < 2**32) for value in arguments):
        raise ValueError("arguments must be booleans or unsigned 32-bit integers")
    print(json.dumps({"return": int(function(*arguments))}))


if __name__ == "__main__":
    main()
