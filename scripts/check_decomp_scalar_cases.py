"""A matching original output disproves an explicit two-input mapping claim."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.validation.scalar_cases import scalar_counterexamples

cases = [{"case_id": "original-a", "input": {"args": [False, False]},
          "observed": {"return": 131075}},
         {"case_id": "original-b", "input": {"args": [True, False]},
          "observed": {"return": 16908294}}]
assert scalar_counterexamples(
    "Returns 16908294 when both input 1 and input 2 are false.", cases
) == ["original-a"]
assert scalar_counterexamples(
    "Returns 16908294 when input 1 is true and input 2 is false.", cases
) == []
assert scalar_counterexamples("Returns a configured grammar.", cases) == []
print("scalar case checks passed")
