"""Evaluator-owned original shared-library adapter for telemetry helper probes."""

import ctypes
import json
from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: telemetry_probe_adapter.py <shared-library>")
    request = json.load(sys.stdin)
    if request.get("operation") != "choose_bucket":
        raise ValueError("unknown telemetry probe operation")
    library = ctypes.CDLL(str(Path(sys.argv[1]).resolve(strict=True)))
    library.choose_bucket.argtypes = [ctypes.c_uint32]
    library.choose_bucket.restype = ctypes.c_uint32
    print(json.dumps({"return": library.choose_bucket(request["value"])}))


if __name__ == "__main__":
    main()
