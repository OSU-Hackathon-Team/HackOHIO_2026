"""Task dispatch and public-only GUI handoff checks; no model or container needed."""

from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from engine.artifacts import LocalArtifactStore
from engine.gui_workbench import (prepare_gui_workspace, run_gui_implementation,
                                  validate_deliverable)
from engine.task_orchestrator import parse_outcome, run_task


def ready_spec(state: Path, *, status: str = "ready_for_review",
               title: str = "Public behavior") -> str:
    store = LocalArtifactStore(state / "artifacts")
    spec_artifact = store.put(json.dumps({
        "schema": 2, "kind": "native_subsystem_spec", "status": status,
        "title": title, "requirements": [{"id": "REQ-1", "statement": "Add numbers"}],
    }).encode())
    dossier_artifact = store.put(json.dumps({
        "readiness": "ready_for_spec", "revision": 1, "private": "PRIVATE_DISASSEMBLY",
    }).encode())
    audit_artifact = store.put(json.dumps({
        "spec_artifact": spec_artifact, "dossier_artifact": dossier_artifact,
        "private": "PRIVATE_DISASSEMBLY",
    }).encode())
    pointer = state / "specifications" / "scope" / f"dossier-{dossier_artifact}-writer-{spec_artifact}.json"
    pointer.parent.mkdir(parents=True, exist_ok=True)
    pointer.write_text(json.dumps({
        "artifact": spec_artifact, "audit_artifact": audit_artifact,
        "dossier_artifact": dossier_artifact, "dossier_revision": 1,
    }))
    return spec_artifact


class TaskOrchestrationTest(unittest.TestCase):
    def test_task_preparation_hashes_inputs_and_reports_tools(self) -> None:
        with TemporaryDirectory() as folder:
            root = Path(folder)
            binary = root / "calculator.exe"
            binary.write_bytes(b"MZ test input")
            result = run_task("Bring Calculator to Linux", [binary], root / "state",
                              root / "opencode", prepare_only=True)
            self.assertEqual(result["state"], "prepared")
            self.assertEqual(result["inputs"][0]["path"], str(binary))
            self.assertEqual(len(result["inputs"][0]["sha256"]), 64)
            self.assertIn("project", result["capabilities"]["pipelines"])
            self.assertIn("Do not implement the app yourself",
                          (Path(result["run_dir"]) / "prompt.txt").read_text())

    def test_ready_claim_requires_persisted_public_spec_provenance(self) -> None:
        with TemporaryDirectory() as folder:
            state = Path(folder)
            store = LocalArtifactStore(state / "artifacts")
            artifact = ready_spec(state)
            outcome = {"status": "ready_for_implementation", "summary": "ready",
                       "spec_artifacts": [artifact], "artifacts": [], "open_work": []}
            self.assertEqual(parse_outcome(json.dumps(outcome), store), outcome)
            draft = ready_spec(state, status="draft")
            outcome["spec_artifacts"] = [draft]
            with self.assertRaises(ValueError):
                parse_outcome(json.dumps(outcome), store)
            outcome["status"] = "partial"
            with self.assertRaises(ValueError):
                parse_outcome(json.dumps(outcome), store)

    def test_task_agent_dispatches_only_a_valid_ready_outcome(self) -> None:
        with TemporaryDirectory() as folder:
            state = Path(folder)
            artifact = ready_spec(state)
            def invoke(_opencode, _folder, prompt, **kwargs):
                self.assertIn("queue-drain", prompt)
                self.assertEqual(kwargs["allow_tools"],
                                 ("bash", "read", "glob", "grep", "external_directory"))
                return {"text": json.dumps({
                    "status": "ready_for_implementation", "summary": "analyzed",
                    "spec_artifacts": [artifact], "artifacts": [artifact], "open_work": []}),
                    "usage": {}, "runtime_version": "fake"}
            result = run_task("A calculator for Linux", [], state, state / "opencode",
                              invoke=invoke)
            self.assertEqual(result["state"], "ready_for_implementation")

    def test_gui_workspace_contains_only_public_spec_and_task(self) -> None:
        with TemporaryDirectory() as folder:
            state = Path(folder)
            artifact = ready_spec(state)
            workspace, result = prepare_gui_workspace(state, [artifact],
                                                       "Create a Linux calculator")
            self.assertEqual(result["state"], "prepared")
            self.assertEqual(len(json.loads((workspace / "public-specs.json").read_text())), 1)
            self.assertNotIn("PRIVATE_DISASSEMBLY", "".join(
                path.read_text() for path in workspace.rglob("*") if path.is_file()))
            self.assertFalse((workspace / "artifacts").exists())
            self.assertFalse((workspace / "host-result.json").exists())

    def test_gui_workspace_combines_distinct_ready_subsystems(self) -> None:
        with TemporaryDirectory() as folder:
            state = Path(folder)
            first = ready_spec(state, title="Arithmetic")
            second = ready_spec(state, title="Memory")
            workspace, _ = prepare_gui_workspace(state, [first, second], "Calculator GUI")
            self.assertEqual([item["title"] for item in json.loads(
                (workspace / "public-specs.json").read_text())], ["Arithmetic", "Memory"])

    def test_gui_container_mounts_only_public_workspace_and_runtime_files(self) -> None:
        with TemporaryDirectory() as folder:
            state = Path(folder)
            artifact = ready_spec(state)
            opencode = state / "opencode"
            opencode.write_text("fake")
            captured = []
            def run(command, **_kwargs):
                captured.append(command)
                workspace = next((part.split(":", 1)[0] for part in command
                                  if part.endswith(":/work:rw")), None)
                assert workspace
                app = Path(workspace) / "app"
                (app / "main.py").write_text("print('test')\n")
                (Path(workspace) / "DELIVERABLE.json").write_text(json.dumps({
                    "entrypoint": "main.py", "run_command": "python3 main.py",
                    "verification": "ran a smoke check", "limitations": "unverified against original",
                }))
                class Result:
                    returncode = 0
                    stderr = ""
                return Result()
            with patch("engine.gui_workbench.subprocess.run", side_effect=run):
                result = run_gui_implementation(state, [artifact], "Linux calculator",
                                                opencode=opencode, auth_file=None)
            self.assertEqual(result["state"], "candidate_unverified")
            self.assertIn("--cgroups=disabled", captured[0])
            volumes = [captured[0][i + 1] for i, arg in enumerate(captured[0][:-1])
                       if arg == "--volume"]
            self.assertEqual(len(volumes), 2)
            self.assertFalse(any("/artifacts" in item or "/specifications" in item
                                 for item in volumes))

    def test_deliverable_entrypoint_cannot_escape_workspace(self) -> None:
        with TemporaryDirectory() as folder:
            workspace = Path(folder)
            (workspace / "app").mkdir()
            (workspace / "DELIVERABLE.json").write_text(json.dumps({
                "entrypoint": "../private.bin", "run_command": "python x",
                "verification": "done", "limitations": "unknown",
            }))
            with self.assertRaises(ValueError):
                validate_deliverable(workspace)


if __name__ == "__main__":
    unittest.main()
