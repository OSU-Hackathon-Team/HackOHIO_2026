"""Check campaign import serialization and recovery after a partial import."""

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402


class FakeAnalysis(GhidraAnalysis):
    imports = 0
    indexes = 0
    fail_next_import = False
    recovered_partial = False
    guard = threading.Lock()

    def _run(self, args: list[str], campaign: str, stage: str) -> None:
        shared = type(self)
        project = Path(args[0]) / "baseline.gpr"
        repository = Path(args[0]) / "baseline.rep"
        if stage == "import":
            with shared.guard:
                shared.imports += 1
                if shared.imports > 1:
                    shared.recovered_partial = not project.exists() and not repository.exists()
                failing = shared.fail_next_import
                shared.fail_next_import = False
            project.write_text("partial" if failing else "complete")
            repository.mkdir()
            time.sleep(0.1)
            if failing:
                raise RuntimeError("simulated interrupted import")
        elif stage == "index":
            with shared.guard:
                shared.indexes += 1
            Path(args[-2]).write_text(json.dumps({"status": "ok", "functions": [],
                                                 "static_inventory": {}}))
        else:
            raise AssertionError(stage)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="decomp-import-cache-") as scratch:
        root = Path(scratch)
        headless = root / "headless"
        headless.write_text("fake Ghidra version")
        binary = root / "fixture.bin"
        binary.write_bytes(b"fixture program")
        state = Path(os.path.relpath(root / "concurrent", Path.cwd()))
        barrier = threading.Barrier(6)

        def analyze(_: int) -> dict:
            barrier.wait()
            return FakeAnalysis(state, headless, warm_workers=0).analyze(binary)

        with ThreadPoolExecutor(max_workers=6) as pool:
            manifests = list(pool.map(analyze, range(6)))
        assert all(manifest == manifests[0] for manifest in manifests)
        assert Path(manifests[0]["project"]).is_absolute()
        assert Path(FakeAnalysis(state, headless, warm_workers=0)
                    ._environment()["GHIDRA_USER_DIR"]).is_absolute()
        assert FakeAnalysis.imports == 1, FakeAnalysis.imports
        assert FakeAnalysis.indexes == 1, FakeAnalysis.indexes
        assert (Path(manifests[0]["project"]) / "import.done").exists()

        FakeAnalysis.imports = 0
        FakeAnalysis.indexes = 0
        FakeAnalysis.fail_next_import = True
        retry_state = root / "retry"
        retry = FakeAnalysis(retry_state, headless, warm_workers=0)
        try:
            retry.analyze(binary)
        except RuntimeError as error:
            assert "interrupted import" in str(error)
        else:
            raise AssertionError("partial import unexpectedly succeeded")
        recovered = retry.analyze(binary)
        assert recovered["function_count"] == 0
        assert FakeAnalysis.imports == 2 and FakeAnalysis.indexes == 1
        assert FakeAnalysis.recovered_partial
        assert (Path(recovered["project"]) / "import.done").exists()
        print("Campaign import cache: one concurrent import; partial import rebuilt")


if __name__ == "__main__":
    main()
