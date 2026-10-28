import unittest

from scripts.lo_public_oracle import record_public


class PublicOracleTests(unittest.TestCase):
    def test_only_public_cases_reach_driver_and_unexpected_output_remains_an_observation(self):
        seen = []

        class Driver:
            ready = {"version": "Fixture Calc"}

            def evaluate(self, case, *, diagnostics=False):
                seen.append((case["id"], diagnostics))
                return {"observed": {"value": 99}}

        suite = {"cases": [
            {"id": "visible", "formula": "=1+1", "expected": {"value": 2}, "held_out": False},
            {"id": "sealed", "formula": "=9+9", "held_out": True},
        ]}
        report = record_public("fixture", suite, Driver(), "a" * 64)
        self.assertEqual(seen, [("visible", True)])
        self.assertEqual(report["cases"][0]["input"], {"formula": "=1+1", "cells": {}})
        self.assertEqual(report["cases"][0]["outcome"], "observed")
        self.assertEqual(report["cases"][0]["observed"], {"value": 99})
        self.assertNotIn("expected", report["cases"][0])

    def test_driver_error_is_recorded_without_stopping_other_public_cases(self):
        class Driver:
            ready = {}

            def evaluate(self, case, *, diagnostics=False):
                if case["id"] == "fails":
                    raise RuntimeError("fixture failure")
                return {"observed": {"cells": [[1]]}}

        cases = [{"id": name, "formula": "=1", "held_out": False} for name in ("fails", "works")]
        report = record_public("fixture", {"cases": cases}, Driver(), "a" * 64)
        self.assertEqual([c["outcome"] for c in report["cases"]], ["execution_error", "observed"])
        self.assertEqual(report["cases"][0]["error"], "fixture failure")


if __name__ == "__main__":
    unittest.main()
