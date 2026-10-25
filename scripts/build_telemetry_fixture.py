"""Build stripped telemetry executables and shared objects with debug companions."""

import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "fixtures" / "decomp" / "telemetry_lab.c"
OUTPUT = ROOT / "decomp-state" / "fixtures"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    compiler = subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0]
    builds = []
    for optimization in ("O0", "O2"):
        for kind in ("executable", "shared"):
            name = f"telemetry_lab_{optimization}_{kind}"
            original = OUTPUT / f"{name}.debugbin"
            stripped = OUTPUT / (f"{name}.so" if kind == "shared" else f"{name}.bin")
            command = ["gcc", "-g", "-fno-omit-frame-pointer", "-fno-semantic-interposition",
                       f"-{optimization}"]
            if kind == "shared":
                command += ["-shared", "-fPIC"]
            command += [str(SOURCE), "-o", str(original)]
            subprocess.run(command, check=True)
            debug = OUTPUT / f"{name}.debug"
            subprocess.run(["objcopy", "--only-keep-debug", str(original), str(debug)],
                           check=True)
            subprocess.run(["objcopy", "--strip-all", str(original), str(stripped)],
                           check=True)
            builds.append({"kind": kind, "optimization": optimization,
                           "analysis_path": str(stripped),
                           "analysis_sha256": digest(stripped),
                           "debug_path": str(debug)})
    manifest = {"source_sha256": digest(SOURCE), "compiler": compiler, "builds": builds,
                "expected": {"default_result": 84, "policy_rejection": -2,
                             "malformed_result": -1}}
    path = OUTPUT / "telemetry_manifest.json"
    path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(path)


if __name__ == "__main__":
    main()
