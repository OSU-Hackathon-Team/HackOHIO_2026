"""Exercise parallel warm Ghidra contexts and restart after a worker dies."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import signal
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402


def main() -> None:
    fixture_manifest = ROOT / "decomp-state" / "fixtures" / "manifest.json"
    if not fixture_manifest.exists():
        raise SystemExit("Run python scripts/build_decomp_fixtures.py first")
    builds = json.loads(fixture_manifest.read_text())["builds"]
    binary = next(Path(build["analysis_path"]) for build in builds
                  if build["kind"] == "executable" and build["optimization"] == "O2")
    with tempfile.TemporaryDirectory(prefix="decomp-warm-", dir=ROOT / "decomp-state") as scratch:
        engine = GhidraAnalysis(Path(scratch), Path("/opt/ghidra/support/analyzeHeadless"),
                                warm_workers=2)
        try:
            manifest = engine.analyze(binary)
            entries = [item["entry"] for item in engine.index(manifest)["functions"]
                       if not item["external"] and not item["thunk"]][:5]
            assert len(entries) == 5
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = list(pool.map(lambda address: engine.function(manifest, address), entries[:2]))
            assert all(item["status"] == "ok" for item in first), first
            assert len(engine.warm.workers) == 2
            original_pids = {worker.process.pid for worker in engine.warm.workers.values()}
            third = engine.function(manifest, entries[2])
            assert third["status"] == "ok"
            assert {worker.process.pid for worker in engine.warm.workers.values()} == original_pids
            assert engine.function(manifest, entries[0]) == first[0]

            victim = next(iter(engine.warm.workers.values()))
            os.killpg(victim.process.pid, signal.SIGKILL)
            victim.process.wait()
            with ThreadPoolExecutor(max_workers=2) as pool:
                recovered = list(pool.map(lambda address: engine.function(manifest, address),
                                          entries[3:5]))
            assert all(item["status"] == "ok" for item in recovered), recovered
            assert len(engine.warm.workers) == 2
            assert len({worker.process.pid for worker in engine.warm.workers.values()}
                       - original_pids) == 1
            events = [json.loads(line) for line in
                      (Path(scratch) / "progress.jsonl").read_text().splitlines()]
            assert sum(event["stage"] == "warm_function_finished" for event in events) == 5
            assert sum(event["stage"] == "warm_worker_started" for event in events) == 3
            print("Warm Ghidra pool: two contexts, five exports, one worker restart")
        except Exception:
            for worker in engine.warm.workers.values():
                if worker.log_path.exists():
                    print(worker.log_path.read_text()[-3000:], file=sys.stderr)
            raise
        finally:
            engine.close()


if __name__ == "__main__":
    main()
