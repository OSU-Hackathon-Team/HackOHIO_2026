"""Held-out executable and shared-library behavior checks for telemetry fixture."""

import ctypes
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "decomp-state" / "fixtures" / "telemetry_manifest.json"


class Snapshot(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in
                ("seen", "accepted", "rejected", "sum", "low", "high", "last")]
    _fields_ += [("buckets", ctypes.c_uint32 * 4)]


def packet(kind: int, value: int, flags: int = 0) -> bytes:
    raw = bytearray((0xa5, kind, value & 0xff, (value >> 8) & 0xff, 0, flags))
    raw[4] = raw[1] ^ raw[2] ^ raw[3] ^ raw[5] ^ 0x5a
    return bytes(raw)


def snapshot(value: Snapshot) -> dict:
    return {name: getattr(value, name) for name in
            ("seen", "accepted", "rejected", "sum", "low", "high", "last")} | {
                "buckets": list(value.buckets)}


def main() -> None:
    manifest = json.loads(MANIFEST.read_text())
    results = []
    for build in manifest["builds"]:
        path = Path(build["analysis_path"])
        if build["kind"] == "executable":
            cases = [([], 0, "result=84 seen=1 accepted=1 rejected=0 "
                      "sum=84 low=84 high=84 last=84"),
                     (["2", "1024"], 1, "result=-2 seen=1 accepted=0 rejected=1 "
                      "sum=0 low=4294967295 high=0 last=0"),
                     (["4", "4000", "1"], 0, "result=10000 seen=1 accepted=1 "
                      "rejected=0 sum=10000 low=10000 high=10000 last=10000")]
            for args, code, expected in cases:
                completed = subprocess.run([str(path), *args], capture_output=True,
                                           text=True, timeout=3, check=False)
                assert completed.returncode == code, (build, args, completed)
                assert completed.stdout.strip() == expected, (build, args, completed)
                results.append({"binary_sha256": build["analysis_sha256"],
                                "case": "executable:" + ",".join(args or ["default"]),
                                "outcome": "agreement"})
        else:
            library = ctypes.CDLL(str(path))
            library.telemetry_reset.argtypes = []
            library.telemetry_apply.argtypes = [ctypes.POINTER(ctypes.c_uint8),
                                                ctypes.c_uint32]
            library.telemetry_apply.restype = ctypes.c_int32
            library.telemetry_snapshot.argtypes = []
            library.telemetry_snapshot.restype = Snapshot

            def apply(raw: bytes) -> int:
                buffer = (ctypes.c_uint8 * len(raw)).from_buffer_copy(raw)
                return library.telemetry_apply(buffer, len(raw))

            library.telemetry_reset()
            assert library.telemetry_apply(None, 0) == -1
            assert snapshot(library.telemetry_snapshot()) == {
                "seen": 0, "accepted": 0, "rejected": 0, "sum": 0,
                "low": 4294967295, "high": 0, "last": 0, "buckets": [0, 0, 0, 0]}
            malformed = bytearray(packet(2, 42))
            malformed[4] ^= 1
            assert apply(malformed) == -1
            assert apply(packet(2, 42)) == 84
            assert apply(packet(0, 5)) == -2
            assert apply(packet(2, 1000)) == 2000
            assert snapshot(library.telemetry_snapshot()) == {
                "seen": 3, "accepted": 2, "rejected": 1, "sum": 2084,
                "low": 84, "high": 2000, "last": 2000, "buckets": [1, 0, 1, 0]}
            results.append({"binary_sha256": build["analysis_sha256"],
                            "case": "shared:malformed-and-state-sequence",
                            "outcome": "agreement"})
    report = {"source_sha256": manifest["source_sha256"], "results": results,
              "agreement_count": len(results)}
    output = MANIFEST.with_name("telemetry_probe_report.json")
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"agreement_count": len(results), "report": str(output)}))


if __name__ == "__main__":
    main()
