"""A matching original output disproves an explicit two-input mapping claim."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine.validation.scalar_cases import matching_scalar_cases, scalar_counterexamples

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
assert matching_scalar_cases(
    "Returns 131075 when input equals 0.",
    [{"case_id": "zero", "input": {"args": [0]},
      "observed": {"return": 131075}}]
)[0]["agreement"]
assert matching_scalar_cases(
    "Returns 0 for all inputs less than 32768 except zero",
    [{"case_id": "one", "input": {"args": [1]},
      "observed": {"return": 0}}]
)[0]["agreement"]
assert matching_scalar_cases(
    "When the second parameter is nonzero, the function returns the first "
    "parameter bitwise OR'd with 16777216 (16777216)",
    [{"case_id": "bit", "input": {"args": [3, True]},
      "observed": {"return": 16777219}}]
)[0]["agreement"]
assert matching_scalar_cases(
    "When the boolean parameter is nonzero, the function returns the Grammar "
    "parameter with bit 25 set",
    [{"case_id": "one-based-bit", "input": {"args": [0, True]},
      "observed": {"return": 16777216}}]
)[0]["agreement"]
assert scalar_counterexamples(
    "Returns 1 when the input, after clearing bits 16 and 17 "
    "(mask 4294836223), equals 65539",
    [{"case_id": "wrong-mask", "input": {"args": [65539]},
      "observed": {"return": 0}}]
) == ["wrong-mask"]
assert matching_scalar_cases(
    "Returns 1 when the input minus 16842752 (16842752) results in a value "
    "between 0 and 1 inclusive",
    [{"case_id": "range-end", "input": {"args": [16842753]},
      "observed": {"return": 1}}]
)[0]["agreement"]
print("scalar case checks passed")
