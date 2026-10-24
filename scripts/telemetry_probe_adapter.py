"""Evaluator-owned original shared-library adapter for telemetry probes."""

import ctypes
import json
from pathlib import Path
import sys


class Snapshot(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in
                ("seen", "accepted", "rejected", "sum", "low", "high", "last")]
    _fields_ += [("buckets", ctypes.c_uint32 * 4)]


def snapshot(value: Snapshot) -> dict:
    return {name: getattr(value, name) for name in
            ("seen", "accepted", "rejected", "sum", "low", "high", "last")} | {
                "buckets": list(value.buckets)}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: telemetry_probe_adapter.py <shared-library>")
    request = json.load(sys.stdin)
    library = ctypes.CDLL(str(Path(sys.argv[1]).resolve(strict=True)))
    if request.get("operation") == "choose_bucket":
        library.choose_bucket.argtypes = [ctypes.c_uint32]
        library.choose_bucket.restype = ctypes.c_uint32
        print(json.dumps({"return": library.choose_bucket(request["value"])}))
        return
    if request.get("operation") != "telemetry_sequence":
        raise ValueError("unknown telemetry probe operation")
    library.telemetry_reset.argtypes = []
    library.telemetry_reset.restype = None
    library.telemetry_apply.argtypes = [ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint32]
    library.telemetry_apply.restype = ctypes.c_int32
    library.telemetry_snapshot.argtypes = []
    library.telemetry_snapshot.restype = Snapshot
    library.telemetry_reset()
    returns = []
    for frame in request["frames"]:
        data = frame.get("data")
        buffer = (ctypes.c_uint8 * len(data))(*data) if data is not None else None
        returns.append(library.telemetry_apply(
            buffer, frame.get("length", len(data) if data is not None else 0)))
    print(json.dumps({"returns": returns,
                      "state": snapshot(library.telemetry_snapshot())}))


if __name__ == "__main__":
    main()
