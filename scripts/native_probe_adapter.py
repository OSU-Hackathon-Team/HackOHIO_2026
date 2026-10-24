"""Evaluator-owned ctypes adapter for the source-known native fixture."""

import ctypes
import json
from pathlib import Path
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: native_probe_adapter.py <shared-library>")
    library = ctypes.CDLL(str(Path(sys.argv[1]).resolve(strict=True)))
    request = json.load(sys.stdin)
    if request["operation"] == "fold_depth":
        library.fold_depth.argtypes = [ctypes.c_uint32, ctypes.c_uint32]
        library.fold_depth.restype = ctypes.c_uint32
        result = library.fold_depth(request["value"], request["depth"])
        print(json.dumps({"return": result}))
        return
    if request["operation"] != "parse_sequence":
        raise ValueError("unknown probe operation")
    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint32, ctypes.c_void_p)
    library.parse_frame.argtypes = [ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint32,
                                    callback_type, ctypes.c_void_p]
    library.parse_frame.restype = ctypes.c_int32
    library.reset_state()
    seen = []

    def even_callback(value, context):
        seen.append(value)
        return int(value % 2 == 0)

    callback = callback_type(even_callback)
    returns = []
    for frame in request["frames"]:
        data = frame.get("data")
        buffer = (ctypes.c_uint8 * len(data))(*data) if data is not None else None
        selected = callback if frame.get("callback") == "even" else None
        returns.append(library.parse_frame(buffer, frame["length"], selected, None))
    print(json.dumps({"returns": returns,
                      "state": {"total": library.read_total(),
                                "accepted": library.read_accepted(),
                                "last": library.read_last()},
                      "callback_values": seen}))


if __name__ == "__main__":
    main()
