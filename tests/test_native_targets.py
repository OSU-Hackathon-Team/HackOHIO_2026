"""Target registry and the generic command-line driver (fixtures/decomp/targets)."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))


class RegistryTests(unittest.TestCase):
    def test_registered_targets_load_with_their_case_suites(self):
        from native_pipeline import load_target
        from engine.cli_target import load_cli_cases
        from engine.libreoffice import load_cases, split_cases
        calc, units = load_target("libreoffice-calc"), load_target("gnu-units")
        self.assertEqual((calc["driver"], units["driver"]), ("uno", "cli"))
        self.assertTrue(load_cases(ROOT / calc["cases"])["cases"])
        suite = load_cli_cases(ROOT / units["cases"])
        public, held = split_cases(suite["cases"])
        self.assertGreaterEqual(len(public), 10)
        self.assertGreaterEqual(len(held), 3)

    def test_invalid_targets_are_refused(self):
        from native_pipeline import load_target
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            (folder / "cli-without-install.json").write_text(json.dumps(
                {"schema": 1, "id": "cli-without-install", "driver": "cli"}))
            with self.assertRaisesRegex(ValueError, "install recipe"):
                load_target("cli-without-install", folder)
            with self.assertRaisesRegex(ValueError, "invalid target id"):
                load_target("../secret", folder)

    def test_cli_suites_never_carry_user_supplied_expectations(self):
        from engine.cli_target import load_cli_cases
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "cases.json"
            path.write_text(json.dumps({"schema": 1, "kind": "cli", "cases": [
                {"id": "a", "args": ["1"], "expected": {"stdout": "2"}}]}))
            with self.assertRaisesRegex(ValueError, "come from running the program"):
                load_cli_cases(path)


class CliDriverTests(unittest.TestCase):
    def test_the_real_program_is_the_oracle(self):
        from engine.cli_target import CliDriver
        printf = shutil.which("printf") or "/usr/bin/printf"
        driver = CliDriver(printf)
        self.assertEqual(driver.evaluate({"id": "hi", "args": ["%s", "hi"]})["observed"],
                         {"stdout": "hi", "stderr": "", "exit_code": 0})
        failed = CliDriver(shutil.which("false") or "/bin/false").evaluate({"id": "f", "args": []})
        self.assertEqual(failed["observed"]["exit_code"], 1)

    def test_matching_ignores_edge_whitespace_and_float_noise_but_not_exit_codes(self):
        from engine.cli_target import cli_matches
        observed = {"stdout": "\t1.609344\n", "stderr": "", "exit_code": 0}
        self.assertTrue(cli_matches({"stdout": "1.609344"}, observed))
        self.assertTrue(cli_matches({"stdout": "1.6093440000000001", "exit_code": 0}, observed))
        self.assertFalse(cli_matches({"stdout": "1.609"}, observed))
        self.assertFalse(cli_matches({"stdout": "1.609344", "exit_code": 1}, observed))
        self.assertFalse(cli_matches({"value": 1.609344}, observed))
        self.assertFalse(cli_matches({"stdout": "x", "stderr": "warning"}, {"stdout": "x", "stderr": "", "exit_code": 0}))

    def test_install_describes_the_binary_and_installs_only_when_missing(self):
        from engine.cli_target import ensure_cli_install
        calls = []

        def run(command, **_kwargs):
            calls.append(command[0])
            return SimpleNamespace(stdout="2.23-1\n")
        binary = shutil.which("printf") or "/usr/bin/printf"
        target = {"library": "printf", "install": {"apt": "coreutils", "binary": binary}}
        with patch("engine.cli_target.fetch_debug_file", return_value=None):
            install = ensure_cli_install(target, run=run)
        self.assertEqual(calls, ["dpkg-query"])
        self.assertEqual(install["version"], "2.23-1")
        self.assertEqual(install["libraries"]["printf"]["path"], binary)
        with self.assertRaisesRegex(ValueError, "invalid package"):
            ensure_cli_install({"library": "x", "install": {"apt": "x; rm -rf /", "binary": binary}}, run=run)


class SpawnTracingTests(unittest.TestCase):
    def test_each_case_is_spawned_with_its_arguments_and_hits_are_mapped(self):
        from engine.analysis.rea import FRIDA_HOOK_TEMPLATE, spawn_triage
        self.assertIn('for (const name of ["exit", "_exit"])', FRIDA_HOOK_TEMPLATE)
        calls = []

        class Session:
            def call(self, tool, arguments, timeout=None):
                calls.append((tool, arguments))
                return {"messages": [{"payload": json.dumps({"type": "ready", "names": {"0x10": "convert"}})},
                                     {"payload": json.dumps({"type": "hits", "seq": 1, "hits": {"0x10": 2}})}]}
        result = spawn_triage(Session(), [{"id": "mile_km", "args": ["-t", "1 mile", "km"]}],
                              program="/usr/bin/units", argv_for=lambda c: c["args"], module="units",
                              patterns=["*"], image_base=0x100000, offsets={"0x10": "convert"})
        tool, arguments = calls[0]
        self.assertEqual(tool, "instrument_with_frida")
        self.assertEqual((arguments["mode"], arguments["argv"]), ("spawn", ["/usr/bin/units", "-t", "1 mile", "km"]))
        self.assertEqual(result["cases"]["mile_km"]["hits"],
                         [{"offset": "0x10", "entry": "00100010", "name": "convert", "count": 2}])


class GenericProbeTests(unittest.TestCase):
    def test_cases_without_expectations_record_the_observed_result_as_oracle(self):
        from engine.artifacts import LocalArtifactStore
        from engine.cli_target import cli_case_input, cli_display, cli_matches
        from engine.libreoffice import probe_report
        from engine.lo_pipeline import build_handoff
        with tempfile.TemporaryDirectory() as temp:
            store = LocalArtifactStore(Path(temp))
            case = {"id": "mile_km", "args": ["-t", "1 mile", "km"], "input_description": "Miles"}
            observed = {"mile_km": {"observed": {"stdout": "1.609344\n", "stderr": "", "exit_code": 0}}}
            report = probe_report(store, [case], observed, binary_sha256="b" * 64, lo_version="2.23",
                                  targets={}, kind="cli", case_input=cli_case_input,
                                  adapter=ROOT / "engine" / "cli_target.py", match=cli_matches, driver="cli")
        result = report["results"][0]
        self.assertEqual((result["outcome"], result["expected"], result["input"]),
                         ("observed", None, {"args": ["-t", "1 mile", "km"]}))
        self.assertTrue(report["complete"])
        handoff = build_handoff(SimpleNamespace(get=None), [], {"included": []}, [case], observed,
                                case_input=cli_case_input, case_display=lambda c: cli_display("/usr/bin/units", c))
        self.assertEqual(handoff["observed_cases"][0]["formula"], "units -t '1 mile' km")
        self.assertEqual(handoff["observed_cases"][0]["input"], {"args": ["-t", "1 mile", "km"]})


if __name__ == "__main__":
    unittest.main()
