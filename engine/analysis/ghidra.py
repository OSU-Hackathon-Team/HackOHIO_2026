"""Cache Ghidra imports and export immutable evidence from an isolated project."""

from __future__ import annotations

import atexit
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

from engine.artifacts import LocalArtifactStore
from engine.analysis.warm import WarmGhidraPool

ROOT = Path(__file__).resolve().parents[2]
SCRIPT_DIR = ROOT / "engine" / "analysis" / "scripts"
SCHEMA = 1


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tool_version(headless: Path) -> str:
    # The installation's application.properties is part of the cache identity.
    properties = headless.resolve().parents[1] / "Ghidra" / "application.properties"
    return file_hash(properties) if properties.exists() else file_hash(headless)


class GhidraAnalysis:
    def __init__(self, root: Path, headless: Path, *, timeout: int = 900,
                 warm_workers: int | None = None):
        self.root = Path(root).resolve()
        self.headless = Path(headless).resolve()
        self.timeout = timeout
        self.store = LocalArtifactStore(self.root / "artifacts")
        self.root.mkdir(parents=True, exist_ok=True)
        if warm_workers is None:
            warm_workers = int(os.environ.get("DECOMP_ANALYSIS_WORKERS", "2"))
        if not 0 <= warm_workers <= 16:
            raise ValueError("warm_workers must be between 0 and 16")
        self.warm = (WarmGhidraPool(self.root, self.headless, SCRIPT_DIR,
                                    size=warm_workers, timeout=timeout,
                                    environment=self._environment, emit=self._emit)
                     if warm_workers else None)
        if self.warm is not None:
            atexit.register(self.close)

    def close(self) -> None:
        if self.warm is not None:
            self.warm.close()

    def _emit(self, campaign: str, stage: str, **details: object) -> None:
        record = {"schema": SCHEMA, "time": time.time(), "campaign": campaign,
                  "stage": stage, **details}
        with (self.root / "progress.jsonl").open("a") as stream:
            stream.write(json.dumps(record, sort_keys=True) + "\n")

    def _run(self, args: list[str], campaign: str, stage: str) -> None:
        self._emit(campaign, stage + "_started")
        started = time.monotonic()
        log = self.root / "logs" / campaign
        log.mkdir(parents=True, exist_ok=True)
        with (log / (stage + ".log")).open("w") as output:
            try:
                result = subprocess.run([str(self.headless), *args], stdout=output,
                                        stderr=subprocess.STDOUT, timeout=self.timeout,
                                        check=False, env=self._environment())
            except subprocess.TimeoutExpired:
                self._emit(campaign, stage + "_failed", error="timeout",
                           elapsed_seconds=round(time.monotonic() - started, 3))
                raise RuntimeError(f"Ghidra {stage} timed out; see {output.name}") from None
        if result.returncode:
            self._emit(campaign, stage + "_failed", exit_code=result.returncode)
            raise RuntimeError(f"Ghidra {stage} exited {result.returncode}; see {log / (stage + '.log')}")
        self._emit(campaign, stage + "_finished",
                   elapsed_seconds=round(time.monotonic() - started, 3))

    def _environment(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("JAVA_HOME", str(Path("/usr/lib/jvm/java-21-openjdk")))
        # Sandboxed hosts may have an unwritable user config directory.
        user_dir = self.root / "ghidra-user"
        user_dir.mkdir(exist_ok=True)
        env["GHIDRA_USER_DIR"] = str(user_dir)
        env["JAVA_TOOL_OPTIONS"] = (env.get("JAVA_TOOL_OPTIONS", "") +
                                    f" -Duser.home={user_dir}").strip()
        return env

    def analyze(self, binary: Path, *, force: bool = False) -> dict:
        binary = Path(binary).resolve(strict=True)
        binary_sha = file_hash(binary)
        script_sha = file_hash(SCRIPT_DIR / "ExportEvidence.java")
        identity = {"schema": SCHEMA, "binary_sha256": binary_sha,
                    "ghidra_version_sha256": tool_version(self.headless),
                    "exporter_sha256": script_sha, "analysis_options": {}}
        campaign = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        project_root = self.root / "projects" / campaign
        project_root.mkdir(parents=True, exist_ok=True)
        with (project_root / ".analysis.lock").open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                return self._analyze_locked(binary, identity, campaign, project_root, force)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _analyze_locked(self, binary: Path, identity: dict, campaign: str,
                        project_root: Path, force: bool) -> dict:
        manifest_path = project_root / "manifest.json"
        if manifest_path.exists() and not force:
            manifest = json.loads(manifest_path.read_text())
            self.store.get(manifest["index_artifact"])
            if not ((project_root / "baseline.gpr").exists() and
                    (project_root / "baseline.rep").is_dir()):
                raise RuntimeError("cached Ghidra baseline is missing; evidence remains immutable")
            self._emit(campaign, "cache_hit", binary=str(binary))
            return manifest
        if force and manifest_path.exists():
            raise ValueError("force rebuild requires a new analysis revision; existing baseline is immutable")
        project_name = "baseline"
        program_name = binary.name
        project = project_root / (project_name + ".gpr")
        repository = project_root / (project_name + ".rep")
        imported = project_root / "import.done"
        if force or not imported.exists() or not project.exists() or not repository.is_dir():
            if project.exists() or repository.exists() or imported.exists():
                self._emit(campaign, "import_recovery", forced=force)
            project.unlink(missing_ok=True)
            if repository.exists():
                shutil.rmtree(repository)
            imported.unlink(missing_ok=True)
            self._run([str(project_root), project_name, "-import", str(binary),
                       "-overwrite", "-analysisTimeoutPerFile", str(self.timeout)],
                      campaign, "import")
            if not project.exists() or not repository.is_dir():
                self._emit(campaign, "import_failed", error="incomplete project")
                raise RuntimeError("Ghidra import produced no complete project")
            temporary = imported.with_suffix(".tmp")
            temporary.write_text(json.dumps({"binary_sha256": identity["binary_sha256"]}) + "\n")
            os.replace(temporary, imported)
        with tempfile.TemporaryDirectory(dir=self.root) as scratch:
            export = Path(scratch) / "index.json"
            self._run([str(project_root), project_name, "-process", program_name,
                       "-readOnly", "-noanalysis", "-scriptPath", str(SCRIPT_DIR),
                       "-postScript", "ExportEvidence.java", str(export), "index"],
                      campaign, "index")
            if not export.exists():
                self._emit(campaign, "index_failed", error="no output")
                raise RuntimeError("Ghidra index script produced no output; see index.log")
            index = json.loads(export.read_text())
            if index.get("status") != "ok":
                self._emit(campaign, "index_failed", error="incomplete export")
                raise RuntimeError("Ghidra index exporter did not finish")
            index_sha = self.store.put(export.read_bytes())
        manifest = {**identity, "campaign": campaign, "binary": str(binary),
                    "project": str(project_root), "program_name": program_name,
                    "index_artifact": index_sha, "function_count": len(index["functions"])}
        temporary = manifest_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
        os.replace(temporary, manifest_path)
        self._emit(campaign, "indexed", functions=len(index["functions"]),
                   artifact=index_sha)
        return manifest

    def index(self, manifest: dict) -> dict:
        return json.loads(self.store.get(manifest["index_artifact"]))

    @contextmanager
    def _function_lock(self, cache_dir: Path, key: str):
        with (cache_dir / (key + ".lock")).open("a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)

    def _publish_function(self, pointer: Path, artifact: str) -> None:
        with tempfile.NamedTemporaryFile(mode="w", dir=pointer.parent, suffix=".tmp",
                                         delete=False) as output:
            output.write(json.dumps({"artifact": artifact}) + "\n")
            temporary = Path(output.name)
        try:
            os.replace(temporary, pointer)
        finally:
            temporary.unlink(missing_ok=True)

    def function(self, manifest: dict, address: str) -> dict:
        index = self.index(manifest)
        matches = [item for item in index["functions"] if item["entry"] == address]
        if len(matches) != 1:
            raise ValueError(f"function entry {address} not in index")
        cache_dir = Path(manifest["project"]) / "functions"
        cache_dir.mkdir(exist_ok=True)
        key = address.replace(":", "_")
        pointer = cache_dir / (key + ".json")
        with self._function_lock(cache_dir, key):
            if pointer.exists():
                artifact = json.loads(pointer.read_text())["artifact"]
                evidence = json.loads(self.store.get(artifact))
                self._emit(manifest["campaign"], "function_cache_hit", address=address,
                           artifact=artifact)
                return evidence
            if self.warm is not None:
                data = self.warm.export(manifest, address)
            else:
                with tempfile.TemporaryDirectory(dir=self.root) as scratch:
                    export = Path(scratch) / "function.json"
                    self._run([manifest["project"], "baseline", "-process",
                               manifest["program_name"], "-readOnly", "-noanalysis", "-scriptPath",
                               str(SCRIPT_DIR), "-postScript", "ExportEvidence.java",
                               str(export), "function", address], manifest["campaign"],
                              "function_" + key)
                    if not export.exists():
                        raise RuntimeError("Ghidra function script produced no output; see function log")
                    data = export.read_bytes()
            evidence = json.loads(data)
            if evidence.get("entry") != address:
                raise RuntimeError("Ghidra returned evidence for a different function")
            artifact = self.store.put(data)
            self._publish_function(pointer, artifact)
            self._emit(manifest["campaign"], "function_exported", address=address,
                       artifact=artifact, status=evidence["status"])
            return evidence

    def export_all(self, manifest: dict) -> dict:
        index = self.index(manifest)
        functions = index["functions"]
        cache_dir = Path(manifest["project"]) / "functions"
        cache_dir.mkdir(exist_ok=True)
        uncached = [item for item in functions if not
                    (cache_dir / (item["entry"].replace(":", "_") + ".json")).exists()]
        expected_entries = {item["entry"] for item in functions}
        bulk_error = None
        if uncached:
            with tempfile.TemporaryDirectory(dir=self.root) as scratch:
                output_dir = Path(scratch) / "bulk"
                output_dir.mkdir()
                stage = "bulk_export"
                campaign = manifest["campaign"]
                self._emit(campaign, stage + "_started", count=len(functions))
                command = [str(self.headless), manifest["project"], "baseline",
                           "-process", manifest["program_name"], "-readOnly",
                           "-noanalysis", "-scriptPath", str(SCRIPT_DIR),
                           "-postScript", "ExportEvidence.java", str(output_dir), "all"]
                log_dir = self.root / "logs" / campaign
                log_dir.mkdir(parents=True, exist_ok=True)
                started = time.monotonic()
                seen: set[Path] = set()
                with (log_dir / "bulk_export.log").open("w") as output:
                    process = subprocess.Popen(command, stdout=output,
                                               stderr=subprocess.STDOUT,
                                               env=self._environment())
                    try:
                        while True:
                            for path in sorted(output_dir.glob("[0-9]*.json")):
                                if path in seen:
                                    continue
                                seen.add(path)
                                try:
                                    evidence = json.loads(path.read_text())
                                    address = evidence["entry"]
                                    if address not in expected_entries:
                                        raise ValueError(f"unexpected function address {address}")
                                    artifact = self.store.put(path.read_bytes())
                                    pointer = cache_dir / (address.replace(":", "_") + ".json")
                                    with self._function_lock(cache_dir, address.replace(":", "_")):
                                        if not pointer.exists():
                                            self._publish_function(pointer, artifact)
                                            self._emit(campaign, "function_exported", address=address,
                                                       artifact=artifact, status=evidence["status"])
                                except Exception as error:
                                    self._emit(campaign, "function_failed", error=str(error),
                                               output=str(path))
                            if process.poll() is not None:
                                break
                            if time.monotonic() - started > max(self.timeout, len(functions) * 130):
                                process.terminate()
                                try:
                                    process.wait(timeout=5)
                                except subprocess.TimeoutExpired:
                                    process.kill()
                                    process.wait()
                                bulk_error = "bulk export timed out"
                                break
                            time.sleep(0.2)
                    finally:
                        if process.poll() is None:
                            process.terminate()
                            process.wait()
                if process.returncode and bulk_error is None:
                    bulk_error = f"Ghidra exited {process.returncode}; see {log_dir / 'bulk_export.log'}"
                if not (output_dir / "all_done.json").exists() and bulk_error is None:
                    bulk_error = "Ghidra bulk exporter did not finish; see bulk_export.log"
                self._emit(campaign, stage + ("_failed" if bulk_error else "_finished"),
                           elapsed_seconds=round(time.monotonic() - started, 3),
                           error=bulk_error)
        results = []
        for item in functions:
            address = item["entry"]
            try:
                pointer = cache_dir / (address.replace(":", "_") + ".json")
                artifact = json.loads(pointer.read_text())["artifact"]
                evidence = json.loads(self.store.get(artifact))
                results.append({"entry": address, "name": item["name"],
                                "status": evidence["status"],
                                "artifact": artifact})
            except Exception as error:
                results.append({"entry": address, "name": item["name"],
                                "status": "error", "error": bulk_error or str(error)})
                self._emit(manifest["campaign"], "function_failed", address=address,
                           error=str(error))
        counts = {status: sum(r["status"] == status for r in results)
                  for status in sorted({r["status"] for r in results})}
        inventory = {"schema": SCHEMA, "campaign": manifest["campaign"],
                     "index_artifact": manifest["index_artifact"],
                     "functions": results, "counts": counts,
                     "complete": bulk_error is None and len(results) == len(functions) and
                     all(item["status"] in {"ok", "external"} for item in results)}
        if bulk_error:
            inventory["bulk_error"] = bulk_error
        artifact = self.store.put(json.dumps(inventory, sort_keys=True).encode())
        self._emit(manifest["campaign"], "export_finished", artifact=artifact,
                   counts=counts, complete=inventory["complete"])
        return {**inventory, "artifact": artifact}
