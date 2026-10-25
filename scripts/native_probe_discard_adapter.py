"""Regression adapter: deliberately discards the original function's result."""

import ctypes
import json
from pathlib import Path
import sys


def main() -> None:
    library = ctypes.CDLL(str(Path(sys.argv[1]).resolve(strict=True)))
    request = json.load(sys.stdin)
    library.fold_depth.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
    library.fold_depth.restype = ctypes.c_uint32
    library.fold_depth(request["value"], request["depth"])
    print(json.dumps({"return": 0}))


if __name__ == "__main__":
    main()
