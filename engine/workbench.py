"""Public-only implementation workbench for cleanroom reimplementation.

The workbench materializes a workspace from public artifacts, verifies that no
private material is present, and runs an implementation agent in a disposable
container with full shell access. The agent can compile and test its candidate
and ask the broker behavior questions, but it cannot browse the repository,
engine state, original binary, dossier, or held-out cases.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import tempfile
import time
from typing import Iterable

from engine.broker import Broker, BrokerHost

PUBLIC_SPEC_KEYS = {
    "schema", "interface", "title", "purpose", "requirements", "behavior_steps",
    "acceptance_criteria", "deviations", "exclusions", "examples", "public_examples",
    "spec",
}
PRIVATE_KEYS = {
    "artifact", "scope_artifact", "public_report_artifact", "full_report_artifact",
    "binary_sha256", "model", "watchdog_artifact", "evidence_artifact",
    "source_artifact", "audit_artifact", "dossier_artifact", "campaign",
    "prompt_artifact", "hidden_result_artifacts", "result_artifacts",
}
# Process creation, dynamic loading, the network, and privilege or namespace changes are
# refused for every candidate, in-process or executable.
PROCESS_ESCAPE = (
    r"system|popen|dlopen|dlsym|fork|vfork|exec[a-z]*|posix_spawn|socket|connect|"
    r"bind|listen|accept|syscall|ptrace|mount|umount|chroot|setuid|setgid|unshare|clone"
)
# A shared-library candidate runs inside the probe process, so the harness's own files, the
# environment and the process working directory are off limits as well. An executable
# candidate is its own process: reading its input and writing its output is its interface.
LIBRARY_ESCAPE = (
    r"fopen|freopen|open|openat|read|write|remove|rename|unlink|mkdir|rmdir|"
    r"getenv|setenv|putenv|chdir|getcwd"
)
UNSAFE_C_CALL = re.compile(rf"\b(?:{PROCESS_ESCAPE}|{LIBRARY_ESCAPE})\s*\(", re.I)
EXECUTABLE_UNSAFE_C_CALL = re.compile(rf"\b(?:{PROCESS_ESCAPE})\s*\(", re.I)
UNSAFE_C_ATTRIBUTE = re.compile(
    r"__attribute__\s*\(\s*\(\s*constructor|__asm__|\basm\s*\(", re.I)
FORBIDDEN_WORKSPACE = re.compile(
    r"(?:^|/)(?:decomp-state|dossiers?|specifications?|artifacts?|runs?|watchdog)(?:/|$)|"
    r"(?:^|/)(?:libforlo(?:\.so)?|.*\.asar|.*\.bin|dossier.*\.json|"
    r"progress\.json|.*audit.*\.json|.*probe.*report.*\.json)$",
    re.I,
)

CHECK_SCRIPT = '''#!/usr/bin/env python3
"""Compile candidate.c and compare it with every public original observation."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
ADAPTER = ROOT / "adapters" / "__ADAPTER__"
SOURCE = ROOT / "candidate.c"
LIBRARY = ROOT / "candidate.so"
CASES = ROOT / "public_cases.json"


def build() -> str | None:
    if not SOURCE.is_file():
        return "candidate.c is missing"
    if not ADAPTER.is_file():
        return "public adapter is missing"
    done = subprocess.run(
        ["cc", "-std=c11", "-O2", "-fPIC", "-shared", "-Wall", "-Wextra",
         "-o", str(LIBRARY), str(SOURCE)],
        capture_output=True, text=True, timeout=60, check=False)
    if done.returncode:
        return "compilation failed:\\n" + done.stderr[-4000:]
    return None


def run_case(case: dict) -> dict:
    try:
        done = subprocess.run(
            [sys.executable, str(ADAPTER), str(LIBRARY)],
            input=json.dumps(case["input"]), capture_output=True, text=True,
            timeout=20, check=False)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    if done.returncode:
        return {"error": f"adapter exited {done.returncode}: {done.stderr[-1000:]}"}
    try:
        observed = json.loads(done.stdout)
    except json.JSONDecodeError as exc:
        return {"error": f"adapter returned invalid JSON: {exc}"}
    return {"observed": observed, "match": observed == case["observed"]}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list public case ids")
    parser.add_argument("--case", action="append", help="run only this case id")
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())
    if args.list:
        for case in cases:
            print(case["case_id"])
        return 0
    if args.case:
        selected = [case for case in cases if case["case_id"] in set(args.case)]
        missing = set(args.case) - {case["case_id"] for case in selected}
        if missing:
            print(f"unknown case ids: {sorted(missing)}")
            return 2
    else:
        selected = cases
    problem = build()
    if problem:
        print(problem)
        print(f"PUBLIC TESTS: 0/{len(selected)} passed")
        return 1
    failures = []
    for case in selected:
        result = run_case(case)
        if result.get("error") or not result.get("match"):
            failures.append({"case_id": case["case_id"], **result})
    for failure in failures[:8]:
        print(f"FAIL {failure['case_id']}")
        if failure.get("error"):
            print("  " + failure["error"].replace("\\n", "\\n  "))
        else:
            print("  expected: " + json.dumps(failure.get("expected")
                                             if "expected" in failure
                                             else next(
                                                 case["observed"] for case in selected
                                                 if case["case_id"] == failure["case_id"]),
                                             sort_keys=True))
            print("  observed: " + json.dumps(failure.get("observed"), sort_keys=True))
    passed = len(selected) - len(failures)
    print(f"PUBLIC TESTS: {passed}/{len(selected)} passed")
    if failures:
        print("If the specification does not explain these mismatches, ask the broker:")
        print('  ./ask_broker "What original behavior explains these mismatches?"')
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
'''

# A command-line candidate's interface is its process: argv, standard input, standard output,
# standard error and exit status. This harness builds candidate.c into a program and runs it
# once per public case, writing each case's program text where the original read it from.
EXECUTABLE_CHECK_SCRIPT = r'''#!/usr/bin/env python3
"""Build candidate.c as a program and compare it with every public original observation."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "candidate.c"
PROGRAM = ROOT / "candidate"
CASES = ROOT / "public_cases.json"
SCRIPTS = ROOT / "case_scripts"
DECIMAL = re.compile(r"^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$")


def build() -> str | None:
    if not SOURCE.is_file():
        return "candidate.c is missing"
    done = subprocess.run(
        ["cc", "-std=gnu11", "-O2", "-Wall", "-Wextra", "-o", str(PROGRAM),
         str(SOURCE), "-lm"],
        capture_output=True, text=True, timeout=180, check=False)
    if done.returncode:
        return "compilation failed:\n" + done.stderr[-4000:]
    return None


def script_for(case: dict) -> Path | None:
    """Write this case's program text where its recorded argument list expects it."""
    text = (case.get("input") or {}).get("program_text")
    if not isinstance(text, str):
        return None
    SCRIPTS.mkdir(exist_ok=True)
    path = SCRIPTS / (case["case_id"].replace("/", "_") + ".bc")
    path.write_text(text)
    return path


def invocation(case: dict, script: Path | None) -> list[str]:
    declared = [str(argument) for argument in (case.get("input") or {}).get("args") or []]
    if script is None:
        return declared
    return [str(script) if argument == "{script}" else argument for argument in declared]


def decimal(text: str) -> float | None:
    """A floating-point result, which the host compares with a tolerance."""
    if not DECIMAL.match(text) or not any(marker in text for marker in ".eE"):
        return None
    try:
        return float(text)
    except ValueError:
        return None


def matches(expected: dict, observed: dict) -> bool:
    """Exit status, stderr and stdout must agree, with float noise and padding ignored."""
    if expected.get("exit_code", 0) != observed.get("exit_code"):
        return False
    if str(expected.get("stderr", "")).strip() != str(observed.get("stderr", "")).strip():
        return False
    want = str(expected.get("stdout", "")).strip()
    got = str(observed.get("stdout", "")).strip()
    if want == got:
        return True
    a, b = decimal(want), decimal(got)
    return a is not None and b is not None and math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-12)


def run_case(case: dict) -> dict:
    script = script_for(case)
    fed = (case.get("input") or {}).get("stdin")
    try:
        done = subprocess.run(
            [str(PROGRAM), *invocation(case, script)],
            input=fed if isinstance(fed, str) else "", capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=20, check=False)
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}
    observed = {"stdout": done.stdout, "stderr": done.stderr, "exit_code": done.returncode}
    return {"observed": observed, "match": matches(case["observed"], observed)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="list public case ids")
    parser.add_argument("--case", action="append", help="run only this case id")
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())
    if args.list:
        for case in cases:
            print(case["case_id"])
        return 0
    if args.case:
        wanted = set(args.case)
        selected = [case for case in cases if case["case_id"] in wanted]
        missing = wanted - {case["case_id"] for case in selected}
        if missing:
            print(f"unknown case ids: {sorted(missing)}")
            return 2
    else:
        selected = cases
    problem = build()
    if problem:
        print(problem)
        print(f"PUBLIC TESTS: 0/{len(selected)} passed")
        return 1
    failures = []
    for case in selected:
        result = run_case(case)
        if result.get("error") or not result.get("match"):
            failures.append({"case_id": case["case_id"], "expected": case["observed"],
                             **result})
    for failure in failures[:8]:
        print(f"FAIL {failure['case_id']}")
        if failure.get("error"):
            print("  " + failure["error"])
        else:
            print("  expected output: " + json.dumps(failure["expected"], sort_keys=True))
            print("  program output:  " + json.dumps(failure["observed"], sort_keys=True))
    passed = len(selected) - len(failures)
    print(f"PUBLIC TESTS: {passed}/{len(selected)} passed")
    if failures:
        print("Every public case is an observation of the original program: your program must")
        print("write the same standard output and standard error and exit with the same status.")
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
'''


def _strip_private(value):
    if isinstance(value, dict):
        return {key: _strip_private(item) for key, item in value.items()
                if key not in PRIVATE_KEYS}
    if isinstance(value, list):
        return [_strip_private(item) for item in value]
    return value


def public_spec(spec: dict) -> dict:
    """Keep only fields safe for an independent implementer."""
    if not isinstance(spec, dict):
        raise ValueError("public spec must be an object")
    return _strip_private({key: value for key, value in spec.items()
                           if key in PUBLIC_SPEC_KEYS})


def canonical_cases(rows: Iterable[dict]) -> list[dict]:
    """Reduce probe records to case id, public input, and observed output."""
    cases, seen = [], set()
    for row in rows:
        if not isinstance(row, dict) or "input" not in row or "observed" not in row:
            raise ValueError("public case needs input and observed")
        case_id = row.get("case_id") or row.get("id")
        if not isinstance(case_id, str) or not case_id:
            raise ValueError("public case needs an id")
        if case_id in seen:
            raise ValueError(f"duplicate public case id {case_id}")
        seen.add(case_id)
        cases.append({"case_id": case_id, "input": row["input"],
                      "observed": row["observed"]})
    if not cases:
        raise ValueError("workbench needs at least one public case")
    return cases


def validate_candidate_source(source: object, *, executable: bool = False) -> str:
    """Reject a candidate that could reach outside the probe process on the host."""
    if not isinstance(source, str) or not source.strip():
        raise ValueError("candidate source is empty")
    if len(source) > 262144:
        raise ValueError("candidate source exceeds 256 KiB")
    call = (EXECUTABLE_UNSAFE_C_CALL if executable else UNSAFE_C_CALL).search(source)
    if call:
        reason = ("reach outside the candidate process" if executable
                  else "invoke an external or I/O function")
        raise ValueError(f"candidate tries to {reason}: {call.group(0)}")
    attribute = UNSAFE_C_ATTRIBUTE.search(source)
    if attribute:
        raise ValueError(f"candidate uses a constructor or inline assembly: {attribute.group(0)}")
    return source


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write(path: Path, text: str, *, executable: bool = False) -> None:
    path.write_text(text)
    if executable:
        path.chmod(0o755)


def _readme(broker_enabled: bool, executable: bool = False) -> str:
    broker = (
        "\nWhen a public test fails and the specification is ambiguous, ask the broker:\n\n"
        "    ./ask_broker \"What happens when finalize is followed by add_double?\"\n\n"
        "The broker answers caller-visible behavior only. It refuses requests for source,\n"
        "decompilation, disassembly, bytes, addresses, symbols, or implementation mechanics.\n"
        "If it refuses, rephrase the question as behavior.\n"
    ) if broker_enabled else "\nNo broker is available for this run; work from the public materials.\n"
    deliverable = (
        "You are the independent implementer. Implement the public contract as a complete\n"
        "command-line program in `candidate.c`.\n"
        "You have full shell access inside this container. The only materials present are\n"
        "public: `spec.json`, `contract.md`, `public_cases.json`, `candidate.c`, and this\n"
        "harness.\n\n"
        "## Work loop\n\n"
        "1. Read `spec.json` and `contract.md`.\n"
        "2. Implement the program in `candidate.c`.\n"
        "3. Run `./run_tests.sh`. It builds the candidate with\n"
        "   `cc -std=gnu11 -O2 -o candidate candidate.c -lm`, writes each case's program\n"
        "   text into `case_scripts/`, runs the candidate once per case, and compares\n"
        "   standard output, standard error and exit status.\n"
        "4. Fix every mismatch and rerun. Use `./run_tests.sh --case <id>` for one case.\n"
        "5. Finish only when `./run_tests.sh` exits 0.\n"
    ) if executable else (
        "You are the independent implementer. Implement the public contract in `candidate.c`.\n"
        "You have full shell access inside this container. The only materials present are\n"
        "public: `spec.json`, `contract.md`, `public_cases.json`, `candidate.c`, the public\n"
        "adapter under `adapters/`, and this harness.\n\n"
        "## Work loop\n\n"
        "1. Read `spec.json` and `contract.md`.\n"
        "2. Implement the behavior in `candidate.c`.\n"
        "3. Run `./run_tests.sh`. It compiles the candidate and compares every public case.\n"
        "4. Fix every mismatch and rerun. Use `./run_tests.sh --case <id>` for one case.\n"
        "5. Finish only when `./run_tests.sh` exits 0.\n"
    )
    rules = (
        "- Do not modify `check.py`, `public_cases.json`, `spec.json`, `contract.md`,\n"
        "  `README.md`, or `run_tests.sh`. The host verifies their hashes and rejects a\n"
        "  tampered result.\n"
        "- Do not attempt to locate the original program, its source, the analyst dossier, or\n"
        "  held-out cases. None is mounted here.\n"
        "- `candidate.c` is the deliverable: one self-contained C11 program that links only\n"
        "  against the C library and libm. Do not start other programs, load libraries, or\n"
        "  use the network.\n"
    ) if executable else (
        "- Do not modify `check.py`, `public_cases.json`, `spec.json`, `contract.md`,\n"
        "  `README.md`, `run_tests.sh`, `ask_broker.sh`, or the adapter. The host verifies\n"
        "  their hashes and rejects a tampered result.\n"
        "- Do not attempt to locate the original binary, its source, the analyst dossier, or\n"
        "  held-out cases. None is mounted here.\n"
        "- `candidate.c` is the deliverable. Keep it a self-contained C11 translation unit.\n"
    )
    return (
        "# Cleanroom implementation workbench\n\n" + deliverable + broker +
        "\n## Rules\n\n" + rules
    )


def materialize_workspace(directory: Path, *, spec: dict, cases: Iterable[dict],
                          contract: str, adapter: Path | None = None,
                          broker_client: Path | None = None,
                          candidate: str | None = None,
                          broker_enabled: bool = True,
                          executable: bool = False) -> dict:
    """Create a workspace and return hashes of the files that must stay unchanged."""
    directory = Path(directory)
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("workbench directory must be empty")
    directory.mkdir(parents=True, exist_ok=True)
    public = canonical_cases(cases)
    adapter_path = Path(adapter) if adapter is not None else None
    if adapter_path is None and not executable:
        raise ValueError("the in-process interface needs a public adapter")
    if adapter_path is not None and not adapter_path.is_file():
        raise FileNotFoundError(f"public adapter not found: {adapter_path}")
    _write(directory / "spec.json",
           json.dumps(public_spec(spec), indent=2, sort_keys=True) + "\n")
    _write(directory / "public_cases.json",
           json.dumps(public, indent=2, sort_keys=True) + "\n")
    _write(directory / "contract.md", contract.rstrip() + "\n")
    _write(directory / "README.md", _readme(broker_enabled, executable))
    if adapter_path is not None:
        (directory / "adapters").mkdir()
        shutil.copy2(adapter_path, directory / "adapters" / adapter_path.name)
        (directory / "adapters" / "__init__.py").write_text("")
    if broker_client is not None:
        (directory / "broker").mkdir()
        shutil.copy2(Path(broker_client), directory / "broker" / "ask.py")
    _write(directory / "candidate.c",
           candidate if candidate is not None else
           "/* Implement the public contract here. Run ./run_tests.sh. */\n")
    check = (EXECUTABLE_CHECK_SCRIPT if executable else
             CHECK_SCRIPT.replace("__ADAPTER__", adapter_path.name))
    _write(directory / "check.py", check, executable=True)
    _write(directory / "run_tests.sh",
           '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nexec python3 check.py "$@"\n',
           executable=True)
    immutable = {"spec.json", "public_cases.json", "contract.md", "check.py",
                 "README.md", "run_tests.sh"}
    if adapter_path is not None:
        immutable.add(f"adapters/{adapter_path.name}")
    if broker_client is not None:
        _write(directory / "ask_broker.sh",
               '#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\n'
               'if [ "$#" -lt 1 ]; then echo \'usage: ./ask_broker "behavior question"\' >&2;'
               ' exit 2; fi\n'
               'context=$(./run_tests.sh 2>&1 | tail -30 | head -c 3500 || true)\n'
               'exec python3 broker/ask.py "$1" --context "$context"\n',
               executable=True)
        immutable |= {"ask_broker.sh", "broker/ask.py"}
    assert_public_workspace(directory)
    hashes = {name: _sha256(directory / name) for name in sorted(immutable)}
    return {"directory": str(directory), "files": hashes, "public_cases": len(public)}


def assert_public_workspace(directory: Path,
                            private_markers: Iterable[str] = ()) -> list[str]:
    """Fail if the workbench contains a binary, private path, or private marker."""
    directory = Path(directory)
    markers = [str(marker).encode() for marker in private_markers if marker]
    checked = []
    for path in directory.rglob("*"):
        if path.is_dir():
            continue
        relative = path.relative_to(directory).as_posix()
        if FORBIDDEN_WORKSPACE.search(relative):
            raise ValueError(f"private-looking path in workbench: {relative}")
        data = path.read_bytes()
        if data.startswith(b"\x7fELF"):
            raise ValueError(f"executable content in workbench: {relative}")
        for marker in markers:
            if marker in data:
                raise ValueError(f"private marker present in workbench: {relative}")
        checked.append(relative)
    return checked


def verify_immutable(directory: Path, expected: dict) -> dict:
    """Return changed and missing files without trusting workspace metadata."""
    changed, missing = [], []
    for relative, digest in expected.items():
        path = Path(directory) / relative
        if not path.is_file():
            missing.append(relative)
        elif _sha256(path) != digest:
            changed.append(relative)
    return {"ok": not changed and not missing, "changed": changed, "missing": missing}


def triage_failures(broker: Broker | None, failures: Iterable[dict]) -> str | None:
    """Ask one focused behavior question about reported public mismatches.

    This is a host-side safety net: the agent can ask its own questions, but a
    failing attempt should not be wasted when the broker can explain the
    caller-visible behavior behind the findings.  The question contains only
    public findings, never private evidence.
    """
    if broker is None:
        return None
    rows = [row for row in failures if isinstance(row, dict)]
    notes = [str(note) for row in rows[:8] for note in (row.get("findings") or [])]
    if not notes:
        return None
    question = ("One public mismatch: " + "; ".join(notes[:2]) +
                ". Explain the original rule that produces the original value instead of "
                "the candidate's, in prose.")[:1200]
    response = broker.ask({"question": question,
                           "context": json.dumps(rows[:4], default=str)[:2000]})
    if response.get("status") != "answered":
        return None
    return response.get("answer")


def _provider_config(model: str) -> dict:
    provider, _, model_id = model.partition("/")
    if provider == "amazon-bedrock" and model_id.startswith("qwen."):
        return {"provider": {provider: {"models": {model_id: {
            "name": model_id, "id": model_id, "status": "active",
            "provider": {"npm": "@ai-sdk/amazon-bedrock"},
            "limit": {"context": 32768, "output": 4000},
        }}}}}
    return {}


def write_agent_config(directory: Path, model: str,
                       agent_name: str = "cleanroom-implementer") -> Path:
    permission = {
        "*": "deny", "bash": "allow", "edit": "allow", "write": "allow",
        "read": "allow", "grep": "allow", "glob": "allow", "list": "allow",
        "patch": "allow", "todowrite": "allow", "todoread": "allow",
        "webfetch": "deny", "task": "deny",
    }
    config = {
        "$schema": "https://opencode.ai/config.json",
        "model": model, "small_model": model, "permission": permission,
        "agent": {agent_name: {
            "mode": "primary", "model": model,
            "prompt": ("You are the independent cleanroom implementer. Work only in "
                       "this workspace. Compile and test your own candidate. Ask the "
                       "broker only about caller-visible behavior."),
            "permission": permission,
        }},
    }
    config.update(_provider_config(model))
    path = Path(directory) / "opencode.json"
    path.write_text(json.dumps(config, indent=2) + "\n")
    return path


def build_prompt(*, contract: str, case_count: int,
                 broker_enabled: bool = True, executable: bool = False) -> str:
    broker = (
        "If a public test fails and the spec is ambiguous, ask the broker with\n"
        "`./ask_broker \"question\"`. Do not read the entire public_cases.json one case at a\n"
        "time; use the harness summary and one focused broker question. The broker answers\n"
        "caller-visible behavior only and may refuse.\n"
        if broker_enabled else "No broker is available; rely on the public materials.\n"
    )
    if executable:
        return (
            "You are the independent cleanroom implementer for a command-line program.\n"
            "Implement the public contract as a complete program in candidate.c, inside this\n"
            "workspace. You have full shell access. The public materials are spec.json,\n"
            "contract.md, public_cases.json, and the self-test harness. Workbench mode\n"
            "overrides any earlier instruction to return code in the reply: the deliverable is\n"
            "the file candidate.c, built as `cc -std=gnu11 -O2 -o candidate candidate.c -lm`.\n\n"
            f"Contract:\n{contract.strip()}\n\n"
            f"There are {case_count} public original observations. Implement; run\n"
            "`./run_tests.sh`; inspect the mismatch; fix; repeat until it exits 0. Derive the\n"
            "general rules (representation, operator semantics, state, input and output bases,\n"
            "builtins) instead of encoding the observations.\n" + broker +
            "\nDo not modify the harness, public cases, spec, contract, README, or run_tests.sh.\n"
            "Do not seek the original program, its source, the dossier, or held-out cases; none\n"
            "is present. Leave the final program in candidate.c and finish only after the\n"
            "public tests pass.\n"
        )
    return (
        "You are the independent cleanroom implementer for a native subsystem. Implement\n"
        "the public contract in candidate.c, inside this workspace. You have full shell\n"
        "access. The public materials are spec.json, contract.md, public_cases.json, the\n"
        "adapter under adapters/, and the self-test harness. Workbench mode overrides any\n"
        "earlier instruction to return code in the reply: the deliverable is the file\n"
        "candidate.c.\n\n"
        f"Contract:\n{contract.strip()}\n\n"
        f"There are {case_count} public original observations. Implement; run\n"
        "`./run_tests.sh`; inspect the mismatch; fix; repeat until it exits 0.\n"
        + broker +
        "\nDo not modify the harness, public cases, spec, contract, README, run_tests.sh, or\n"
        "adapter. Do not seek\n"
        "the original binary, source, dossier, or held-out cases; none is present. Leave the\n"
        "final implementation in candidate.c and finish only after the public tests pass.\n"
    )


def container_command(*, image: str, workspace: Path, broker_dir: Path | None,
                      opencode: Path, model: str, auth_file: Path | None = None,
                      agent_name: str = "cleanroom-implementer",
                      runtime: str = "podman", container_name: str | None = None,
                      env: dict | None = None, network: str | None = None,
                      memory: str = "2g", cpus: str = "2", pids: str = "256") -> list[str]:
    """Build the disposable container command with an explicit mount allowlist."""
    if not re.fullmatch(r"[\w./:@+-]+", model):
        raise ValueError("model id contains unsupported characters")
    name = container_name or "splice-cleanroom-impl"
    command = [
        runtime, "run", "--rm", "--name", name,
        "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", str(pids), "--memory", memory, "--cpus", str(cpus),
        "--label", "splice.cleanroom=1", "--workdir", "/cleanroom",
        "--volume", f"{Path(workspace).resolve()}:/cleanroom:rw",
        "--volume", f"{Path(opencode).resolve()}:/usr/local/bin/opencode:ro",
        "--env", "HOME=/root",
        "--env", "OPENCODE_CONFIG=/cleanroom/opencode.json",
        "--env", "OPENCODE_DISABLE_AUTOUPDATE=true",
        "--env", "OPENCODE_DISABLE_EXTERNAL_SKILLS=true",
    ]
    if broker_dir is not None:
        command += ["--volume", f"{Path(broker_dir).resolve()}:/broker:rw"]
    if auth_file is not None and Path(auth_file).is_file():
        command += ["--volume",
                    f"{Path(auth_file).resolve()}:/root/.local/share/opencode/auth.json:ro"]
    for key, value in (env or {}).items():
        command += ["--env", f"{key}={value}"]
    if network:
        command += ["--network", network]
    inner = (
        "opencode run --pure --print-logs --title " + shlex.quote(agent_name) +
        " --agent " + shlex.quote(agent_name) +
        " --model " + shlex.quote(model) +
        ' --format json "$(cat /cleanroom/prompt.txt)"'
    )
    command += [image, "/bin/sh", "-lc", inner]
    return command


def assert_container_isolation(command: list[str], *, workspace: Path,
                               broker_dir: Path | None, opencode: Path,
                               auth_file: Path | None = None) -> None:
    """Reject any mount outside the public workspace, broker socket, and agent runtime."""
    allowed = {str(Path(workspace).resolve()), str(Path(opencode).resolve())}
    if broker_dir is not None:
        allowed.add(str(Path(broker_dir).resolve()))
    if auth_file is not None:
        allowed.add(str(Path(auth_file).resolve()))
    for index, argument in enumerate(command):
        if argument == "--privileged":
            raise ValueError("cleanroom container must not be privileged")
        if argument in {"--volume", "-v"} and index + 1 < len(command):
            source = command[index + 1].split(":", 1)[0]
            if str(Path(source).resolve()) not in allowed:
                raise ValueError(f"unexpected cleanroom mount: {source}")
        if argument.startswith("--volume="):
            source = argument.split("=", 1)[1].split(":", 1)[0]
            if str(Path(source).resolve()) not in allowed:
                raise ValueError(f"unexpected cleanroom mount: {source}")


def build_image(*, runtime: str, image: str, dockerfile: Path = Path("implementer.Dockerfile"),
                context: Path = Path("."), timeout: int = 1800) -> None:
    if not Path(dockerfile).is_file():
        raise FileNotFoundError(f"implementer Dockerfile not found: {dockerfile}")
    completed = subprocess.run(
        [runtime, "build", "-t", image, "-f", str(dockerfile), str(context)],
        capture_output=True, text=True, timeout=timeout, check=False)
    if completed.returncode:
        raise RuntimeError("implementer image build failed: " + completed.stderr[-2000:])


def run_workbench(*, workspace: Path, broker: Broker | None = None, image: str,
                  opencode: Path, model: str, auth_file: Path | None = None,
                  timeout: int = 900, runtime: str = "podman",
                  agent_name: str = "cleanroom-implementer",
                  env: dict | None = None, network: str | None = None,
                  private_markers: Iterable[str] = (),
                  immutable: dict | None = None,
                  audit_path: Path | None = None,
                  broker_dir: Path | None = None,
                  runner=subprocess.run, executable: bool = False,
                  container_name: str | None = None) -> dict:
    """Run one agent session in the sandbox and return its candidate and audit summary.

    The broker is optional: a run without one gives the agent its own harness only, which
    is the whole public package for a target whose spec is already the public contract.
    """
    workspace = Path(workspace).resolve()
    assert_public_workspace(workspace, private_markers)
    run_root = workspace.parent
    owns_broker_dir = broker is not None and broker_dir is None
    audit = None
    if broker is not None:
        # A Unix socket path is limited to roughly 108 bytes. The run directory can be
        # deep (state/cleanroom/<run-key>/attempt-N), so the socket lives under /tmp
        # unless a caller supplies a short directory explicitly.
        broker_dir = (Path(broker_dir) if broker_dir is not None else
                      Path(tempfile.mkdtemp(prefix="splice-broker-")))
        broker_dir.mkdir(parents=True, exist_ok=True)
        audit = (Path(audit_path) if audit_path else
                 run_root / f"{workspace.name}.broker-audit.jsonl")
        if workspace == audit or workspace in audit.resolve().parents:
            raise ValueError("broker audit must live outside the sandbox workspace")
        broker.audit_path = audit
    write_agent_config(workspace, model, agent_name)
    if immutable is None:
        immutable = {}
        for relative in ("spec.json", "public_cases.json", "contract.md", "check.py",
                         "README.md", "run_tests.sh", "ask_broker.sh"):
            path = workspace / relative
            if path.is_file():
                immutable[relative] = _sha256(path)
        for relative in sorted(path.name for path in (workspace / "adapters").glob("*")):
            immutable[f"adapters/{relative}"] = _sha256(workspace / "adapters" / relative)
    command = container_command(
        image=image, workspace=workspace, broker_dir=broker_dir,
        opencode=opencode, model=model, auth_file=auth_file,
        agent_name=agent_name, runtime=runtime, env=env, network=network,
        container_name=container_name)
    assert_container_isolation(command, workspace=workspace, broker_dir=broker_dir,
                               opencode=opencode, auth_file=auth_file)
    events_path = run_root / f"{workspace.name}.agent-events.jsonl"
    stderr_path = run_root / f"{workspace.name}.agent-stderr.log"
    started = time.monotonic()
    timed_out = False
    completed = None
    host = (BrokerHost(broker, broker_dir / "broker.sock") if broker is not None
            else contextlib.nullcontext())
    try:
        with host:
            try:
                completed = runner(command, capture_output=True, text=True,
                                   timeout=timeout, check=False)
            except subprocess.TimeoutExpired:
                timed_out = True
                subprocess.run([runtime, "rm", "-f", container_name or
                                "splice-cleanroom-impl"], capture_output=True,
                               timeout=30, check=False)
            except FileNotFoundError as exc:
                raise RuntimeError(
                    f"container runtime '{runtime}' not found; install Podman/Docker"
                ) from exc
    finally:
        if owns_broker_dir:
            shutil.rmtree(broker_dir, ignore_errors=True)
    events_path.write_text(getattr(completed, "stdout", "") or "")
    stderr_path.write_text(getattr(completed, "stderr", "") or "")
    candidate_path = workspace / "candidate.c"
    candidate = candidate_path.read_text() if candidate_path.is_file() else None
    candidate_error = None
    if candidate is not None:
        try:
            candidate = validate_candidate_source(candidate, executable=executable)
        except ValueError as exc:
            candidate, candidate_error = None, str(exc)
    integrity = verify_immutable(workspace, immutable)
    records = broker.records if broker is not None else []
    counts: dict[str, int] = {}
    for record in records:
        counts[record["status"]] = counts.get(record["status"], 0) + 1
    return {
        "schema": 1,
        "status": ("timed_out" if timed_out else
                   "completed" if completed is not None and
                   getattr(completed, "returncode", 1) == 0 else "failed"),
        "exit_code": None if completed is None else getattr(completed, "returncode", None),
        "timed_out": timed_out,
        "candidate_source": candidate,
        "candidate_error": candidate_error,
        "candidate_present": candidate is not None,
        "immutable": integrity,
        "broker": {"exchanges": len(records), "counts": counts,
                   "audit_path": str(audit) if audit is not None else None},
        "events_path": str(events_path),
        "stderr_path": str(stderr_path),
        "elapsed_seconds": round(time.monotonic() - started, 1),
    }
