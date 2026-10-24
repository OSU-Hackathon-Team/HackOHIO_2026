"""Build source-known native fixtures and record reproducible identities.

Only stripped paths in the manifest should be given to analysis workers. Debug
companions and source remain evaluator material.
"""

import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "fixtures" / "decomp" / "native_lab.c"
OUTPUT = ROOT / "decomp-state" / "fixtures"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    compiler = subprocess.check_output(["gcc", "--version"], text=True).splitlines()[0]
    manifest = {"source_sha256": digest(SOURCE), "compiler": compiler,
                "expected": {
                    "default_stdout": "result=42 total=1 accepted=1 callbacks=1",
                    "odd_stdout": "result=-2 total=1 accepted=0 callbacks=1",
                    "malformed_status": -1,
                    "initial_state": {"total": 0, "accepted": 0, "last": 0}},
                "builds": []}
    for optimization in ("O0", "O2"):
        for kind in ("executable", "shared"):
            name = f"native_lab_{optimization}_{kind}"
            original = OUTPUT / (name + ".debugbin")
            stripped = OUTPUT / (name + (".so" if kind == "shared" else ".bin"))
            flags = ["gcc", "-g", "-fno-omit-frame-pointer", f"-{optimization}"]
            if kind == "shared":
                flags += ["-shared", "-fPIC"]
            flags += [str(SOURCE), "-o", str(original)]
            run(flags)
            run(["objcopy", "--only-keep-debug", str(original), str(OUTPUT / (name + ".debug"))])
            run(["objcopy", "--strip-all", str(original), str(stripped)])
            manifest["builds"].append({"kind": kind, "optimization": optimization,
                                       "analysis_path": str(stripped),
                                       "analysis_sha256": digest(stripped),
                                       "debug_path": str(OUTPUT / (name + ".debug"))})
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(OUTPUT / "manifest.json")


if __name__ == "__main__":
    main()
