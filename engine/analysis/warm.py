"""Bounded, restartable read-only Ghidra contexts for targeted exports."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from queue import Empty, Queue
import shutil
import signal
import subprocess
import tempfile
import time
from typing import Callable, TextIO


@dataclass
class _Worker:
    campaign: str
    process: subprocess.Popen
    directory: tempfile.TemporaryDirectory
    log: TextIO
    log_path: Path


class WarmGhidraPool:
    def __init__(self, root: Path, headless: Path, script_dir: Path, *, size: int,
                 timeout: int, environment: Callable[[], dict[str, str]],
                 emit: Callable[..., None]):
        if size < 1:
            raise ValueError("warm pool size must be positive")
        self.root = root
        self.headless = headless
        self.script_dir = script_dir
        self.timeout = timeout
        self.environment = environment
        self.emit = emit
        self.available: Queue[int] = Queue(maxsize=size)
        for slot in range(size):
            self.available.put(slot)
        self.workers: dict[int, _Worker] = {}

    def _stop(self, slot: int) -> None:
        worker = self.workers.pop(slot, None)
        if worker is None:
            return
        if worker.process.poll() is None:
            (Path(worker.directory.name) / "requests" / "stop").touch()
            try:
                worker.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(worker.process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    worker.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(worker.process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    worker.process.wait()
        worker.log.close()
        worker.directory.cleanup()
        self.emit(worker.campaign, "warm_worker_stopped", slot=slot)

    def close(self) -> None:
        for slot in list(self.workers):
            self._stop(slot)

    def _start(self, slot: int, manifest: dict) -> _Worker:
        campaign = manifest["campaign"]
        started = time.monotonic()
        scratch = tempfile.TemporaryDirectory(prefix="ghidra-warm-", dir=self.root)
        directory = Path(scratch.name)
        snapshot = directory / "project"
        snapshot.mkdir()
        baseline = Path(manifest["project"])
        shutil.copy2(baseline / "baseline.gpr", snapshot / "baseline.gpr")
        shutil.copytree(baseline / "baseline.rep", snapshot / "baseline.rep")
        requests = directory / "requests"
        requests.mkdir()
        logs = self.root / "logs" / campaign
        logs.mkdir(parents=True, exist_ok=True)
        output = tempfile.NamedTemporaryFile(mode="w", prefix=f"warm-{slot}-", suffix=".log",
                                             dir=logs, delete=False)
        command = [str(self.headless), str(snapshot), "baseline", "-process",
                   manifest["program_name"], "-readOnly", "-noanalysis", "-scriptPath",
                   str(self.script_dir), "-postScript", "ExportEvidence.java",
                   str(requests), "serve"]
        try:
            process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT,
                                       env=self.environment(), start_new_session=True)
        except Exception:
            output.close()
            scratch.cleanup()
            raise
        worker = _Worker(campaign, process, scratch, output, Path(output.name))
        self.workers[slot] = worker
        self.emit(campaign, "warm_worker_started", slot=slot, pid=process.pid)
        deadline = time.monotonic() + min(self.timeout, 120)
        while not (requests / "ready.json").exists():
            if process.poll() is not None:
                raise RuntimeError(f"Ghidra warm worker exited {process.returncode}; see {worker.log_path}")
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Ghidra warm worker startup timed out; see {worker.log_path}")
            time.sleep(0.05)
        self.emit(campaign, "warm_worker_ready", slot=slot, pid=process.pid,
                  elapsed_seconds=round(time.monotonic() - started, 3))
        return worker

    def export(self, manifest: dict, address: str) -> bytes:
        campaign = manifest["campaign"]
        started = time.monotonic()
        try:
            slot = self.available.get(timeout=self.timeout)
        except Empty:
            self.emit(campaign, "warm_pool_timeout", address=address)
            raise TimeoutError(f"no Ghidra warm worker available for {address}") from None
        waited = round(time.monotonic() - started, 3)
        try:
            worker = self.workers.get(slot)
            if worker is None or worker.campaign != campaign or worker.process.poll() is not None:
                self._stop(slot)
                worker = self._start(slot, manifest)
            directory = Path(worker.directory.name) / "requests"
            request = directory / "request.json"
            response = directory / "response.json"
            if request.exists() or response.exists():
                raise RuntimeError("Ghidra warm worker has an unfinished request")
            temporary = directory / "request.tmp"
            temporary.write_text(json.dumps({"entry": address}))
            os.replace(temporary, request)
            self.emit(campaign, "warm_function_started", address=address, slot=slot,
                      wait_seconds=waited)
            deadline = time.monotonic() + self.timeout
            while not response.exists():
                if worker.process.poll() is not None:
                    raise RuntimeError(f"Ghidra warm worker exited {worker.process.returncode}; "
                                       f"see {worker.log_path}")
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Ghidra function {address} timed out; see {worker.log_path}")
                time.sleep(0.05)
            data = response.read_bytes()
            response.unlink()
            evidence = json.loads(data)
            if evidence.get("entry") != address:
                raise RuntimeError("Ghidra warm worker returned a different function")
            self.emit(campaign, "warm_function_finished", address=address, slot=slot,
                      elapsed_seconds=round(time.monotonic() - started, 3))
            return data
        except Exception as error:
            self.emit(campaign, "warm_function_failed", address=address, slot=slot,
                      error=str(error))
            self._stop(slot)
            raise
        finally:
            self.available.put(slot)
