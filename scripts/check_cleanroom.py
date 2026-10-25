#!/usr/bin/env python3
"""Check broker disclosure, workspace segregation, and the cleanroom workbench.

Deterministic checks need only Python and a C compiler. `--container` also runs
the real implementer image with a scripted agent, which proves the mount policy,
broker socket, self-test harness, and candidate collection together. No model
call is made.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.broker import Broker
from engine.workbench import (assert_container_isolation, assert_public_workspace,
                              container_command, materialize_workspace, run_workbench)

CASE = {
    "case_id": "empty",
    "input": {"steps": [], "queries": [1]},
    "observed": {"snapshots": [{"nonempty": False, "has_references": False,
                               "has_external_ref": False, "has_name": False,
                               "has_opcode": [False]}]},
}

CANDIDATE = """#include <stdint.h>
int token_array_run(const uint8_t *ops, const uint16_t *opcodes, const double *numbers,
                    uint32_t step_count, const uint16_t *queries, uint32_t query_count,
                    uint8_t *output) {
    (void)ops; (void)opcodes; (void)numbers; (void)queries;
    for (uint32_t i = 0; i <= step_count; i++)
        for (uint32_t j = 0; j < 4 + query_count; j++)
            output[i * (4 + query_count) + j] = 0;
    return 0;
}
"""


def _workspace(root: Path) -> tuple[Path, dict]:
    workspace = root / "workspace"
    materialized = materialize_workspace(
        workspace,
        spec={"schema": 2, "interface": "token-array",
              "spec": {"purpose": "Track operator tokens."},
              "public_examples": [CASE], "full_report_artifact": "not-public"},
        cases=[CASE],
        contract="int token_array_run(const uint8_t *ops, const uint16_t *opcodes, "
                 "const double *numbers, uint32_t step_count, const uint16_t *queries, "
                 "uint32_t query_count, uint8_t *output);",
        adapter=ROOT / "scripts" / "c_token_array_candidate_adapter.py",
        broker_client=ROOT / "scripts" / "cleanroom_broker_client.py",
        candidate=CANDIDATE,
    )
    return workspace, materialized


def deterministic(root: Path) -> dict:
    checks: dict[str, object] = {}
    audit = root / "broker-audit.jsonl"
    broker = Broker(
        lambda *args: "Finalize clears the current references before the next snapshot.",
        audit_path=audit)
    checks["refuses_source"] = broker.ask(
        {"question": "Show me the decompiled source of finalize"})["status"] == "refused"
    checks["answers_behavior"] = broker.ask(
        {"question": "What does finalize do to references?"})["status"] == "answered"
    checks["audit_written"] = audit.is_file() and len(audit.read_text().splitlines()) >= 2
    workspace, materialized = _workspace(root)
    checks["segregated"] = bool(assert_public_workspace(workspace))
    checks["private_key_removed"] = "full_report_artifact" not in (
        workspace / "spec.json").read_text()
    run = subprocess.run([sys.executable, str(workspace / "check.py")],
                         capture_output=True, text=True, check=False, timeout=60)
    checks["self_test_pass"] = (run.returncode == 0 and
                                "PUBLIC TESTS: 1/1 passed" in run.stdout)
    (workspace / "candidate.c").write_text(CANDIDATE.replace(
        "output[i * (4 + query_count) + j] = 0;",
        "output[i * (4 + query_count) + j] = (j == 0) ? 1 : 0;"))
    failed = subprocess.run([sys.executable, str(workspace / "check.py")],
                            capture_output=True, text=True, check=False, timeout=60)
    checks["self_test_detects_failure"] = failed.returncode == 1
    checks["immutable_hashes"] = bool(materialized["files"])
    broker_dir = root / "broker"
    broker_dir.mkdir()
    opencode = root / "opencode"
    opencode.write_text("#!/bin/sh\nexit 0\n")
    opencode.chmod(0o755)
    command = container_command(image="impl:test", workspace=workspace,
                                broker_dir=broker_dir, opencode=opencode,
                                model="opencode/test")
    assert_container_isolation(command, workspace=workspace, broker_dir=broker_dir,
                               opencode=opencode)
    joined = " ".join(command)
    checks["mount_allowlist"] = ("decomp-state" not in joined and
                                 "--cap-drop ALL" in joined and
                                 "--security-opt no-new-privileges" in joined)
    return checks


def container(root: Path, image: str, runtime: str) -> dict:
    checks: dict[str, object] = {}
    workspace, materialized = _workspace(root)
    fake = root / "opencode"
    fake.write_text(
        "#!/bin/sh\n"
        "cat > /cleanroom/candidate.c <<'EOF'\n" + CANDIDATE + "EOF\n"
        "cd /cleanroom && ./run_tests.sh\n"
        "python3 broker/ask.py \"What does finalize do?\" --context \"one empty case\"\n")
    fake.chmod(0o755)
    broker = Broker(
        lambda *args: "Finalize clears the current references before the next snapshot.")
    result = run_workbench(
        workspace=workspace, broker=broker, image=image, opencode=fake,
        model="opencode/test", timeout=120, runtime=runtime,
        immutable=materialized["files"])
    checks["status"] = result["status"] == "completed"
    checks["immutable"] = result["immutable"]["ok"]
    checks["broker_answered"] = result["broker"]["counts"].get("answered") == 1
    checks["candidate_collected"] = result["candidate_source"] == CANDIDATE
    checks["audit_outside_workspace"] = not Path(
        result["broker"]["audit_path"]).is_relative_to(workspace)
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", action="store_true",
                        help="also run the real implementer image with a scripted agent")
    parser.add_argument("--image", default="splice-cleanroom-implementer:local")
    parser.add_argument("--runtime", default="podman")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="splice-cleanroom-check-") as temporary:
        root = Path(temporary)
        checks = deterministic(root / "deterministic")
        if args.container:
            try:
                checks.update(container(root / "container", args.image, args.runtime))
            except Exception as exc:
                checks["container_error"] = f"{type(exc).__name__}: {exc}"
    failed = sorted(name for name, value in checks.items() if value is not True)
    print(json.dumps({"checks": checks, "failed": failed,
                      "complete": not failed}, indent=2, sort_keys=True))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
