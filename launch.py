"""Docker-contained Podman launcher for isolated Ghidra agent attempts."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

from model_config import available_roles, get_model, resolved_table
from engine.analysis.ghidra import GhidraAnalysis
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.worker import SemanticWorker

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
ENGINE_STATE = ROOT / "decomp-state"
IMAGE = "decomp-ghidra-worker:12.1.3"


def podman(*args: str, capture: bool = False, timeout: int | None = None) -> str:
    completed = subprocess.run(
        ["podman", *args], check=True, text=True,
        stdout=subprocess.PIPE if capture else None,
        timeout=timeout,
    )
    return completed.stdout or ""


def build() -> None:
    podman("build", "-t", IMAGE, "-f", str(ROOT / "worker.Dockerfile"), str(ROOT))


def worker(workspace: Path, mode: str) -> None:
    container_name = f"decomp-{workspace.name[:12]}-{mode}"
    args = ["run", "--rm", "--name", container_name, "--network=host",
            "--volume", f"{ROOT}:/app:ro",
            "--volume", f"{workspace}:/work:rw",
            "--env", "GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.3_PUBLIC"]
    for var in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
                "AWS_REGION", "AWS_DEFAULT_REGION"):
        if var in os.environ:
            args += ["--env", f"{var}={os.environ[var]}"]
    if mode == "run":
        for path in ("/run/opencode-bin", "/run/opencode-auth.json"):
            if not Path(path).is_file():
                raise RuntimeError(f"OpenCode mount missing in Docker orchestrator: {path}")
        args += ["--volume", "/run/opencode-bin:/usr/local/bin/opencode:ro",
                 "--volume", "/run/opencode-auth.json:/root/.local/share/opencode/auth.json:ro"]
    args += [IMAGE, "python", "/app/agent_worker.py", mode]
    manifest = json.loads((workspace / "manifest.json").read_text())
    limit = manifest["timeout_seconds"] + 180 if mode == "run" else 180
    try:
        podman(*args, timeout=limit)
    except subprocess.TimeoutExpired as error:
        subprocess.run(["podman", "rm", "-f", container_name],
                       capture_output=True, check=False, timeout=30)
        (workspace / "error.json").write_text(json.dumps({
            "stage": mode, "error": f"container timed out after {limit} seconds"}, indent=2) + "\n")
        raise RuntimeError(f"{mode} timed out after {limit} seconds") from error


DEFAULT_MODEL_ROLE = "decomp_worker"


def resolve_model(explicit: str | None = None,
                  role: str | None = None) -> tuple[str, str]:
    """Resolve (model, role) via models.json + MODEL_<ROLE> env overrides."""
    active_role = role or DEFAULT_MODEL_ROLE
    return get_model(active_role, explicit=explicit), active_role


def run(binary: Path, address: str, new_name: str,
        model: str | None = None, model_role: str = DEFAULT_MODEL_ROLE,
        timeout: int = 180) -> Path:
    if timeout < 1:
        raise ValueError("timeout must be positive")
    if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", new_name):
        raise ValueError("new name must be a simple Ghidra symbol name")
    if not re.fullmatch(r"(?:0x)?[0-9a-fA-F]+", address):
        raise ValueError("address must be hexadecimal, for example 0x401126")
    RUNS.mkdir(exist_ok=True)
    workspace = RUNS / uuid.uuid4().hex
    workspace.mkdir()
    shutil.copy2(binary.resolve(strict=True), workspace / "input.bin")
    resolved_model, active_role = resolve_model(model, model_role)
    digest = hashlib.sha256((workspace / "input.bin").read_bytes()).hexdigest()
    manifest = {"attempt_id": workspace.name, "binary_sha256": digest,
                "address": address, "new_name": new_name, "model": resolved_model,
                "model_role": active_role,
                "timeout_seconds": timeout, "project_name": "analysis",
                "program_name": "input.bin"}
    (workspace / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Attempt: {workspace}", flush=True)
    worker(workspace, "run")
    worker(workspace, "verify")
    print((workspace / "result.json").read_text())
    return workspace


def dispatch_many(assignments: list[dict], max_workers: int = 2) -> list[Path]:
    """Send independent function attempts to separate Podman workers."""
    if max_workers < 1:
        raise ValueError("max_workers must be positive")
    if not assignments:
        return []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(
            run, Path(item["binary"]), item["address"], item["new_name"],
            item.get("model"), item.get("model_role", DEFAULT_MODEL_ROLE),
            item.get("timeout", 180))
            for item in assignments]
        return [future.result() for future in futures]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    analyze = sub.add_parser("analyze", help="import a native executable or shared library and index it")
    analyze.add_argument("--binary", type=Path, required=True)
    analyze.add_argument("--state", type=Path, default=ENGINE_STATE)
    analyze.add_argument("--headless", type=Path,
                         default=Path(os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
    function = sub.add_parser("function", help="export one indexed function's decompiler evidence")
    function.add_argument("--manifest", type=Path, required=True)
    function.add_argument("--address", required=True)
    function.add_argument("--state", type=Path, default=ENGINE_STATE)
    function.add_argument("--headless", type=Path,
                          default=Path(os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
    export_all = sub.add_parser("export-all", help="decompile every indexed function and report coverage")
    export_all.add_argument("--manifest", type=Path, required=True)
    export_all.add_argument("--state", type=Path, default=ENGINE_STATE)
    export_all.add_argument("--headless", type=Path,
                            default=Path(os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
    scope = sub.add_parser("scope", help="discover a bounded native subsystem from a scope request")
    scope.add_argument("--manifest", type=Path, required=True)
    scope.add_argument("--request", type=Path, required=True)
    scope.add_argument("--state", type=Path, default=ENGINE_STATE)
    work = sub.add_parser("work", help="run one bounded semantic task on exported evidence")
    work.add_argument("--manifest", type=Path, required=True)
    work.add_argument("--scope-artifact", required=True)
    work.add_argument("--subject", required=True)
    work.add_argument("--state", type=Path, default=ENGINE_STATE)
    work.add_argument("--model-role", default="decomp_worker")
    work.add_argument("--model", default=None)
    work.add_argument("--timeout", type=int, default=180)
    work.add_argument("--opencode", type=Path,
                      default=Path(os.environ.get("OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
    status = sub.add_parser("status", help="show persisted decomp campaign progress")
    status.add_argument("--state", type=Path, default=ENGINE_STATE)
    status.add_argument("--campaign", help="limit output to one campaign hash")
    sub.add_parser("build", help="build the Ghidra worker image with Podman inside Docker")
    rename = sub.add_parser("rename", help="run one autonomous rename attempt")
    rename.add_argument("--binary", type=Path, required=True)
    rename.add_argument("--address", required=True)
    rename.add_argument("--new-name", required=True)
    rename.add_argument("--model", default=None,
                        help="explicit OpenCode model (provider/model); overrides models.json role")
    rename.add_argument("--model-role", default=DEFAULT_MODEL_ROLE,
                        help=f"role looked up in models.json (default: {DEFAULT_MODEL_ROLE})")
    rename.add_argument("--timeout", type=int, default=180)
    batch = sub.add_parser("batch", help="dispatch independent rename agents from JSON")
    batch.add_argument("--assignments", type=Path, required=True)
    batch.add_argument("--max-workers", type=int, default=2)
    sub.add_parser("list-models", help="print resolved role -> model table from models.json")
    args = parser.parse_args()
    if args.command == "analyze":
        engine = GhidraAnalysis(args.state, args.headless)
        manifest = engine.analyze(args.binary)
        print(json.dumps(manifest, indent=2))
    elif args.command == "function":
        engine = GhidraAnalysis(args.state, args.headless)
        manifest = json.loads(args.manifest.read_text())
        print(json.dumps(engine.function(manifest, args.address), indent=2))
    elif args.command == "export-all":
        engine = GhidraAnalysis(args.state, args.headless)
        manifest = json.loads(args.manifest.read_text())
        print(json.dumps(engine.export_all(manifest), indent=2))
    elif args.command == "scope":
        engine = GhidraAnalysis(args.state, Path(os.environ.get(
            "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
        manifest = json.loads(args.manifest.read_text())
        request = ScopeRequest.from_dict(json.loads(args.request.read_text()))
        print(json.dumps(persist_scope(engine, manifest, request), indent=2))
    elif args.command == "work":
        engine = GhidraAnalysis(args.state, Path(os.environ.get(
            "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
        manifest = json.loads(args.manifest.read_text())
        worker = SemanticWorker(engine, args.opencode, timeout=args.timeout)
        result = worker.run(manifest, args.scope_artifact, args.subject,
                            model=args.model, model_role=args.model_role)
        print(json.dumps(result, indent=2))
        if result["state"] in {"failed", "rejected"}:
            raise SystemExit(1)
    elif args.command == "status":
        events_path = args.state / "progress.jsonl"
        events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
        if args.campaign:
            events = [event for event in events if event["campaign"] == args.campaign]
        campaigns = {}
        for event in events:
            item = campaigns.setdefault(event["campaign"],
                                        {"last_stage": None, "function_exports": 0,
                                         "function_failures": 0, "_exported": set(),
                                         "_failed": set(), "_semantic": {},
                                         "_scopes": {}})
            item["last_stage"] = event["stage"]
            if event["stage"] == "indexed":
                item["function_count"] = event["functions"]
            elif event["stage"] == "function_exported":
                item["_exported"].add(event["address"])
            elif event["stage"] == "function_failed":
                item["_failed"].add(event["address"])
            elif event["stage"] == "export_finished":
                item["coverage"] = event["counts"]
                item["complete"] = event["complete"]
            elif event["stage"] == "scope_revised":
                item["_scopes"][event["scope_id"]] = {
                    "revision": event["revision"], "included": event["included"],
                    "unresolved": event["unresolved"]}
            elif event["stage"] == "semantic_started":
                item["_semantic"][event["attempt_id"]] = "running"
            elif event["stage"] == "semantic_finished":
                item["_semantic"][event["attempt_id"]] = event["status"]
        for item in campaigns.values():
            item["function_exports"] = len(item.pop("_exported"))
            item["function_failures"] = len(item.pop("_failed"))
            states = list(item.pop("_semantic").values())
            item["semantic_attempts"] = len(states)
            item["semantic_states"] = {state: states.count(state) for state in sorted(set(states))}
            item["scopes"] = item.pop("_scopes")
        print(json.dumps(campaigns, indent=2))
    elif args.command == "build":
        if not Path("/.dockerenv").exists():
            raise SystemExit("Run rename diagnostic inside the Docker orchestrator")
        build()
    elif args.command == "rename":
        if not Path("/.dockerenv").exists():
            raise SystemExit("Run rename diagnostic inside the Docker orchestrator")
        run(args.binary, args.address, args.new_name,
            model=args.model, model_role=args.model_role, timeout=args.timeout)
    elif args.command == "list-models":
        print(json.dumps(resolved_table(), indent=2))
        print(f"roles: {', '.join(available_roles())}")
    else:
        if not Path("/.dockerenv").exists():
            raise SystemExit("Run rename diagnostic inside the Docker orchestrator")
        assignments = json.loads(args.assignments.read_text())
        dispatch_many(assignments, args.max_workers)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
