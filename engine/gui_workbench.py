"""Run a separate Linux GUI implementer from a ready public native spec."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import time
import uuid

from engine.artifacts import LocalArtifactStore
from model_config import get_model
from scripts.run_native_c_candidate import ready_dossier

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "splice-gui-implementer:local"
DELIVERABLE = "DELIVERABLE.json"
PUBLIC_SPEC_KEYS = {"schema", "kind", "status", "title", "purpose", "boundary",
                    "interface", "requirements", "behavior_steps", "examples",
                    "acceptance_criteria", "deviations", "exclusions"}


def public_spec(state: Path, artifact: str) -> dict:
    store = LocalArtifactStore(state / "artifacts")
    spec = json.loads(store.get(artifact))
    if spec.get("schema") != 2 or spec.get("kind") != "native_subsystem_spec" or \
            spec.get("status") != "ready_for_review":
        raise ValueError("GUI implementation requires a ready public native spec")
    ready_dossier(state, store, artifact)
    return {key: value for key, value in spec.items() if key in PUBLIC_SPEC_KEYS}


def _model_config(model: str) -> dict:
    permission = {"*": "allow"}
    config = {"$schema": "https://opencode.ai/config.json", "model": model,
              "small_model": model, "permission": permission,
              "agent": {"implementer": {"mode": "primary", "model": model,
                       "prompt": "Implement and test a Linux GUI application from the public spec and task.",
                       "permission": permission}}}
    provider, _, model_id = model.partition("/")
    if provider == "amazon-bedrock" and model_id.startswith("qwen."):
        config["provider"] = {provider: {"models": {model_id: {
            "name": model_id, "id": model_id, "status": "active",
            "provider": {"npm": "@ai-sdk/amazon-bedrock"},
            "limit": {"context": 32768, "output": 4000}}}}}
    return config


def _instructions(task: str) -> str:
    return f"""Task: {task}

The only behavior source in this workspace is public-specs.json. Build a Linux GUI
application that meets it. Choose the language and GUI toolkit yourself. You have a full
shell, a compiler, Python, package management, a virtual X display, screenshot and UI
automation tools. Install other public dependencies if useful. You may read public
documentation. Do not fetch or reuse an existing implementation of the target app.

Run the app under Xvfb with bounded timeouts, exercise its controls, and inspect the result.
Put all deliverable files under /work/app. Write /work/{DELIVERABLE} as JSON with exactly
these string keys:
entrypoint (relative path under app), run_command (shell command from /work/app),
verification (what you actually ran and observed), and limitations. Do not claim
equivalence beyond the public cases. Keep the final reply brief; the files are the result.
"""


def _safe_relative(value: str) -> bool:
    path = Path(value)
    return bool(value) and not path.is_absolute() and ".." not in path.parts


def validate_deliverable(workspace: Path) -> dict:
    path = workspace / DELIVERABLE
    value = json.loads(path.read_text())
    if not isinstance(value, dict) or set(value) != {
            "entrypoint", "run_command", "verification", "limitations"} or not all(
            isinstance(item, str) and item.strip() for item in value.values()):
        raise ValueError("GUI deliverable manifest has missing or invalid fields")
    if not _safe_relative(value["entrypoint"]):
        raise ValueError("GUI entrypoint must be relative to app")
    app = (workspace / "app").resolve()
    entrypoint = (app / value["entrypoint"]).resolve()
    if not entrypoint.is_relative_to(app) or not entrypoint.is_file():
        raise ValueError("GUI entrypoint is missing or escapes app")
    return value


def prepare_gui_workspace(state: Path, spec_artifacts: list[str], task: str, *,
                          model: str | None = None) -> tuple[Path, dict]:
    if not task.strip() or not spec_artifacts or len(spec_artifacts) != len(set(spec_artifacts)):
        raise ValueError("task and distinct public spec artifacts are required")
    state = state.resolve()
    specs = [public_spec(state, artifact) for artifact in spec_artifacts]
    workspace = state / "gui-implementations" / uuid.uuid4().hex
    (workspace / "app").mkdir(parents=True)
    (workspace / "public-specs.json").write_text(json.dumps(specs, indent=2) + "\n")
    (workspace / "INSTRUCTIONS.md").write_text(_instructions(task))
    resolved_model = get_model("engine_writer", explicit=model)
    (workspace / "opencode.json").write_text(json.dumps(_model_config(resolved_model), indent=2) + "\n")
    record_dir = state / "gui-implementation-results"
    record_dir.mkdir(parents=True, exist_ok=True)
    record_path = record_dir / f"{workspace.name}.json"
    record = {"schema": 1, "state": "prepared", "spec_artifacts": spec_artifacts,
              "workspace": str(workspace), "model": resolved_model,
              "record_path": str(record_path),
              "public_files": ["public-specs.json", "INSTRUCTIONS.md", "opencode.json"]}
    record_path.write_text(json.dumps(record, indent=2) + "\n")
    return workspace, record


def build_image(runtime: str = "podman") -> None:
    with TemporaryDirectory(prefix="splice-gui-build-") as context:
        subprocess.run([runtime, "build", "-t", IMAGE, "-f",
                        str(ROOT / "gui_implementer.Dockerfile"), context], check=True)


def run_gui_implementation(state: Path, spec_artifacts: list[str], task: str, *,
                           model: str | None = None, runtime: str = "podman",
                           opencode: Path = Path("/run/opencode-bin"),
                           auth_file: Path | None = Path("/run/opencode-auth.json"),
                           timeout: int = 3600, prepare_only: bool = False,
                           build: bool = False) -> dict:
    if timeout < 1:
        raise ValueError("timeout must be positive")
    workspace, record = prepare_gui_workspace(state, spec_artifacts, task, model=model)
    if prepare_only:
        return record
    container_name = "splice-gui-" + workspace.name[:12]
    command = [runtime, "run", "--rm", "--name", container_name,
               "--volume", f"{workspace}:/work:rw",
               "--volume", f"{opencode.resolve()}:/usr/local/bin/opencode:ro",
               "--workdir", "/work", "--env", "OPENCODE_CONFIG=/work/opencode.json",
               "--env", "OPENCODE_DISABLE_AUTOUPDATE=true",
               "--env", "OPENCODE_DISABLE_EXTERNAL_SKILLS=true"]
    if runtime == "podman":
        command.append("--cgroups=disabled")
    if auth_file and auth_file.is_file():
        command += ["--volume", f"{auth_file.resolve()}:/root/.local/share/opencode/auth.json:ro"]
    aws_profile = Path.home() / ".aws"
    if os.environ.get("AWS_PROFILE") and aws_profile.is_dir():
        command += ["--volume", f"{aws_profile.resolve()}:/root/.aws:ro"]
    for key in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"):
        if os.environ.get(key):
            command += ["--env", key]
    # The only host filesystem mounts are the public workspace and OpenCode credentials.
    command += [IMAGE, "python3", "-c", (
        "import pathlib,subprocess,sys; "
        "prompt=pathlib.Path('/work/INSTRUCTIONS.md').read_text(); "
        "out=open('/work/agent-events.jsonl','w'); "
        "sys.exit(subprocess.run(['/usr/local/bin/opencode','run','--pure',"
        "'--agent','implementer','--model',sys.argv[1],'--format','json',prompt],"
        "cwd='/work',stdout=out,stderr=subprocess.STDOUT).returncode)"), record["model"]]
    started = time.monotonic()
    try:
        if build:
            build_image(runtime)
        if not opencode.is_file():
            raise FileNotFoundError(f"OpenCode binary unavailable: {opencode}")
        completed = subprocess.run(command, capture_output=True, text=True,
                                   timeout=timeout, check=False)
        if completed.returncode:
            raise RuntimeError(f"GUI implementer exited {completed.returncode}: "
                               f"{completed.stderr[-1000:]}")
        deliverable = validate_deliverable(workspace)
        record.update(state="candidate_unverified", deliverable=deliverable)
    except subprocess.TimeoutExpired:
        subprocess.run([runtime, "rm", "-f", container_name],
                       capture_output=True, text=True, timeout=30, check=False)
        record.update(state="failed", error=f"GUI implementer timed out after {timeout} seconds")
    except Exception as error:
        record.update(state="failed", error=str(error))
    record["elapsed_seconds"] = round(time.monotonic() - started, 3)
    Path(record["record_path"]).write_text(json.dumps(record, indent=2) + "\n")
    return record
