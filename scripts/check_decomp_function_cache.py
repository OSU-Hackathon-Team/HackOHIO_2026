"""Check concurrent cold function exports share one immutable cache pointer."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402


class FakeAnalysis(GhidraAnalysis):
    calls: dict[str, int] = {}
    active = 0
    max_active = 0
    guard = threading.Lock()
    export_barrier = threading.Barrier(2)

    def _run(self, args: list[str], campaign: str, stage: str) -> None:
        address = args[-1]
        shared = type(self)
        with shared.guard:
            shared.calls[address] = shared.calls.get(address, 0) + 1
            shared.active += 1
            shared.max_active = max(shared.max_active, shared.active)
        try:
            shared.export_barrier.wait(timeout=5)
            time.sleep(0.05)
            Path(args[-3]).write_text(json.dumps({"entry": address, "status": "ok"}))
        finally:
            with shared.guard:
                shared.active -= 1


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="decomp-function-cache-") as scratch:
        root = Path(scratch)
        engine = FakeAnalysis(root, Path("/unused/headless"), warm_workers=0)
        addresses = ["00401000", "00402000"]
        index_artifact = engine.store.put(json.dumps({
            "functions": [{"entry": address} for address in addresses]
        }).encode())
        manifest = {"campaign": "concurrent", "project": str(root / "project"),
                    "program_name": "fixture", "index_artifact": index_artifact}
        Path(manifest["project"]).mkdir()
        barrier = threading.Barrier(8)

        def request(number: int) -> dict:
            barrier.wait()
            caller = FakeAnalysis(root, Path("/unused/headless"), warm_workers=0)
            return caller.function(manifest, addresses[number % 2])

        with ThreadPoolExecutor(max_workers=8) as workers:
            results = list(workers.map(request, range(8)))
        assert [item["entry"] for item in results] == addresses * 4
        assert FakeAnalysis.calls == {address: 1 for address in addresses}, FakeAnalysis.calls
        assert FakeAnalysis.max_active == 2, FakeAnalysis.max_active
        for address in addresses:
            pointer = root / "project" / "functions" / (address + ".json")
            artifact = json.loads(pointer.read_text())["artifact"]
            assert json.loads(engine.store.get(artifact))["entry"] == address
        events = [json.loads(line) for line in (root / "progress.jsonl").read_text().splitlines()]
        assert sum(event["stage"] == "function_exported" for event in events) == 2
        assert sum(event["stage"] == "function_cache_hit" for event in events) == 6
        print("Concurrent function cache: two exports, six cache hits")


if __name__ == "__main__":
    main()
