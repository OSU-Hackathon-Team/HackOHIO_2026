"""Exercise held-out native behaviors against the original shared libraries."""

import ctypes
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "decomp-state" / "fixtures" / "manifest.json"


def probe(path: Path) -> dict:
    library = ctypes.CDLL(str(path))
    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_uint32, ctypes.c_void_p)
    library.parse_frame.argtypes = [ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint32,
                                    callback_type, ctypes.c_void_p]
    library.parse_frame.restype = ctypes.c_int32
    library.reset_state()
    observed = []

    def callback(value, context):
        observed.append(value)
        return value % 2 == 0

    handler = callback_type(callback)

    def frame(value):
        low, high = value & 255, (value >> 8) & 255
        return (ctypes.c_uint8 * 4)(0x5a, low, high, low ^ high ^ 0x5a)

    empty = (ctypes.c_uint8 * 4)(0, 0, 0, 0)
    cases = [
        ("null", None, 4, -1),
        ("short", frame(2), 3, -1),
        ("bad_magic", empty, 4, -1),
        ("zero", frame(0), 4, 0),
        ("odd", frame(65535), 4, -2),
        ("maximum_even", frame(65534), 4, 65534),
    ]
    results = []
    for name, data, size, expected in cases:
        actual = library.parse_frame(data, size, handler, None)
        results.append({"case": name, "expected": expected, "observed": actual,
                        "pass": actual == expected})
    state = {"total": library.read_total(),
             "accepted": library.read_accepted(),
             "last": library.read_last(), "callbacks": observed}
    expected_state = {"total": 3, "accepted": 2, "last": 65534,
                      "callbacks": [0, 65535, 65534]}
    if state != expected_state:
        raise AssertionError(f"state mismatch: {state} != {expected_state}")
    if not all(item["pass"] for item in results):
        raise AssertionError(f"probe mismatch: {results}")
    return {"path": str(path), "cases": results, "state": state}


def main() -> None:
    manifest = json.loads(MANIFEST.read_text())
    report = {"source_sha256": manifest["source_sha256"], "probes": []}
    for build in manifest["builds"]:
        binary = Path(build["analysis_path"])
        if build["kind"] == "shared":
            report["probes"].append(probe(binary))
        else:
            for argument, expected in (("42", "result=42 total=1 accepted=1 callbacks=1"),
                                       ("43", "result=-2 total=1 accepted=0 callbacks=1")):
                result = subprocess.run([str(binary), argument], text=True,
                                        capture_output=True, check=False)
                if result.stdout.strip() != expected or result.returncode != (1 if argument == "43" else 0):
                    raise AssertionError(f"executable mismatch: {result}")
                report["probes"].append({"path": str(binary), "argument": argument,
                                         "stdout": result.stdout.strip(),
                                         "exit_code": result.returncode})
    output = MANIFEST.parent / "probe-report.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    main()
