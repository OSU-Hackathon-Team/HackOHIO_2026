"""A packaged command-line program as a native target: install it, run cases, compare results.

Each case is an argument list. The oracle is the real program: observed results are its stdout,
stderr and exit code, never values a user supplied. Probe records keep engine.validation.probes'
shape, so the dossier, case links and handoff consume them unchanged.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import urllib.request

from engine.analysis.elfinfo import build_id, debug_file_for, symbol_state
from engine.analysis.ghidra import file_hash

DEBUGINFOD = "https://debuginfod.ubuntu.com/buildid/{build}/debuginfo"
DEBUG_ROOT = Path("/usr/lib/debug")
OBSERVATION_FORMAT = ("a JSON object with stdout (the exact text the program prints, a string), "
                      "stderr (a string, empty when nothing is printed there) and exit_code "
                      "(an integer, 0 on success).")
PACKAGE = re.compile(r"^[a-z0-9][a-z0-9+.-]{1,63}$")


def load_cli_cases(path: Path) -> dict:
    suite = json.loads(Path(path).read_text())
    if suite.get("schema") != 1 or suite.get("kind") != "cli" or not isinstance(suite.get("cases"), list):
        raise ValueError("unknown command-line case suite schema")
    ids = set()
    for case in suite["cases"]:
        if not isinstance(case.get("id"), str) or case["id"] in ids:
            raise ValueError(f"case ids must be unique strings: {case.get('id')!r}")
        ids.add(case["id"])
        if not isinstance(case.get("args"), list) or not all(isinstance(a, str) for a in case["args"]):
            raise ValueError(f"{case['id']}: args must be a list of strings")
        if "stdin" in case and not isinstance(case["stdin"], str):
            raise ValueError(f"{case['id']}: stdin must be a string when present")
        if "script" in case and not isinstance(case["script"], str):
            raise ValueError(f"{case['id']}: script must be a string when present")
        if "stdin" not in case and not case["args"] and "script" not in case:
            raise ValueError(f"{case['id']}: a case needs arguments, a script or stdin")
        if "expected" in case:
            raise ValueError(f"{case['id']}: expected results come from running the program, not the suite")
    return suite


def fetch_debug_file(binary: Path, *, root: Path = DEBUG_ROOT, timeout: int = 300) -> Path | None:
    """Download the binary's separate debug file from Ubuntu's debuginfod by GNU build-id."""
    build = build_id(Path(binary).read_bytes())
    if not build:
        return None
    existing = debug_file_for(build, (root,))
    if existing:
        return existing
    target = root / ".build-id" / build[:2] / f"{build[2:]}.debug"
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(".part")
    try:
        with urllib.request.urlopen(DEBUGINFOD.format(build=build), timeout=timeout) as reply, \
                part.open("wb") as output:
            shutil.copyfileobj(reply, output, 1 << 20)
        part.rename(target)
    except OSError:
        part.unlink(missing_ok=True)
        return None  # symbols stay FUN_*; the pipeline logs that
    return target


def ensure_cli_install(target: dict, *, run=subprocess.run) -> dict:
    """Install the target's apt package when its binary is missing, then describe the binary."""
    package, binary = target["install"]["apt"], Path(target["install"]["binary"])
    if not PACKAGE.match(package):
        raise ValueError(f"invalid package name {package!r}")
    if not binary.is_file():
        env = {**os.environ, "DEBIAN_FRONTEND": "noninteractive"}
        run(["apt-get", "update"], check=True, capture_output=True, env=env, timeout=600)
        run(["apt-get", "install", "-y", "--no-install-recommends", package], check=True,
            capture_output=True, env=env, timeout=900)
    if not binary.is_file():
        raise FileNotFoundError(f"{package} did not install {binary}")
    fetch_debug_file(binary)
    version = run(["dpkg-query", "-W", "-f=${Version}", package], capture_output=True, text=True,
                  timeout=30).stdout.strip() or None
    return {"program_dir": str(binary.parent), "program": str(binary), "version": version,
            "libraries": {target["library"]: {"path": str(binary), "sha256": file_hash(binary),
                                              "bytes": binary.stat().st_size,
                                              "symbols": symbol_state(binary)}}}


SCRIPT_PLACEHOLDER = "{script}"


def materialize_scripts(cases: list[dict], root: Path) -> list[dict]:
    """Write each case's program text to a content-addressed file and point its args at it.

    A file argument is what makes per-case runtime observation possible: the spawned
    process inherits the case's input without a terminal. The path is stable for the
    same program text, so probe records and replays stay reproducible.
    """
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    materialized = []
    for case in cases:
        if "script" not in case:
            materialized.append(dict(case))
            continue
        digest = hashlib.sha256(case["script"].encode()).hexdigest()[:16]
        path = root / f"{case['id'].replace('/', '_')}-{digest}.bc"
        if not path.exists() or path.read_text() != case["script"]:
            path.write_text(case["script"])
        args = [arg.replace(SCRIPT_PLACEHOLDER, str(path)) for arg in case["args"]]
        materialized.append({**case, "args": args, "script_path": str(path)})
    return materialized


def cli_case_input(case: dict) -> dict:
    """What the oracle ran: the argument list, the fed program text, and the input.

    The program text is recorded even when the case is driven through a file, because the
    path alone does not describe what the original program was asked to do. That path is a
    host location, so it is recorded as the suite's declared placeholder instead: the
    recorded invocation stays a description the published spec can carry.
    """
    script_path = case.get("script_path")
    args = [arg.replace(script_path, SCRIPT_PLACEHOLDER) if script_path and script_path in arg
            else arg for arg in case["args"]]
    return {"args": args,
            **({"stdin": case["stdin"]} if "stdin" in case else {}),
            **({"program_text": case["script"]} if "script" in case else {})}


def cli_display(program: str, case: dict) -> str:
    invocation = shlex.join([Path(program).name, *case["args"]])
    if "stdin" in case:
        return invocation + " <<'BC'\n" + case["stdin"].rstrip("\n") + "\nBC"
    if "script" in case:
        return f"{invocation} reads a program that says:\n" + case["script"].rstrip("\n")
    return invocation


def _number(text: str) -> float | None:
    try:
        return float(text)
    except ValueError:
        return None


def cli_matches(predicted: dict, observed: dict | None) -> bool:
    """Exit code, stdout and stderr must agree; whitespace at the ends and float noise are ignored."""
    if not isinstance(observed, dict) or not isinstance(predicted, dict):
        return False
    if not set(predicted) <= {"stdout", "stderr", "exit_code"} or "stdout" not in predicted:
        return False
    if predicted.get("exit_code", 0) != observed.get("exit_code"):
        return False
    if str(predicted.get("stderr", "")).strip() != str(observed.get("stderr", "")).strip():
        return False
    want, got = str(predicted["stdout"]).strip(), str(observed.get("stdout", "")).strip()
    if want == got:
        return True
    a, b = _number(want), _number(got)
    return a is not None and b is not None and math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)


class CliDriver:
    """Runs the original program once per case in a fixed C locale with a timeout."""

    pid = None  # nothing long-running to attach to; tracing spawns per case

    def __init__(self, program: str, *, timeout: int = 10):
        self.program = program
        self.timeout = timeout

    def __enter__(self) -> "CliDriver":
        return self

    def __exit__(self, *exc) -> None:
        pass

    def evaluate(self, case: dict) -> dict:
        try:
            # ``stdin`` is the program text for interactive targets (bc and friends);
            # without it the program sees an empty stream, never a terminal.
            done = subprocess.run([self.program, *case["args"]], input=case.get("stdin", ""),
                                  capture_output=True, text=True,
                                  timeout=self.timeout,
                                  env={"LANG": "C", "LC_ALL": "C", "PATH": "/usr/bin:/bin"})
        except subprocess.TimeoutExpired:
            return {"id": case["id"], "observed": None, "error": f"timed out after {self.timeout} s"}
        except OSError as error:
            return {"id": case["id"], "observed": None, "error": f"could not run the program: {error}"}
        return {"id": case["id"], "observed": {"stdout": done.stdout, "stderr": done.stderr,
                                               "exit_code": done.returncode}}
