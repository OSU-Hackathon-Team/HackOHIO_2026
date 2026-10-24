"""Evidence-driven verification of cleanroom reimplementability from the generated specification."""

import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.artifacts import LocalArtifactStore
from engine.analysis.ghidra import GhidraAnalysis
from engine.validation.probes import NativeProbeRunner

def main() -> None:
    state_dir = ROOT / "decomp-state"
    store = LocalArtifactStore(state_dir / "artifacts")
    
    # Load the latest specification pointer
    spec_pointer_file = state_dir / "specifications" / "19e7cf3c3d707284a78c751be79c2f8b963df6a9f69f020df77594c677cf98e6" / "latest.json"
    assert spec_pointer_file.exists(), f"Missing spec pointer at {spec_pointer_file}"
    pointer = json.loads(spec_pointer_file.read_text())
    
    spec = json.loads(store.get(pointer["artifact"]))
    audit = json.loads(store.get(pointer["audit_artifact"]))
    
    print(f"Loaded generated specification artifact: {pointer['artifact']}")
    print(f"Spec title: {spec['title']}")
    print(f"Requirements count: {len(spec['requirements'])}")
    print(f"Status: {spec['status']}")
    
    assert spec["schema"] == 2
    assert spec["status"] == "ready_for_review"
    assert len(spec["requirements"]) >= 30
    
    # Verify that the public spec has NO source code or leak keywords
    public_spec_json = json.dumps(spec)
    for forbidden in ["MOVAPS", "MOVUPS", "PXOR", "param_1", "DAT_", "0x00104040", "RAX", "RDI", "EAX"]:
        assert forbidden not in public_spec_json, f"Forbidden source term {forbidden} found in public specification!"
    print("Verification: Public specification contains ZERO source leaks or assembly mnemonics.")
    
    # Now, implement the subsystem strictly according to the spec's requirements:
    # REQ-1 to REQ-5: telemetry_reset sets seen, accepted, rejected, sum to 0; low to 4294967295; high to 0; last to 0; buckets to 0.
    # REQ-6 to REQ-7: marker_ok: ptr != NULL && len == 6 && packet[0] == 165 (0xa5)
    # REQ-8: read_kind: packet[1]
    # REQ-9: read_value: packet[2] | (packet[3] << 8)
    # REQ-10: read_flags: packet[5]
    # REQ-11 to REQ-12: calculate_check: (packet[1] ^ packet[2] ^ packet[3] ^ packet[5] ^ 90) & 255; check_matches: packet[4] == calculated
    # REQ-13: kind_allowed: kind >= 1 && kind <= 4
    # REQ-14: value_allowed: value <= ((flags & 1) ? 4095 : 1023)
    # REQ-15: scale_value: value * kind
    # REQ-16: clamp_value: value > 10000 ? 10000 : value
    # REQ-17 to REQ-23: choose_bucket: <100 => 0, 100..999 => 1, 1000..4999 => 2, >=5000 => 3
    # REQ-24 to REQ-30: state recording functions
    # REQ-31 to REQ-33: telemetry_apply
    # REQ-34: telemetry_snapshot
    
    cleanroom_c_code = """/* Cleanroom implementation generated solely from NativeSubsystemSpec */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

struct telemetry_state {
    uint32_t seen;
    uint32_t accepted;
    uint32_t rejected;
    uint32_t sum;
    uint32_t low;
    uint32_t high;
    uint32_t last;
    uint32_t buckets[4];
};

static struct telemetry_state state;

void telemetry_reset(void) {
    memset(&state, 0, sizeof(state));
    state.low = 4294967295U;
}

int marker_ok(const uint8_t *packet, uint32_t length) {
    return packet != NULL && length == 6 && packet[0] == 0xa5;
}

uint32_t read_kind(const uint8_t *packet) {
    return packet[1];
}

uint32_t read_value(const uint8_t *packet) {
    return (uint32_t)packet[2] | ((uint32_t)packet[3] << 8);
}

uint32_t read_flags(const uint8_t *packet) {
    return packet[5];
}

uint32_t calculate_check(const uint8_t *packet) {
    return (packet[1] ^ packet[2] ^ packet[3] ^ packet[5] ^ 0x5a) & 0xff;
}

int check_matches(const uint8_t *packet, uint32_t calculated) {
    return packet[4] == calculated;
}

int kind_allowed(uint32_t kind) {
    return kind >= 1 && kind <= 4;
}

int value_allowed(uint32_t value, uint32_t flags) {
    return value <= ((flags & 1) ? 4095U : 1023U);
}

uint32_t scale_value(uint32_t value, uint32_t kind) {
    return value * kind;
}

uint32_t clamp_value(uint32_t value) {
    return value > 10000U ? 10000U : value;
}

uint32_t choose_bucket(uint32_t value) {
    if (value < 100U) return 0;
    if (value < 1000U) return 1;
    if (value < 5000U) return 2;
    return 3;
}

void record_seen(void) {
    state.seen++;
}

void record_rejected(void) {
    state.rejected++;
}

void record_accepted(uint32_t bucket) {
    state.accepted++;
    state.buckets[bucket]++;
}

void record_sum(uint32_t value) {
    state.sum += value;
}

void record_low(uint32_t value) {
    if (value < state.low) state.low = value;
}

void record_high(uint32_t value) {
    if (value > state.high) state.high = value;
}

void record_last(uint32_t value) {
    state.last = value;
}

int32_t telemetry_apply(const uint8_t *packet, uint32_t length) {
    if (!marker_ok(packet, length)) return -1;
    uint32_t kind = read_kind(packet);
    uint32_t value = read_value(packet);
    uint32_t flags = read_flags(packet);
    if (!check_matches(packet, calculate_check(packet))) return -1;
    record_seen();
    if (!kind_allowed(kind) || !value_allowed(value, flags)) {
        record_rejected();
        return -2;
    }
    uint32_t transformed = clamp_value(scale_value(value, kind));
    uint32_t bucket = choose_bucket(transformed);
    record_accepted(bucket);
    record_sum(transformed);
    record_low(transformed);
    record_high(transformed);
    record_last(transformed);
    return (int32_t)transformed;
}

struct telemetry_state telemetry_snapshot(void) {
    return state;
}
"""
    cleanroom_src = state_dir / "fixtures" / "cleanroom_telemetry.c"
    cleanroom_so = state_dir / "fixtures" / "cleanroom_telemetry.so"
    cleanroom_src.write_text(cleanroom_c_code)
    
    # Compile
    cmd = ["gcc", "-shared", "-fPIC", "-O2", str(cleanroom_src), "-o", str(cleanroom_so)]
    build_res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    print(f"Compiled cleanroom shared library to {cleanroom_so}")
    
    # Create temporary fixture manifest for probe runner pointing to cleanroom_so
    import hashlib
    cleanroom_manifest = {
        "builds": [
            {
                "kind": "shared",
                "optimization": "O2",
                "analysis_path": str(cleanroom_so.resolve()),
                "analysis_sha256": hashlib.sha256(cleanroom_so.read_bytes()).hexdigest(),
            }
        ]
    }
    manifest_path = state_dir / "fixtures" / "cleanroom_manifest.json"
    manifest_path.write_text(json.dumps(cleanroom_manifest, indent=2))
    
    # Run blackbox probe suite
    engine = GhidraAnalysis(state_dir, Path("/opt/ghidra/support/analyzeHeadless"))
    adapter_path = ROOT / "scripts" / "telemetry_probe_adapter.py"
    runner = NativeProbeRunner(engine, adapter_path)
    
    # Test apply probes suite
    suite_apply = ROOT / "fixtures" / "decomp" / "telemetry_apply_probes.json"
    report_apply = runner.run_suite(manifest_path, suite_apply)
    print("Telemetry Apply Suite Results:", report_apply["counts"], "Complete:", report_apply["complete"])
    assert report_apply["complete"] is True
    assert report_apply["counts"].get("agreement", 0) == 7
    assert report_apply["counts"].get("disagreement", 0) == 0
    assert report_apply["counts"].get("error", 0) == 0
    
    # Test bucket probes suite
    suite_bucket = ROOT / "fixtures" / "decomp" / "telemetry_probes.json"
    report_bucket = runner.run_suite(manifest_path, suite_bucket)
    print("Telemetry Bucket Suite Results:", report_bucket["counts"], "Complete:", report_bucket["complete"])
    assert report_bucket["complete"] is True
    assert report_bucket["counts"].get("agreement", 0) == 8
    assert report_bucket["counts"].get("disagreement", 0) == 0
    assert report_bucket["counts"].get("error", 0) == 0
    
    print("\n========================================================")
    print("CLEANROOM REIMPLEMENTATION VERIFICATION: 100% SUCCESSFUL!")
    print(f"Total Probe Cases Passed: {report_apply['counts']['agreement'] + report_bucket['counts']['agreement']}/15")
    print("Zero disagreements, zero errors.")
    print("========================================================")

if __name__ == "__main__":
    main()
