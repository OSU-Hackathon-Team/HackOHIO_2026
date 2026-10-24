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
import threading
import uuid
from pathlib import Path

from model_config import available_roles, get_model, resolved_table
from engine.analysis.ghidra import GhidraAnalysis
from engine.models import ScopeRequest
from engine.scope import persist_scope
from engine.worker import SemanticWorker
from engine.validation.review import IndependentReviewer
from engine.validation.probes import NativeProbeRunner
from engine.dossier import persist_dossier
from engine.specification import persist_spec

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
    work.add_argument("--prior-artifact", help="reassess a matching rejected or partial draft")
    work.add_argument("--timeout", type=int, default=180)
    work.add_argument("--opencode", type=Path,
                      default=Path(os.environ.get("OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
    review = sub.add_parser("review", help="independently challenge an unreviewed semantic draft")
    review.add_argument("--draft-artifact", required=True)
    review.add_argument("--state", type=Path, default=ENGINE_STATE)
    review.add_argument("--model-role", default="legal_verification")
    review.add_argument("--model", default=None)
    review.add_argument("--timeout", type=int, default=180)
    review.add_argument("--opencode", type=Path,
                        default=Path(os.environ.get("OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
    probe = sub.add_parser("probe", help="run held-out cases against original native targets")
    probe.add_argument("--fixtures-manifest", type=Path, required=True)
    probe.add_argument("--suite", type=Path, required=True)
    probe.add_argument("--adapter", type=Path, default=ROOT / "scripts" / "native_probe_adapter.py")
    probe.add_argument("--state", type=Path, default=ENGINE_STATE)
    dossier = sub.add_parser("dossier", help="assemble a versioned subsystem dossier")
    dossier.add_argument("--manifest", type=Path, required=True)
    dossier.add_argument("--scope-artifact", required=True)
    dossier.add_argument("--inputs", type=Path, required=True,
                         help="JSON arrays: draft_artifacts, review_artifacts, probe_report_artifacts")
    dossier.add_argument("--state", type=Path, default=ENGINE_STATE)
    dossier.add_argument("--dsn", default=os.environ.get("DECOMP_DATABASE_URL"),
                         help="PostgreSQL DSN for a current helper-contract snapshot")
    specification = sub.add_parser("spec", help="generate a native spec from an immutable dossier")
    specification.add_argument("--dossier-artifact", required=True)
    specification.add_argument("--state", type=Path, default=ENGINE_STATE)
    status = sub.add_parser("status", help="show persisted decomp campaign progress")
    status.add_argument("--state", type=Path, default=ENGINE_STATE)
    status.add_argument("--campaign", help="limit output to one campaign hash")
    for name, help_text in (
        ("queue-init", "migrate PostgreSQL and register a native campaign"),
        ("queue-enqueue", "enqueue all deduplicated tasks from a scope revision"),
        ("queue-status", "show durable task states, capacity, and event cursor"),
        ("queue-metrics", "show attempt throughput, timing, and recorded model usage"),
        ("queue-run-one", "lease and run one semantic task with heartbeats"),
        ("queue-drain", "run bounded parallel semantic workers until idle"),
        ("queue-review", "independently review one validated queue task"),
        ("queue-review-fixed-memory", "review simple fixed-address x86 stores deterministically"),
        ("queue-review-drain", "review validated tasks with bounded durable leases"),
        ("queue-review-dependency", "review one caller dependency against a helper contract"),
        ("queue-adjudicate-gaps", "check review omissions against raw and original evidence"),
        ("queue-resolve-dependencies", "accept a caller after all dependency reviews"),
        ("queue-reassess", "requeue one partial task with its prior draft"),
        ("queue-normalize-partial", "revalidate a partial draft after safe shape normalization"),
        ("queue-reclassify-intrinsic", "move no-call state dependencies into visible unknowns"),
        ("queue-repair-dependency-citations", "rebind helper citations to raw direct calls"),
        ("queue-complete-direct-calls", "bind uncovered calls to reviewed helper contracts"),
        ("queue-reopen-review", "recheck one unresolved draft against updated review criteria"),
        ("queue-revise-semantics", "rerun a contradicted or incomplete draft with review context"),
        ("queue-expand-coverage", "add cited claims for independently identified omissions"),
        ("queue-task", "inspect a durable native task and its blocker"),
        ("queue-events", "read ordered transactional campaign events"),
        ("queue-findings", "inspect published claim and contract versions"),
        ("queue-publish-claims", "publish reviewed claims with explicit semantic slots"),
        ("queue-publish-contract", "version a published supported claim as a contract"),
    ):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--state", type=Path, default=ENGINE_STATE)
        command.add_argument("--dsn", default=os.environ.get("DECOMP_DATABASE_URL"),
                             help="PostgreSQL DSN; defaults to DECOMP_DATABASE_URL")
        if name in {"queue-init", "queue-run-one", "queue-drain"}:
            command.add_argument("--manifest", type=Path, required=True)
        if name == "queue-enqueue":
            command.add_argument("--scope-artifact", required=True)
        if name in {"queue-status", "queue-metrics", "queue-review-drain"}:
            command.add_argument("--campaign", required=True)
        if name == "queue-metrics":
            command.add_argument("--worker-prefix",
                                 help="limit the report to matching worker IDs")
            command.add_argument("--after-event-id", type=int,
                                 help="include attempts leased after this event cursor")
        if name in {"queue-review", "queue-review-dependency", "queue-adjudicate-gaps",
                    "queue-review-drain",
                    "queue-expand-coverage"}:
            if name != "queue-review-drain":
                command.add_argument("--task-id", required=True)
            command.add_argument("--timeout", type=int, default=180)
            command.add_argument("--model-role", default="decomp_worker"
                                 if name == "queue-expand-coverage" else
                                 "legal_verification")
            command.add_argument("--model")
            command.add_argument("--opencode", type=Path,
                                 default=Path(os.environ.get(
                                     "OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
        if name == "queue-review-drain":
            command.add_argument("--worker-prefix", default="decomp-reviewer")
            command.add_argument("--workers", type=int, default=2)
            command.add_argument("--max-tasks", type=int)
            command.add_argument("--lease-seconds", type=int, default=60)
        if name == "queue-review-dependency":
            command.add_argument("--dependency-index", type=int, required=True)
        if name == "queue-adjudicate-gaps":
            command.add_argument("--probe-report-artifact", required=True)
        if name == "queue-resolve-dependencies":
            command.add_argument("--task-id", required=True)
            command.add_argument("--reviews", type=Path, required=True,
                                 help="JSON array of dependency review artifact IDs")
        if name == "queue-reassess":
            command.add_argument("--task-id", required=True)
            command.add_argument("--reason", required=True)
        if name == "queue-reopen-review":
            command.add_argument("--task-id", required=True)
            command.add_argument("--reason", required=True)
        if name == "queue-revise-semantics":
            command.add_argument("--task-id", required=True)
            command.add_argument("--reason", required=True)
            command.add_argument("--probe-report-artifact",
                                 help="immutable original-execution report for revision context")
        if name in {"queue-normalize-partial", "queue-reclassify-intrinsic",
                    "queue-repair-dependency-citations", "queue-complete-direct-calls"}:
            command.add_argument("--task-id", required=True)
        if name in {"queue-task", "queue-review-fixed-memory", "queue-publish-claims",
                    "queue-publish-contract"}:
            command.add_argument("--task-id", required=True)
        if name in {"queue-events", "queue-findings"}:
            command.add_argument("--campaign", required=True)
        if name == "queue-events":
            command.add_argument("--after-id", type=int, default=0)
            command.add_argument("--limit", type=int, default=100)
        if name == "queue-publish-claims":
            command.add_argument("--slots", type=Path, required=True,
                                 help="JSON mapping of claim index to explicit semantic slot")
            command.add_argument("--dependency-versions", type=Path,
                                 help="JSON mapping of contract key to pinned version")
        if name == "queue-publish-contract":
            claims = command.add_mutually_exclusive_group(required=True)
            claims.add_argument("--claim-index", type=int)
            claims.add_argument("--claim-indices",
                                help="comma-separated reviewed claim indices")
            command.add_argument("--contract-key", required=True)
            command.add_argument("--expected-version", type=int, required=True)
        if name == "queue-run-one":
            command.add_argument("--worker-id", required=True)
            command.add_argument("--lease-seconds", type=int, default=60)
            command.add_argument("--timeout", type=int, default=180)
            command.add_argument("--model-role", default="decomp_worker")
            command.add_argument("--model")
            command.add_argument("--opencode", type=Path,
                                 default=Path(os.environ.get(
                                     "OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
        if name == "queue-drain":
            command.add_argument("--worker-prefix", default="decomp-worker")
            command.add_argument("--workers", type=int, default=4)
            command.add_argument("--max-tasks", type=int)
            command.add_argument("--lease-seconds", type=int, default=60)
            command.add_argument("--timeout", type=int, default=180)
            command.add_argument("--model-role", default="decomp_worker")
            command.add_argument("--model")
            command.add_argument("--opencode", type=Path,
                                 default=Path(os.environ.get(
                                     "OPENCODE_BIN", "/home/mitch/.opencode/bin/opencode")))
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
                            model=args.model, model_role=args.model_role,
                            prior_artifact=args.prior_artifact)
        print(json.dumps(result, indent=2))
        if result["state"] in {"failed", "rejected"}:
            raise SystemExit(1)
    elif args.command == "review":
        engine = GhidraAnalysis(args.state, Path(os.environ.get(
            "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
        reviewer = IndependentReviewer(engine, args.opencode, timeout=args.timeout)
        result = reviewer.run(args.draft_artifact, model=args.model,
                              model_role=args.model_role)
        print(json.dumps(result, indent=2))
        if result["state"] in {"failed", "rejected"}:
            raise SystemExit(1)
    elif args.command == "probe":
        engine = GhidraAnalysis(args.state, Path(os.environ.get(
            "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
        runner = NativeProbeRunner(engine, args.adapter)
        report = runner.run_suite(args.fixtures_manifest, args.suite)
        print(json.dumps(report, indent=2))
        if not report["complete"]:
            raise SystemExit(1)
    elif args.command == "dossier":
        engine = GhidraAnalysis(args.state, Path(os.environ.get(
            "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
        manifest = json.loads(args.manifest.read_text())
        inputs = json.loads(args.inputs.read_text())
        contract_snapshot = None
        if args.dsn:
            from engine.artifacts import LocalArtifactStore
            from engine.queue import DurableQueue

            contract_snapshot = DurableQueue(
                args.dsn, LocalArtifactStore(args.state / "artifacts")
            ).contract_snapshot(manifest["campaign"])
        result = persist_dossier(engine, manifest, args.scope_artifact,
                                 inputs.get("draft_artifacts", []),
                                 inputs.get("review_artifacts", []),
                                 inputs.get("probe_report_artifacts", []),
                                 inputs.get("probe_link_artifacts", []),
                                 inputs.get("dependency_resolution_artifacts", []),
                                 contract_snapshot,
                                 inputs.get("gap_adjudication_artifacts", []))
        print(json.dumps({"revision": result["revision"],
                          "artifact": result["artifact"],
                          "markdown_artifact": result["markdown_artifact"],
                          "markdown_path": str(args.state / "dossiers" /
                                               result["scope_id"] / "latest.md"),
                          "readiness": result["readiness"],
                          "coverage": result["coverage"],
                          "blockers": result["blockers"]}, indent=2))
    elif args.command == "spec":
        print(json.dumps(persist_spec(args.state, args.dossier_artifact), indent=2))
    elif args.command.startswith("queue-"):
        from engine.artifacts import LocalArtifactStore
        from engine.queue import DurableQueue
        from engine.queue_runner import run_one as run_queued_one

        if not args.dsn:
            parser.error("queue commands require --dsn or DECOMP_DATABASE_URL")
        queue = DurableQueue(args.dsn, LocalArtifactStore(args.state / "artifacts"))
        if args.command == "queue-init":
            manifest = json.loads(args.manifest.read_text())
            queue.migrate()
            queue.create_campaign(manifest["campaign"], manifest["binary_sha256"])
            revised = queue.audit_accepted_dependencies(manifest["campaign"])
            queued_reviews = queue.enqueue_pending_reviews(manifest["campaign"])
            result = {**queue.status(manifest["campaign"]),
                      "revised_legacy_acceptances": revised,
                      "queued_reviews": queued_reviews}
        elif args.command == "queue-enqueue":
            ids = queue.enqueue_scope(args.scope_artifact)
            result = {"enqueued": len(ids), "task_ids": ids}
        elif args.command == "queue-status":
            result = queue.status(args.campaign)
        elif args.command == "queue-metrics":
            result = queue.metrics(args.campaign, worker_prefix=args.worker_prefix,
                                   after_event_id=args.after_event_id)
        elif args.command == "queue-run-one":
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            manifest = json.loads(args.manifest.read_text())
            semantic = SemanticWorker(engine, args.opencode, timeout=args.timeout)
            result = run_queued_one(queue, semantic, manifest, args.worker_id,
                                    lease_seconds=args.lease_seconds,
                                    model=args.model, model_role=args.model_role)
        elif args.command == "queue-drain":
            if not 1 <= args.workers <= 32 or (args.max_tasks is not None and
                                                 args.max_tasks < 1):
                parser.error("queue-drain needs 1..32 workers and positive max-tasks")
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            manifest = json.loads(args.manifest.read_text())
            exported = engine.export_all(manifest)
            lock = threading.Lock()
            dispatched = 0

            def worker_loop(number: int) -> list[dict]:
                nonlocal dispatched
                semantic = SemanticWorker(engine, args.opencode, timeout=args.timeout)
                completed = []
                while True:
                    with lock:
                        if args.max_tasks is not None and dispatched >= args.max_tasks:
                            return completed
                        dispatched += 1
                    item = run_queued_one(queue, semantic, manifest,
                                          f"{args.worker_prefix}-{number}",
                                          lease_seconds=args.lease_seconds,
                                          model=args.model, model_role=args.model_role)
                    if item["state"] == "idle":
                        return completed
                    completed.append(item)
                    print(json.dumps({"queue_progress": item}), flush=True)

            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = [executor.submit(worker_loop, i) for i in range(args.workers)]
                completed = [item for future in futures for item in future.result()]
            result = {"workers": args.workers, "completed_attempts": len(completed),
                      "outcomes": {state: sum(item["state"] == state for item in completed)
                                   for state in sorted({item["state"] for item in completed})},
                      "exported_functions": exported["counts"],
                      "queue": queue.status(manifest["campaign"])}
        elif args.command == "queue-review":
            task = queue.task(args.task_id)
            if task is None or task["state"] != "validated":
                parser.error("queue-review requires an existing validated task")
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            reviewer = IndependentReviewer(engine, args.opencode, timeout=args.timeout)
            review_result = reviewer.run(task["result_artifact"],
                                         model=args.model, model_role=args.model_role)
            queue_state = (queue.publish_review(args.task_id, review_result["artifact"])
                           if review_result["state"] == "reviewed" else "invalid")
            result = {"task_id": args.task_id, "queue_state": queue_state,
                      "review_state": review_result["state"],
                      "review_artifact": review_result["artifact"],
                      "outcomes": review_result.get("outcomes", {})}
        elif args.command == "queue-review-fixed-memory":
            from engine.validation.fixed_memory import FixedMemoryReviewer

            task = queue.task(args.task_id)
            if task is None or task["state"] != "validated":
                parser.error("queue-review-fixed-memory requires a validated task")
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            review_result = FixedMemoryReviewer(engine).run(task["result_artifact"])
            queue_state = (queue.publish_review(args.task_id, review_result["artifact"])
                           if review_result["state"] == "reviewed" else "invalid")
            result = {"task_id": args.task_id, "queue_state": queue_state,
                      "review_state": review_result["state"],
                      "review_artifact": review_result["artifact"],
                      "outcomes": review_result["outcomes"]}
        elif args.command == "queue-review-drain":
            from engine.review_runner import run_one as run_review_one

            if not 1 <= args.workers <= 32 or (args.max_tasks is not None and
                                                 args.max_tasks < 1):
                parser.error("queue-review-drain needs 1..32 workers and positive max-tasks")
            queue.reclaim_expired_reviews()
            queued_reviews = queue.enqueue_pending_reviews(args.campaign)
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            lock = threading.Lock()
            dispatched = 0

            def review_loop(number: int) -> list[dict]:
                nonlocal dispatched
                reviewer = IndependentReviewer(engine, args.opencode, timeout=args.timeout)
                completed = []
                while True:
                    with lock:
                        if args.max_tasks is not None and dispatched >= args.max_tasks:
                            return completed
                        dispatched += 1
                    item = run_review_one(queue, reviewer, args.campaign,
                                          f"{args.worker_prefix}-{number}",
                                          lease_seconds=args.lease_seconds,
                                          model=args.model, model_role=args.model_role)
                    if item["state"] == "idle":
                        return completed
                    completed.append(item)
                    print(json.dumps({"review_progress": item}), flush=True)

            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                futures = [executor.submit(review_loop, i) for i in range(args.workers)]
                completed = [item for future in futures for item in future.result()]
            result = {"workers": args.workers, "queued_reviews": queued_reviews,
                      "completed_attempts": len(completed),
                      "outcomes": {state: sum(item["state"] == state for item in completed)
                                   for state in sorted({item["state"] for item in completed})},
                      "queue": queue.status(args.campaign)}
        elif args.command == "queue-review-dependency":
            from engine.validation.dependencies import IndependentDependencyReviewer

            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            reviewer = IndependentDependencyReviewer(engine, queue, args.opencode,
                                                     timeout=args.timeout)
            result = reviewer.run(args.task_id, args.dependency_index,
                                  model=args.model, model_role=args.model_role)
        elif args.command == "queue-adjudicate-gaps":
            from engine.validation.gaps import GapAdjudicator

            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            adjudicator = GapAdjudicator(engine, queue, args.opencode,
                                        timeout=args.timeout)
            attempt = adjudicator.run(args.task_id, args.probe_report_artifact,
                                      model=args.model, model_role=args.model_role)
            queue_state = (queue.publish_gap_adjudication(args.task_id, attempt["artifact"])
                           if attempt["state"] == "reviewed" else "invalid")
            result = {"task_id": args.task_id, "attempt_state": attempt["state"],
                      "adjudication_artifact": attempt["artifact"],
                      "queue_state": queue_state,
                      "decisions": [item["decision"] for item in
                                    attempt.get("answer", {}).get("items", [])]}
        elif args.command == "queue-resolve-dependencies":
            reviews = json.loads(args.reviews.read_text())
            if not isinstance(reviews, list) or not all(isinstance(x, str) for x in reviews):
                parser.error("--reviews must contain a JSON array of artifact IDs")
            state = queue.resolve_dependencies(args.task_id, reviews)
            result = {"state": state, "task": queue.task(args.task_id)}
        elif args.command == "queue-reassess":
            requeued = queue.reassess(args.task_id, args.reason)
            result = {"task_id": args.task_id, "requeued": requeued,
                      "task": queue.task(args.task_id)}
        elif args.command == "queue-normalize-partial":
            result = queue.normalize_partial(args.task_id)
        elif args.command == "queue-reclassify-intrinsic":
            result = queue.reclassify_intrinsic_dependencies(args.task_id)
        elif args.command == "queue-repair-dependency-citations":
            result = queue.repair_dependency_citations(args.task_id)
        elif args.command == "queue-complete-direct-calls":
            result = queue.complete_direct_call_dependencies(args.task_id)
        elif args.command == "queue-reopen-review":
            reopened = queue.reopen_review(args.task_id, args.reason)
            result = {"task_id": args.task_id, "reopened": reopened,
                      "task": queue.task(args.task_id)}
        elif args.command == "queue-revise-semantics":
            result = queue.revise_semantics(args.task_id, args.reason,
                                            args.probe_report_artifact)
        elif args.command == "queue-expand-coverage":
            from engine.validation.coverage import CoverageExpander

            task = queue.task(args.task_id)
            if task is None or task["state"] != "needs_reconciliation":
                parser.error("coverage expansion requires an unresolved reviewed task")
            engine = GhidraAnalysis(args.state, Path(os.environ.get(
                "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
            expander = CoverageExpander(engine, args.opencode, timeout=args.timeout)
            attempt = expander.run(task["result_artifact"], task["review_artifact"],
                                   model=args.model, model_role=args.model_role)
            recorded = queue.record_coverage_attempt(args.task_id, attempt["artifact"])
            queue_state = (queue.publish_coverage_candidate(
                args.task_id, attempt["candidate_artifact"])
                if attempt["candidate_artifact"] else "unchanged")
            result = {"task_id": args.task_id, "attempt_state": attempt["state"],
                      "attempt_artifact": attempt["artifact"],
                      "candidate_artifact": attempt["candidate_artifact"],
                      "structural_errors": attempt.get("structural_errors", []),
                      "recorded": recorded, "queue_state": queue_state}
        elif args.command == "queue-task":
            result = queue.task(args.task_id)
        elif args.command == "queue-events":
            result = queue.events(args.campaign, args.after_id, args.limit)
        elif args.command.startswith("queue-publish-") or args.command == "queue-findings":
            from engine.findings import FindingsStore

            findings = FindingsStore(queue)
            if args.command == "queue-findings":
                result = findings.inventory(args.campaign)
            elif args.command == "queue-publish-claims":
                slots = json.loads(args.slots.read_text())
                pins = (json.loads(args.dependency_versions.read_text())
                        if args.dependency_versions else {})
                result = findings.publish_claims(args.task_id,
                                                 {int(key): value for key, value in slots.items()},
                                                 dependency_versions=pins)
            else:
                if args.claim_indices is not None:
                    try:
                        indices = [int(value.strip()) for value in
                                   args.claim_indices.split(",")]
                    except ValueError:
                        parser.error("--claim-indices needs comma-separated integers")
                    result = findings.publish_contract_set(
                        args.task_id, indices, args.contract_key,
                        expected_version=args.expected_version)
                else:
                    result = findings.publish_contract(args.task_id, args.claim_index,
                                                       args.contract_key,
                                                       expected_version=args.expected_version)
        print(json.dumps(result, indent=2))
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
                                         "_scopes": {}, "_reviews": {}, "_probes": {}})
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
            elif event["stage"] == "review_started":
                item["_reviews"][event["review_id"]] = {"state": "running"}
            elif event["stage"] == "review_finished":
                item["_reviews"][event["review_id"]] = {
                    "state": event["status"], "outcomes": event["outcomes"]}
            elif event["stage"] == "probe_started":
                if "probe_key" in event:
                    item["_probes"].pop(event["case_id"], None)
                item["_probes"][event.get("probe_key", event["case_id"])] = "running"
            elif event["stage"] == "probe_finished":
                if "probe_key" in event:
                    item["_probes"].pop(event["case_id"], None)
                item["_probes"][event.get("probe_key", event["case_id"])] = event["outcome"]
            elif event["stage"] == "dossier_assembled":
                item.setdefault("dossiers", {})[event["scope_id"]] = {
                    "revision": event["revision"], "readiness": event["readiness"],
                    "coverage": event["coverage"], "artifact": event["artifact"]}
        for item in campaigns.values():
            item["function_exports"] = len(item.pop("_exported"))
            item["function_failures"] = len(item.pop("_failed"))
            states = list(item.pop("_semantic").values())
            item["semantic_attempts"] = len(states)
            item["semantic_states"] = {state: states.count(state) for state in sorted(set(states))}
            item["scopes"] = item.pop("_scopes")
            reviews = item.pop("_reviews")
            item["review_attempts"] = len(reviews)
            item["review_states"] = {state: sum(r["state"] == state for r in reviews.values())
                                     for state in sorted({r["state"] for r in reviews.values()})}
            probes = list(item.pop("_probes").values())
            item["probe_cases"] = len(probes)
            item["probe_outcomes"] = {outcome: probes.count(outcome)
                                      for outcome in sorted(set(probes))}
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
