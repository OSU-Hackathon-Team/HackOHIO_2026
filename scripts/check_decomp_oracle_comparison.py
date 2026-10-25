"""Check that candidate results are compared to immutable original observations."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.analysis.ghidra import GhidraAnalysis
from engine.validation.probes import NativeProbeRunner


with TemporaryDirectory() as temporary:
    root = Path(temporary)
    original, changed = root / "original", root / "changed"
    for path, source in (
        (original, '#include <stdio.h>\nint main(int n, char **v) { '
                   'puts(n > 1 ? v[1] : "empty"); return 0; }\n'),
        (changed, '#include <stdio.h>\nint main(void) { puts("changed"); return 0; }\n'),
    ):
        subprocess.run(["cc", "-x", "c", "-o", str(path), "-"],
                       input=source, text=True, check=True)
    engine = GhidraAnalysis(root / "state", Path("/opt/ghidra/support/analyzeHeadless"),
                            warm_workers=0)
    runner = NativeProbeRunner(engine, Path(__file__))
    observation = runner.run_case(original, {"id": "echo", "kind": "executable",
                                             "args": ["from-original"]})
    assert observation["outcome"] == "observed"
    matched = runner.compare_case(original, observation)
    assert matched["outcome"] == "agreement"
    assert matched["execution_mode"] == "candidate"
    assert matched["oracle_artifact"] == observation["artifact"]
    assert runner.compare_case(changed, observation)["outcome"] == "disagreement"
    try:
        runner.compare_case(original, {**observation, "observed": {"stdout": "fake"}})
    except ValueError:
        pass
    else:
        raise AssertionError("tampered original observation was accepted")
print("oracle comparison checks passed")
