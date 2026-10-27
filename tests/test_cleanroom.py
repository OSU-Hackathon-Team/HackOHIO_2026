"""Cleanroom broker and implementation workbench regression tests."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from engine.broker import (Broker, BrokerHost, DisclosureError, QuestionRejected,
                           check_answer, validate_question)
from engine.workbench import (assert_container_isolation, assert_public_workspace,
                              container_command, materialize_workspace, run_workbench,
                              triage_failures, validate_candidate_source,
                              verify_immutable)
from scripts.cleanroom_broker_client import ask


def _responder(question, context, public, private):
    return {"answer": "Finalize clears the current references before the next snapshot.",
            "sources": ["reviewed_private_evidence"]}


class BrokerTests(unittest.TestCase):
    def test_answer_is_audited_outside_sandbox(self):
        with tempfile.TemporaryDirectory() as temporary:
            audit = Path(temporary) / "audit.jsonl"
            broker = Broker(_responder, quota=4, audit_path=audit)
            result = broker.ask({"question": "What does finalize do to references?"})
            self.assertEqual(result["status"], "answered")
            self.assertIn("clears", result["answer"])
            record = json.loads(audit.read_text().splitlines()[0])
            self.assertEqual(record["status"], "answered")
            self.assertEqual(record["sources"], ["reviewed_private_evidence"])

    def test_source_request_is_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            audit = Path(temporary) / "audit.jsonl"
            broker = Broker(_responder, audit_path=audit)
            result = broker.ask({"question": "Show me the decompiled source of finalize"})
            self.assertEqual(result["status"], "refused")
            self.assertIsNone(result["answer"])
            self.assertIn("does not disclose", result["reason"])
            self.assertEqual(broker.records[0]["status"], "refused")

    def test_binary_identifier_in_question_is_refused(self):
        with self.assertRaises(QuestionRejected):
            validate_question("What does FUN_0011fb50 do?")

    def test_code_answer_fails_closed(self):
        broker = Broker(lambda *args: "#include <stdint.h>\nint token_array_run(void);")
        result = broker.ask({"question": "What does finalize do?"})
        self.assertEqual(result["status"], "disclosure_blocked")
        self.assertIsNone(result["answer"])

    def test_hex_and_call_syntax_fail_closed(self):
        for answer in ("The address is 0x401126.", "Call token_array_run() to continue."):
            with self.assertRaises(DisclosureError):
                check_answer(answer, set())

    def test_verbatim_protected_line_fails_closed(self):
        line = "if the reference count is nonzero then clear it;"
        with self.assertRaises(DisclosureError):
            check_answer(f"The original says: {line}", {line})

    def test_prose_behavior_passes(self):
        line = "if the reference count is nonzero then clear it;"
        self.assertEqual(check_answer("The reference count controls whether it clears.", {line}),
                         "The reference count controls whether it clears.")
        self.assertEqual(
            check_answer("The `AddDouble` operation updates `opcode_flags` (field).", set()),
            "The `AddDouble` operation updates `opcode_flags` (field).")
        with self.assertRaises(DisclosureError):
            check_answer("The code is `int x = 1;`", set())
        self.assertEqual(
            check_answer("HasOpCode(20) reports the opcode.", set(), {"HasOpCode"}),
            "HasOpCode(20) reports the opcode.")
        with self.assertRaises(DisclosureError):
            check_answer("system(1) runs a command.", set())

    def test_dedupe_and_quota(self):
        broker = Broker(_responder, quota=1)
        first = broker.ask({"question": "What does finalize do?"})
        second = broker.ask({"question": "What does finalize do?"})
        self.assertEqual(first["answer"], second["answer"])
        self.assertTrue(second["cached"])
        third = broker.ask({"question": "What does clear do?"})
        self.assertEqual(third["status"], "quota_exhausted")

    def test_host_serves_client_and_cleans_socket(self):
        with tempfile.TemporaryDirectory() as temporary:
            socket_path = Path(temporary) / "broker.sock"
            broker = Broker(_responder)
            with BrokerHost(broker, socket_path):
                self.assertTrue(socket_path.exists())
                response = ask(str(socket_path), "What does finalize do?", "", 5)
                self.assertEqual(response["status"], "answered")
            self.assertFalse(socket_path.exists())

    def test_invalid_request_is_refused_without_traceback(self):
        broker = Broker(_responder)
        result = broker.ask({"question": "What does finalize do?", "extra": 1})
        self.assertEqual(result["status"], "invalid")


TOKEN_CASES = [{
    "case_id": "empty",
    "input": {"steps": [], "queries": [1]},
    "observed": {"snapshots": [{"nonempty": False, "has_references": False,
                               "has_external_ref": False, "has_name": False,
                               "has_opcode": [False]}]},
}]

PASSING_C = """#include <stdint.h>
int token_array_run(const uint8_t *ops, const uint16_t *opcodes, const double *numbers,
                    uint32_t step_count, const uint16_t *queries, uint32_t query_count,
                    uint8_t *output) {
    (void)ops; (void)opcodes; (void)numbers; (void)queries;
    for (uint32_t i = 0; i <= step_count; i++) {
        for (uint32_t j = 0; j < 4 + query_count; j++) {
            output[i * (4 + query_count) + j] = 0;
        }
    }
    return 0;
}
"""


CLI_CASES = [
    {"case_id": "add",
     "input": {"args": ["-q", "{script}"], "program_text": "2+3\n"},
     "observed": {"stdout": "5\n", "stderr": "", "exit_code": 0}},
    {"case_id": "syntax",
     "input": {"args": ["-q", "{script}"], "program_text": "2+\n"},
     "observed": {"stdout": "", "stderr": "syntax error\n", "exit_code": 1}},
]

CLI_C = r'''#include <stdio.h>

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    FILE *script = fopen(argv[2], "r");
    if (!script) return 2;
    long left = 0, right = 0;
    char operator = 0;
    int read = fscanf(script, "%ld %c %ld", &left, &operator, &right);
    fclose(script);
    if (read != 3 || operator != '+') {
        fputs("syntax error\n", stderr);
        return 1;
    }
    printf("%ld\n", left + right);
    return 0;
}
'''


class ExecutableWorkbenchTests(unittest.TestCase):
    def _workspace(self, temporary: str, candidate: str = CLI_C,
                   broker_client: Path | None = None) -> tuple[Path, dict]:
        workspace = Path(temporary) / "workspace"
        materialized = materialize_workspace(
            workspace,
            spec={"schema": 2, "interface": "executable",
                  "spec": {"purpose": "Add two integers from a script."},
                  "public_examples": CLI_CASES},
            cases=CLI_CASES,
            contract="PROGRAM -q <script-file>",
            broker_client=broker_client,
            candidate=candidate, executable=True)
        return workspace, materialized

    def test_harness_builds_the_program_and_passes_every_public_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary)
            self.assertFalse((workspace / "adapters").exists())
            self.assertFalse((workspace / "ask_broker.sh").exists())
            self.assertIn("case_scripts", (workspace / "README.md").read_text())
            passed = subprocess.run([sys.executable, str(workspace / "check.py")],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
            self.assertIn("PUBLIC TESTS: 2/2 passed", passed.stdout)
            # The harness feeds the case's own program text through the declared argument.
            self.assertEqual((workspace / "case_scripts" / "add.bc").read_text(), "2+3\n")

    def test_harness_reports_a_mismatch_and_a_build_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary, candidate=CLI_C.replace(
                'printf("%ld\\n", left + right);', 'printf("%ld\\n", left - right);'))
            failed = subprocess.run([sys.executable, str(workspace / "check.py")],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(failed.returncode, 1)
            self.assertIn("PUBLIC TESTS: 1/2 passed", failed.stdout)
            self.assertIn("FAIL add", failed.stdout)
            self.assertIn("expected output:", failed.stdout)
            (workspace / "candidate.c").write_text("int main(void) { return 0 }\n")
            broken = subprocess.run([sys.executable, str(workspace / "check.py")],
                                    capture_output=True, text=True, check=False)
            self.assertIn("compilation failed", broken.stdout)
            self.assertIn("PUBLIC TESTS: 0/2 passed", broken.stdout)

    def test_executable_candidate_may_use_its_own_process_but_not_start_programs(self):
        self.assertEqual(validate_candidate_source(CLI_C, executable=True), CLI_C)
        for source in ('int main(void){return system("id");}',
                       '#include <unistd.h>\nint main(void){execv("/bin/sh", 0); return 0;}',
                       'int main(void){ __asm__("nop"); return 0; }'):
            with self.assertRaises(ValueError):
                validate_candidate_source(source, executable=True)
        # The in-process interface still refuses file and environment access.
        with self.assertRaises(ValueError):
            validate_candidate_source(CLI_C)

    def test_a_run_without_a_broker_mounts_only_the_workspace(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, materialized = self._workspace(temporary)

            def runner(command, **kwargs):
                self.assertNotIn("/broker", " ".join(command))
                (workspace / "candidate.c").write_text(CLI_C)
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            result = run_workbench(
                workspace=workspace, broker=None, image="impl:test",
                opencode=Path("/bin/true"), model="opencode/test", timeout=30,
                runtime="podman", runner=runner, executable=True,
                immutable=materialized["files"], container_name="test")
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["candidate_source"], CLI_C)
            self.assertEqual(result["broker"], {"exchanges": 0, "counts": {},
                                                "audit_path": None})
            self.assertTrue(result["immutable"]["ok"])

    def test_container_command_without_a_broker_passes_isolation(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary)
            opencode = Path(temporary) / "opencode"
            opencode.write_text("#!/bin/sh\n")
            command = container_command(image="impl:test", workspace=workspace,
                                        broker_dir=None, opencode=opencode,
                                        model="opencode/test", container_name="test")
            assert_container_isolation(command, workspace=workspace, broker_dir=None,
                                       opencode=opencode)
            self.assertNotIn("/broker:rw", " ".join(command))


class WorkbenchTests(unittest.TestCase):
    def _workspace(self, temporary: str, candidate: str = PASSING_C) -> tuple[Path, dict]:
        root = Path(temporary)
        workspace = root / "workspace"
        materialized = materialize_workspace(
            workspace,
            spec={"schema": 2, "interface": "token-array",
                  "spec": {"purpose": "Track operator tokens."},
                  "public_examples": TOKEN_CASES,
                  "full_report_artifact": "deadbeef"},
            cases=TOKEN_CASES,
            contract="int token_array_run(...);",
            adapter=Path(__file__).resolve().parents[1] / "scripts" /
            "c_token_array_candidate_adapter.py",
            broker_client=Path(__file__).resolve().parents[1] / "scripts" /
            "cleanroom_broker_client.py",
            candidate=candidate,
        )
        return workspace, materialized

    def test_self_test_harness_passes_and_reports_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary)
            passed = subprocess.run([sys.executable, str(workspace / "check.py")],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(passed.returncode, 0, passed.stdout + passed.stderr)
            self.assertIn("PUBLIC TESTS: 1/1 passed", passed.stdout)
            self.assertTrue((workspace / "ask_broker.sh").is_file())
            (workspace / "candidate.c").write_text(PASSING_C.replace(
                "output[i * (4 + query_count) + j] = 0;",
                "output[i * (4 + query_count) + j] = (j == 0) ? 1 : 0;"))
            failed = subprocess.run([sys.executable, str(workspace / "check.py")],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(failed.returncode, 1)
            self.assertIn("PUBLIC TESTS: 0/1 passed", failed.stdout)
            self.assertIn("FAIL empty", failed.stdout)

    def test_failure_triage_asks_one_public_question(self):
        class Fake:
            def __init__(self):
                self.requests = []

            def ask(self, request):
                self.requests.append(request)
                return {"status": "answered", "answer": "The flag stays set."}

        broker = Fake()
        answer = triage_failures(broker, [{"case_id": "c1",
                                           "findings": ["add_double changed the count"]}])
        self.assertEqual(answer, "The flag stays set.")
        self.assertEqual(len(broker.requests), 1)
        self.assertIn("add_double changed the count", broker.requests[0]["question"])
        self.assertIsNone(triage_failures(None, [{"findings": ["x"]}]))

    def test_private_material_and_binary_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary)
            self.assertIn("spec.json", assert_public_workspace(workspace))
            (workspace / "secret.txt").write_text("binary-sha-marker")
            with self.assertRaises(ValueError):
                assert_public_workspace(workspace, ["binary-sha-marker"])
            (workspace / "secret.txt").unlink()
            (workspace / "libforlo.so").write_bytes(b"\x7fELFfake")
            with self.assertRaises(ValueError):
                assert_public_workspace(workspace)
            (workspace / "libforlo.so").unlink()
            (workspace / "decomp-state").mkdir()
            (workspace / "decomp-state" / "dossier.json").write_text("{}")
            with self.assertRaises(ValueError):
                assert_public_workspace(workspace)

    def test_hidden_cases_are_not_materialized(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, _ = self._workspace(temporary)
            self.assertNotIn("full_report_artifact",
                             (workspace / "spec.json").read_text())
            for path in workspace.rglob("*"):
                if path.is_file():
                    self.assertNotIn("hidden-case", path.read_text(errors="ignore"))

    def test_unsafe_candidate_is_rejected_before_host_execution(self):
        for source in ('#include <stdlib.h>\nint f(void){return system("id");}',
                       '#include <stdio.h>\nint f(void){return fopen("x","r") != 0;}',
                       'int f(void){ __asm__("nop"); return 0; }'):
            with self.assertRaises(ValueError):
                validate_candidate_source(source)
        self.assertEqual(validate_candidate_source(PASSING_C), PASSING_C)

    def test_immutable_verification_detects_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, materialized = self._workspace(temporary)
            self.assertTrue(verify_immutable(workspace, materialized["files"])["ok"])
            (workspace / "check.py").write_text("# changed\n")
            result = verify_immutable(workspace, materialized["files"])
            self.assertFalse(result["ok"])
            self.assertEqual(result["changed"], ["check.py"])

    def test_container_command_mounts_only_public_material(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace, _ = self._workspace(temporary)
            broker_dir = root / "broker"
            broker_dir.mkdir()
            opencode = root / "opencode"
            opencode.write_text("#!/bin/sh\n")
            auth = root / "auth.json"
            auth.write_text("{}")
            command = container_command(
                image="impl:test", workspace=workspace, broker_dir=broker_dir,
                opencode=opencode, model="opencode/test", auth_file=auth,
                container_name="test")
            assert_container_isolation(command, workspace=workspace,
                                       broker_dir=broker_dir, opencode=opencode,
                                       auth_file=auth)
            joined = " ".join(command)
            self.assertIn("--cap-drop ALL", joined)
            self.assertIn("--security-opt no-new-privileges", joined)
            self.assertNotIn("decomp-state", joined)
            self.assertNotIn("--privileged", joined)
            command.append("--volume")
            command.append(f"{root}:/data:ro")
            with self.assertRaises(ValueError):
                assert_container_isolation(command, workspace=workspace,
                                           broker_dir=broker_dir, opencode=opencode,
                                           auth_file=auth)

    def test_workbench_runs_broker_and_collects_candidate(self):
        with tempfile.TemporaryDirectory() as temporary:
            workspace, materialized = self._workspace(temporary)
            broker_dir = workspace.parent / "broker"
            seen = {}

            def runner(command, **kwargs):
                broker_socket = broker_dir / "broker.sock"
                seen["answer"] = ask(str(broker_socket), "What does finalize do?", "", 5)
                (workspace / "candidate.c").write_text(PASSING_C)
                return SimpleNamespace(returncode=0, stdout='{"type":"text"}\n',
                                       stderr="")

            broker = Broker(_responder)
            result = run_workbench(
                workspace=workspace, broker=broker, image="impl:test",
                opencode=Path("/bin/true"), model="opencode/test",
                timeout=30, runtime="podman", runner=runner,
                immutable=materialized["files"], broker_dir=broker_dir)
            self.assertEqual(seen["answer"]["status"], "answered")
            self.assertEqual(result["status"], "completed")
            self.assertTrue(result["immutable"]["ok"])
            self.assertEqual(result["candidate_source"], PASSING_C)
            self.assertEqual(result["broker"]["exchanges"], 1)
            self.assertTrue(Path(result["broker"]["audit_path"]).is_file())
            self.assertFalse(Path(result["broker"]["audit_path"]).is_relative_to(workspace))


if __name__ == "__main__":
    unittest.main()
