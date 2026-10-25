"""Task-level agent that selects existing analysis pipelines and hands off a ready spec."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil
import time
import uuid

from engine.artifacts import LocalArtifactStore
from engine.gui_workbench import public_spec
from engine.model_runtime import invoke_opencode
from model_config import get_model

ROOT = Path(__file__).resolve().parents[1]
PIPELINES = {
    "native": "launch.py: analyze, scope, work, review, probe, dossier, spec",
    "project": "launch.py: project-analyze, project-scope, project-queue-init, project-queue-drain, project-queue-status",
    "queue": "launch.py: queue-init, queue-enqueue, queue-drain, queue-review-drain, queue-task, queue-events",
    "functional": "scripts/run_functional_c_e2e.py: observation-derived functional C path, currently token-array only",
    "calc_discovery": "scripts/run_calc_discovery.py: LibreOffice Calc example, not Windows Calculator",
    "gui_implementation": "launch.py gui-implement: separate public-spec-only Linux GUI workbench",
}
PIPELINE_FILES = {"native": "launch.py", "project": "launch.py",
                  "queue": "launch.py", "functional": "scripts/run_functional_c_e2e.py",
                  "calc_discovery": "scripts/run_calc_discovery.py",
                  "gui_implementation": "launch.py"}
TOOLS = ("bash", "read", "glob", "grep", "external_directory")


def capabilities() -> dict:
    """Report what this checkout can actually execute, without selecting a strategy."""
    binaries = ("python3", "podman", "docker", "readelf", "file", "wine",
                "xvfb-run", "cc", "opencode", "psql")
    return {
        "executables": {name: shutil.which(name) for name in binaries},
        "pipelines": {name: description for name, description in PIPELINES.items()
                      if (ROOT / PIPELINE_FILES[name]).is_file()},
        "docs": [name for name in ("DecompPileline.md", "DECOMP_IMPLEMENTATION_PLAN.md",
                                    "README.md") if (ROOT / name).is_file()],
    }


def _digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def task_prompt(task: str, inputs: list[dict], state: Path, inventory: dict) -> str:
    return f"""You are the task-level orchestration agent for Splice's decompilation engine.
User task: {task}
Supplied inputs (paths and hashes): {json.dumps(inputs)}
Engine repository: {ROOT}
Engine state: {state}
Available capabilities: {json.dumps(inventory)}

Choose your own approach. Inspect the source-of-truth docs, CLI help, target artifacts, and
available tools as needed. Dispatch existing intake, analysis, review, probe, dossier and
specification pipelines when they fit. You may create request JSON, probe adapters, and
other task-specific analysis files under {state}, and install public tools in this
disposable orchestrator container when useful. Do not change engine source or fabricate
original observations. Treat unsupported behavior and failed tools as open work. A static
candidate link, model claim, or passing example does not establish whole-app equivalence.
You are already inside `launch.py task`; do not invoke `launch.py task` recursively.
Lock files and file counts do not prove that work is active or complete. Check live
processes and recorded progress when that distinction matters.

The Linux GUI implementation is performed by a separate agent. It receives only a ready
public spec through `launch.py gui-implement`, never binaries, raw analysis, private
audits, or held-out cases. Do not implement the app yourself. You may inspect
`python launch.py --help` and relevant script help to select pipelines. The task may need
more than one subsystem; do not present a partial subsystem as a full app.

At the end, return exactly one JSON object with keys status, summary, spec_artifacts,
artifacts, and open_work. status is one of ready_for_implementation, partial, blocked.
spec_artifacts is a nonempty list of public native spec IDs only when every needed
spec is ready and their combined boundary covers the requested application; otherwise
an empty list. artifacts and open_work are arrays of strings. Describe what you actually
ran and observed.
"""


def parse_outcome(reply: str, store: LocalArtifactStore) -> dict:
    fenced = reply.rfind("```json")
    if fenced >= 0:
        reply = reply[fenced + len("```json"):]
        reply = reply[:reply.find("```")] if "```" in reply else reply
    start, end = reply.find("{"), reply.rfind("}")
    if start < 0 or end < start:
        raise ValueError("orchestrator returned no JSON object")
    value = json.loads(reply[start:end + 1])
    if isinstance(value, dict) and value.get("status") in {"partial", "blocked"} and \
            set(value) == {"status", "reason", "completed_steps", "next_steps"}:
        value = {"status": value["status"], "summary": value["reason"],
                 "spec_artifacts": [], "artifacts": value["completed_steps"],
                 "open_work": value["next_steps"]}
    if not isinstance(value, dict) or set(value) != {
            "status", "summary", "spec_artifacts", "artifacts", "open_work"}:
        raise ValueError("orchestrator outcome has wrong fields")
    if value["status"] not in {"ready_for_implementation", "partial", "blocked"}:
        raise ValueError("invalid orchestrator status")
    if not isinstance(value["summary"], str) or not all(
            isinstance(value[k], list) and all(isinstance(item, str) for item in value[k])
            for k in ("artifacts", "open_work")):
        raise ValueError("invalid orchestrator summary or lists")
    artifacts = value["spec_artifacts"]
    if not isinstance(artifacts, list) or not all(isinstance(item, str) for item in artifacts):
        raise ValueError("spec_artifacts must be an array of IDs")
    if value["status"] == "ready_for_implementation":
        if not artifacts or len(artifacts) != len(set(artifacts)):
            raise ValueError("ready outcome requires distinct spec artifacts")
        for artifact in artifacts:
            public_spec(store.root.parent, artifact)
    elif artifacts:
        raise ValueError("partial or blocked outcome cannot dispatch implementation")
    return value


def run_task(task: str, inputs: list[Path], state: Path, opencode: Path, *,
             model: str | None = None, timeout: int = 1800,
             prepare_only: bool = False, invoke=invoke_opencode) -> dict:
    if not task.strip() or timeout < 1:
        raise ValueError("task must be nonempty and timeout positive")
    state = state.resolve()
    state.mkdir(parents=True, exist_ok=True)
    supplied = []
    for path in inputs:
        resolved = path.resolve(strict=True)
        if not resolved.is_file():
            raise ValueError(f"input is not a file: {path}")
        supplied.append({"path": str(resolved), "sha256": _digest(resolved)})
    folder = state / "tasks" / uuid.uuid4().hex
    folder.mkdir(parents=True)
    inventory = capabilities()
    prompt = task_prompt(task, supplied, state, inventory)
    (folder / "prompt.txt").write_text(prompt)
    resolved_model = get_model("decomp_orchestrator", explicit=model)
    result = {"schema": 1, "task": task, "inputs": supplied, "state": "prepared",
              "model": resolved_model, "capabilities": inventory, "run_dir": str(folder)}
    if prepare_only:
        (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        return result
    started = time.monotonic()
    try:
        reply = invoke(opencode, folder, prompt, model=resolved_model, timeout=timeout,
                       env_file=ROOT / ".env", agent_name="task-orchestrator",
                       agent_instruction=("Orchestrate using real tools and evidence. "
                                          "Final answer must be only one JSON object with exactly "
                                          "status, summary, spec_artifacts, artifacts, open_work. "
                                          "If a ready public spec is unavailable, return partial "
                                          "or blocked with an empty spec_artifacts list. "
                                          "Never return an action or wait wrapper."),
                       allow_tools=TOOLS)
        outcome = parse_outcome(reply["text"], LocalArtifactStore(state / "artifacts"))
        result.update(state=outcome["status"], outcome=outcome, usage=reply["usage"],
                      runtime_version=reply["runtime_version"])
    except Exception as error:
        result.update(state="failed", error=str(error))
    result["elapsed_seconds"] = round(time.monotonic() - started, 3)
    (folder / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
