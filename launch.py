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

ROOT = Path(__file__).resolve().parent
RUNS = ROOT / "runs"
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
    if not Path("/.dockerenv").exists():
        raise SystemExit("Run this launcher inside the Docker orchestrator: docker compose run --build --rm orchestrator ...")
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
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
    if args.command == "build":
        build()
    elif args.command == "rename":
        run(args.binary, args.address, args.new_name,
            model=args.model, model_role=args.model_role, timeout=args.timeout)
    elif args.command == "list-models":
        print(json.dumps(resolved_table(), indent=2))
        print(f"roles: {', '.join(available_roles())}")
    else:
        assignments = json.loads(args.assignments.read_text())
        dispatch_many(assignments, args.max_workers)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError,
            subprocess.TimeoutExpired) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
