"""LibreOffice Calc as a native target: locate the install, drive it over UNO, record probes.

Probe records use the same shape as engine.validation.probes so engine.dossier and
engine.validation.gaps consume them unchanged. `observed` always comes from the running
LibreOffice; `expected` is the analyst's hypothesis from the case suite. A mismatch is a
finding (outcome "disagreement"), never something to paper over.
"""

from __future__ import annotations

import glob
import hashlib
import json
import math
from pathlib import Path
import subprocess
import threading
from typing import Callable

from engine.analysis.elfinfo import symbol_state
from engine.analysis.ghidra import file_hash

ROOT = Path(__file__).resolve().parents[1]
UNO_DRIVER = ROOT / "scripts" / "lo_uno_driver.py"
PROGRAM_DIR_GLOBS = ("/usr/lib/libreoffice/program", "/usr/lib64/libreoffice/program",
                     "/opt/libreoffice*/program", "/snap/libreoffice/current/lib/libreoffice/program")
LIBRARIES = {"calc": "libsclo.so", "formula": "libforlo.so"}
HELD_OUT_PERCENT = 30


def find_install(program_dirs: list[str] | None = None) -> dict:
    """The first program directory holding soffice.bin, with each library's hash and symbols."""
    for pattern in program_dirs or PROGRAM_DIR_GLOBS:
        for candidate in sorted(glob.glob(pattern)):
            program = Path(candidate)
            soffice = program / "soffice.bin"
            if not soffice.is_file():
                continue
            libraries = {}
            for key, name in LIBRARIES.items():
                path = program / name
                if path.is_file():
                    libraries[key] = {"path": str(path), "sha256": file_hash(path),
                                      "bytes": path.stat().st_size, "symbols": symbol_state(path)}
            return {"program_dir": str(program), "soffice": str(program / "soffice"),
                    "soffice_bin": str(soffice), "version": read_version(program),
                    "libraries": libraries}
    raise FileNotFoundError("no LibreOffice program directory with soffice.bin; install "
                            "libreoffice-calc-nogui (see worker.Dockerfile)")


def read_version(program: Path) -> str | None:
    for name in ("versionrc", "version.ini"):
        path = program / name
        if path.is_file():
            for line in path.read_text(errors="replace").splitlines():
                key, _, value = line.partition("=")
                if key.strip() in {"ProductVersion", "Version", "buildid"} and value.strip():
                    return value.strip()
    return None


def is_held_out(case: dict) -> bool:
    if "held_out" in case:
        return bool(case["held_out"])
    digest = hashlib.sha256(case["id"].encode()).digest()
    return digest[0] * 100 // 256 < HELD_OUT_PERCENT


def load_cases(path: Path) -> dict:
    suite = json.loads(Path(path).read_text())
    if suite.get("schema") != 1 or not isinstance(suite.get("cases"), list):
        raise ValueError("unknown LibreOffice case suite schema")
    ids = set()
    for case in suite["cases"]:
        if not isinstance(case.get("id"), str) or case["id"] in ids:
            raise ValueError(f"case ids must be unique strings: {case.get('id')!r}")
        ids.add(case["id"])
        if not str(case.get("formula", "")).startswith("="):
            raise ValueError(f"{case['id']}: formula must start with '='")
        if not isinstance(case.get("expected"), dict) or not (
                set(case["expected"]) <= {"value", "text", "error"} and case["expected"]):
            raise ValueError(f"{case['id']}: expected must be one of value, text or error")
    return suite


def split_cases(cases: list[dict]) -> tuple[list[dict], list[dict]]:
    """(public, held_out). Held-out cases are never shown to the spec writer or implementer."""
    public = [case for case in cases if not is_held_out(case)]
    held = [case for case in cases if is_held_out(case)]
    return public, held


def matches(expected: dict, observed: dict | None) -> bool:
    if not isinstance(observed, dict) or set(expected) != set(observed):
        return False
    for key, want in expected.items():
        got = observed[key]
        if key == "value":
            if not isinstance(got, (int, float)) or not math.isclose(
                    float(got), float(want), rel_tol=1e-12, abs_tol=1e-12):
                return False
        elif got != want:
            return False
    return True


def resolve_targets(cases: list[dict], scope: dict,
                    runtime: dict[str, list[dict]] | None = None) -> dict[str, str | None]:
    """Case id -> exact scope function name for the case's target_hint.

    A function the case actually hit at runtime wins over a name-only match. A hint that
    matches nothing in scope leaves the case unlinked rather than guessing.
    """
    names = [item["name"] for item in scope["included"]]
    by_entry = {int(item["entry"], 16): item["name"] for item in scope["included"]}

    def fits(name: str, hint: str) -> bool:
        return name == hint or name.endswith("::" + hint) or name.endswith("." + hint)

    targets = {}
    for case in cases:
        hint = case.get("target_hint")
        candidates = [name for name in names if hint and fits(name, hint)]
        # Runtime hits are matched by address: Frida and Ghidra spell names differently.
        counts: dict[str, int] = {}
        for item in (runtime or {}).get(case["id"], []):
            name = by_entry.get(int(item["entry"], 16))
            if name:
                counts[name] = counts.get(name, 0) + int(item.get("count", 0))
        hit = sorted((name for name in candidates if name in counts), key=lambda n: -counts[n])
        if hit:
            targets[case["id"]] = hit[0]
        elif len(set(candidates)) == 1:
            targets[case["id"]] = candidates[0]
        else:
            targets[case["id"]] = None  # no hint, no match, or ambiguous: leave unlinked
    return targets


class UnoDriver:
    """Line protocol to scripts/lo_uno_driver.py running under LibreOffice's own Python."""

    def __init__(self, soffice: str, *, python: str = "/usr/bin/python3",
                 script: Path = UNO_DRIVER, timeout: float = 120.0,
                 popen: Callable[..., subprocess.Popen] = subprocess.Popen):
        self.soffice = soffice
        self.python = python
        self.script = Path(script)
        self.timeout = timeout
        self.popen = popen
        self.process: subprocess.Popen | None = None
        self.ready: dict = {}

    def __enter__(self) -> "UnoDriver":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def _read(self) -> dict:
        assert self.process and self.process.stdout
        result: dict = {}

        def read() -> None:
            line = self.process.stdout.readline()
            result["line"] = line

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        reader.join(self.timeout)
        line = result.get("line")
        if not line:
            raise RuntimeError("LibreOffice UNO driver exited or timed out")
        return json.loads(line)

    def start(self) -> dict:
        self.process = self.popen([self.python, str(self.script), self.soffice],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  text=True, bufsize=1)
        self.ready = self._read()
        if self.ready.get("op") != "ready":
            raise RuntimeError(f"UNO driver failed to start: {self.ready.get('error')}")
        return self.ready

    @property
    def pid(self) -> int:
        return int(self.ready["pid"])

    def evaluate(self, case: dict) -> dict:
        assert self.process and self.process.stdin
        self.process.stdin.write(json.dumps({"op": "eval", "id": case["id"],
                                             "formula": case["formula"],
                                             "cells": case.get("cells", {})}) + "\n")
        self.process.stdin.flush()
        reply = self._read()
        if reply.get("id") != case["id"]:
            raise RuntimeError(f"UNO driver answered {reply.get('id')} for {case['id']}")
        return reply

    def close(self) -> None:
        if self.process is None:
            return
        process, self.process = self.process, None
        try:
            if process.stdin:
                process.stdin.write(json.dumps({"op": "quit"}) + "\n")
                process.stdin.close()
            process.wait(timeout=30)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            process.kill()


def probe_report(store, cases: list[dict], observations: dict[str, dict], *,
                 binary_sha256: str, lo_version: str | None,
                 targets: dict[str, str | None]) -> dict:
    """Store one probe record per case and a report in engine.validation.probes' format."""
    runner_sha = file_hash(Path(__file__))
    adapter_sha = file_hash(UNO_DRIVER)
    results = []
    for case in cases:
        reply = observations.get(case["id"], {})
        observed = reply.get("observed")
        error = reply.get("error")
        if observed is None:
            outcome = "execution_error"
            error = error or "no observation from LibreOffice"
        else:
            outcome = "agreement" if matches(case["expected"], observed) else "disagreement"
        record = {"schema": 1, "case_id": case["id"], "kind": "uno_formula",
                  "target": targets.get(case["id"]), "binary_sha256": binary_sha256,
                  "runner_sha256": runner_sha, "adapter_sha256": adapter_sha,
                  "input": {"formula": case["formula"], "cells": case.get("cells", {})},
                  "input_description": case.get("input_description"),
                  "expected": case["expected"], "observed": observed, "outcome": outcome,
                  "error": error, "execution_mode": "original",
                  "environment": {"lo_version": lo_version, "driver": "uno"}}
        artifact = store.put(json.dumps(record, sort_keys=True).encode())
        results.append({**record, "artifact": artifact})
    counts = {outcome: sum(item["outcome"] == outcome for item in results)
              for outcome in sorted({item["outcome"] for item in results})}
    suite_sha = hashlib.sha256(json.dumps(cases, sort_keys=True).encode()).hexdigest()
    report = {"schema": 1, "suite_sha256": suite_sha, "results": results, "counts": counts,
              "complete": bool(results) and counts.get("agreement", 0) == len(results)}
    artifact = store.put(json.dumps(report, sort_keys=True).encode())
    return {**report, "artifact": artifact}


def observe_cases(driver: UnoDriver, cases: list[dict]) -> dict[str, dict]:
    observations = {}
    for case in cases:
        try:
            observations[case["id"]] = driver.evaluate(case)
        except (RuntimeError, ValueError) as error:
            observations[case["id"]] = {"id": case["id"], "observed": None, "error": str(error)}
    return observations
