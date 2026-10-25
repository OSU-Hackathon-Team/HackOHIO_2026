"""Optional end-to-end integration tests for the native decompilation engine.

These tests are skipped by default during standard development and CI unit test runs.
To execute them in an environment with the native toolchain (Podman/Docker orchestrator,
Ghidra Headless, and OpenCode), set:
    export RUN_NATIVE_INTEGRATION=1
"""

from __future__ import annotations

import os
import shutil
import subprocess
import unittest
from pathlib import Path

import launch
import model_config

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(
    os.environ.get("RUN_NATIVE_INTEGRATION") == "1",
    "Native integration tests skipped. Set RUN_NATIVE_INTEGRATION=1 to run against containerized tools."
)
class TestNativeEngineIntegration(unittest.TestCase):
    """Integration test suite executing actual native engine tools in an equipped environment."""

    def setUp(self):
        # Verify required tool presence before running integration steps
        self.has_podman = shutil.which("podman") is not None
        self.has_docker = shutil.which("docker") is not None
        self.headless_path = Path(
            os.environ.get("GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")
        )
        self.opencode_path = Path(
            os.environ.get("OPENCODE_BIN", "/usr/local/bin/opencode")
        )

    def test_container_runtime_installed(self):
        """Verify that either Podman or Docker is installed and runnable."""
        self.assertTrue(
            self.has_podman or self.has_docker,
            "Integration environment requires either 'podman' or 'docker' in PATH."
        )
        runtime = "podman" if self.has_podman else "docker"
        res = subprocess.run([runtime, "--version"], capture_output=True, text=True, check=False)
        self.assertEqual(res.returncode, 0, f"'{runtime} --version' failed: {res.stderr}")
        self.assertTrue(len(res.stdout.strip()) > 0)

    def test_ghidra_headless_executable(self):
        """Verify that Ghidra Headless script exists and is executable."""
        self.assertTrue(
            self.headless_path.is_file(),
            f"Ghidra analyzeHeadless script not found at {self.headless_path}. Set GHIDRA_HEADLESS."
        )
        self.assertTrue(
            os.access(self.headless_path, os.X_OK),
            f"Ghidra analyzeHeadless at {self.headless_path} is not executable."
        )

    def test_opencode_executable_and_version(self):
        """Verify that OpenCode binary exists and reports version."""
        self.assertTrue(
            self.opencode_path.is_file(),
            f"OpenCode executable not found at {self.opencode_path}. Set OPENCODE_BIN."
        )
        res = subprocess.run([str(self.opencode_path), "--version"], capture_output=True, text=True, check=False)
        self.assertEqual(res.returncode, 0, f"OpenCode version check failed: {res.stderr}")

    def test_models_config_live_resolution(self):
        """Verify models.json resolves to configured providers without error."""
        table = model_config.resolved_table()
        self.assertIn("decomp_worker", table)
        self.assertIn("default", table)
        for role, model in table.items():
            self.assertTrue(isinstance(model, str) and len(model) > 0, f"Role {role} has invalid model: {model}")


if __name__ == "__main__":
    unittest.main()
