"""Deterministic unit tests for the native decompilation engine orchestrator and worker.

Covers configuration resolution, argument validation, container guards,
secret sanitization, error boundaries, and tool boundaries using mocks.
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import agent_worker
import launch
import model_config
from engine.queue import DurableQueue


class TestModelConfig(unittest.TestCase):
    """Test model routing and precedence rules in model_config.py."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        model_config._load_cached.cache_clear()

    def test_default_fallback_when_empty(self):
        empty_json = Path(self.temp_dir.name) / "models.json"
        empty_json.write_text("{}")
        with patch.dict(os.environ, {}, clear=True):
            resolved = model_config.get_model("decomp_worker", path=empty_json)
            self.assertEqual(resolved, model_config.FALLBACK_MODEL)

    def test_env_role_override_takes_precedence_over_file(self):
        cfg_path = Path(self.temp_dir.name) / "models.json"
        cfg_path.write_text(json.dumps({
            "default": "default-model",
            "roles": {"decomp_worker": "file-model"}
        }))
        with patch.dict(os.environ, {"MODEL_DECOMP_WORKER": "env-model"}):
            resolved = model_config.get_model("decomp_worker", path=cfg_path)
            self.assertEqual(resolved, "env-model")

    def test_explicit_argument_takes_top_precedence(self):
        cfg_path = Path(self.temp_dir.name) / "models.json"
        cfg_path.write_text(json.dumps({
            "roles": {"decomp_worker": "file-model"}
        }))
        with patch.dict(os.environ, {"MODEL_DECOMP_WORKER": "env-model"}):
            resolved = model_config.get_model(
                "decomp_worker", explicit="cli-explicit-model", path=cfg_path
            )
            self.assertEqual(resolved, "cli-explicit-model")

    def test_role_env_var_conversion(self):
        self.assertEqual(
            model_config.role_env_var("decomp_worker"), "MODEL_DECOMP_WORKER"
        )
        self.assertEqual(
            model_config.role_env_var("legal-verification"), "MODEL_LEGAL_VERIFICATION"
        )

    def test_available_roles_and_resolved_table(self):
        cfg_path = Path(self.temp_dir.name) / "models.json"
        cfg_path.write_text(json.dumps({
            "default": "amazon-bedrock/nova-lite",
            "roles": {
                "decomp_worker": "amazon-bedrock/nova-lite",
                "spec_writer": "amazon-bedrock/nova-pro"
            }
        }))
        roles = model_config.available_roles(cfg_path)
        self.assertEqual(roles, ["decomp_worker", "spec_writer"])
        table = model_config.resolved_table(cfg_path)
        self.assertEqual(table["decomp_worker"], "amazon-bedrock/nova-lite")
        self.assertEqual(table["spec_writer"], "amazon-bedrock/nova-pro")
        self.assertEqual(table["default"], "amazon-bedrock/nova-lite")


class TestLaunchGuardsAndValidation(unittest.TestCase):
    """Test launch.py argument validation, container guards, and actionable errors."""

    def test_container_guard_raises_outside_container(self):
        with patch.object(Path, "exists", return_value=False), \
             patch.dict(os.environ, {"CONTAINER_ORCHESTRATOR": "0"}, clear=False):
            with self.assertRaises(RuntimeError) as ctx:
                launch.check_container_guard("rename")
            self.assertIn("must run inside the isolated Docker/Podman container environment", str(ctx.exception))
            self.assertIn("docker compose --profile worker up orchestrator", str(ctx.exception))

    def test_container_guard_passes_with_env_flag(self):
        with patch.dict(os.environ, {"CONTAINER_ORCHESTRATOR": "1"}, clear=False):
            # Should not raise
            launch.check_container_guard("rename")

    def test_check_headless_actionable_error_when_missing(self):
        missing = Path("/nonexistent/support/analyzeHeadless")
        with self.assertRaises(FileNotFoundError) as ctx:
            launch.check_headless(missing)
        self.assertIn("Ghidra analyzeHeadless script not found", str(ctx.exception))
        self.assertIn("GHIDRA_HEADLESS", str(ctx.exception))

    def test_check_headless_returns_path_when_present(self):
        with tempfile.NamedTemporaryFile() as tmp:
            found = launch.check_headless(Path(tmp.name))
            self.assertEqual(found, Path(tmp.name).resolve())

    def test_check_opencode_actionable_error_when_missing(self):
        missing = Path("/nonexistent/opencode")
        with self.assertRaises(FileNotFoundError) as ctx:
            launch.check_opencode(missing)
        self.assertIn("OpenCode executable not found", str(ctx.exception))
        self.assertIn("OPENCODE_BIN", str(ctx.exception))

    def test_run_validates_timeout(self):
        with self.assertRaises(ValueError) as ctx:
            launch.run(Path("dummy.bin"), "0x401000", "valid_name", timeout=0)
        self.assertIn("timeout must be positive", str(ctx.exception))

    def test_run_validates_symbol_name(self):
        with self.assertRaises(ValueError) as ctx:
            launch.run(Path("dummy.bin"), "0x401000", "invalid-name!", timeout=180)
        self.assertIn("new name must be a simple Ghidra symbol name", str(ctx.exception))

    def test_run_validates_address_format(self):
        with self.assertRaises(ValueError) as ctx:
            launch.run(Path("dummy.bin"), "not_an_address", "valid_name", timeout=180)
        self.assertIn("address must be hexadecimal", str(ctx.exception))

    def test_run_validates_binary_file_exists(self):
        with self.assertRaises(FileNotFoundError) as ctx:
            launch.run(Path("/nonexistent/binary.bin"), "0x401000", "valid_name", timeout=180)
        self.assertIn("Binary file not found", str(ctx.exception))

    def test_dispatch_many_validates_max_workers(self):
        with self.assertRaises(ValueError) as ctx:
            launch.dispatch_many([{"binary": "a", "address": "0x1", "new_name": "b"}], max_workers=0)
        self.assertIn("max_workers must be positive", str(ctx.exception))

    def test_dispatch_many_handles_empty_assignments(self):
        self.assertEqual(launch.dispatch_many([]), [])

    def test_podman_error_when_binary_not_found(self):
        with patch("subprocess.run", side_effect=FileNotFoundError("No such file")):
            with self.assertRaises(RuntimeError) as ctx:
                launch.podman("version")
            self.assertIn("Podman executable 'podman' not found in PATH", str(ctx.exception))


class TestSecretSecurity(unittest.TestCase):
    """Test that secrets and credentials are sanitized from outputs and logs."""

    def test_sanitize_secrets_masks_aws_keys(self):
        env_secrets = {
            "AWS_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            "AWS_SESSION_TOKEN": "AQoDYXdzEJr1111111111EXAMPLE",
            "AWS_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
        }
        with patch.dict(os.environ, env_secrets):
            raw = (
                "Connecting with AKIAIOSFODNN7EXAMPLE and secret "
                "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY (token: AQoDYXdzEJr1111111111EXAMPLE)"
            )
            sanitized = launch.sanitize_secrets(raw)
            self.assertNotIn("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", sanitized)
            self.assertNotIn("AQoDYXdzEJr1111111111EXAMPLE", sanitized)
            self.assertNotIn("AKIAIOSFODNN7EXAMPLE", sanitized)
            self.assertIn("[AWS_SECRET_ACCESS_KEY_REDACTED]", sanitized)
            self.assertIn("[AWS_SESSION_TOKEN_REDACTED]", sanitized)
            self.assertIn("[AWS_ACCESS_KEY_ID_REDACTED]", sanitized)

    def test_sanitize_args_cleans_list(self):
        with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "my-secret-key-12345"}):
            raw_args = ["--key", "my-secret-key-12345", "--name", "target"]
            clean_args = launch.sanitize_args(raw_args)
            self.assertEqual(clean_args, ["--key", "[AWS_SECRET_ACCESS_KEY_REDACTED]", "--name", "target"])

    def test_worker_error_sanitization(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            workspace = Path(tmp_dir)
            (workspace / "manifest.json").write_text(json.dumps({"timeout_seconds": 60}))
            with patch.dict(os.environ, {"AWS_SECRET_ACCESS_KEY": "super_secret_leak_attempt"}), \
                 patch("launch.podman", side_effect=Exception("Failed on key super_secret_leak_attempt")):
                with self.assertRaises(RuntimeError) as ctx:
                    launch.worker(workspace, "verify")
                self.assertNotIn("super_secret_leak_attempt", str(ctx.exception))
                self.assertIn("[AWS_SECRET_ACCESS_KEY_REDACTED]", str(ctx.exception))
                error_file = workspace / "error.json"
                self.assertTrue(error_file.exists())
                error_data = json.loads(error_file.read_text())
                self.assertNotIn("super_secret_leak_attempt", error_data["error"])
                self.assertIn("[AWS_SECRET_ACCESS_KEY_REDACTED]", error_data["error"])


class TestAgentWorker(unittest.TestCase):
    """Test agent_worker.py config generation, symbol extraction, and validation."""

    def test_names_extraction_nested(self):
        data = {
            "program": {"name": "test_prog"},
            "functions": [
                {"name": "func_a", "address": "0x1000"},
                {"details": {"name": "func_b"}},
            ],
            "unrelated": 42
        }
        extracted = set(agent_worker.names(data))
        self.assertEqual(extracted, {"test_prog", "func_a", "func_b"})

    def test_payload_extraction(self):
        # Structured content takes precedence
        mock_res = MagicMock(is_error=False, structured_content={"key": "value"})
        self.assertEqual(agent_worker.payload(mock_res), {"key": "value"})

        # JSON in text content fallback
        text_content_mock = MagicMock()
        text_content_mock.text = '{"json_key": "json_val"}'
        mock_text_res = MagicMock(
            is_error=False, structured_content=None, content=[text_content_mock]
        )
        self.assertEqual(agent_worker.payload(mock_text_res), {"json_key": "json_val"})

        # Error payload raises
        mock_err = MagicMock(is_error=True)
        mock_err.model_dump.return_value = {"error_code": 404}
        with self.assertRaises(RuntimeError) as ctx:
            agent_worker.payload(mock_err)
        self.assertIn("Ghidra MCP error", str(ctx.exception))

    def test_opencode_config_generation(self):
        manifest = {
            "model": "amazon-bedrock/anthropic.claude-3-5-sonnet",
            "address": "0x401126",
            "new_name": "process_queue",
            "timeout_seconds": 180
        }
        with patch.dict(os.environ, {"GHIDRA_INSTALL_DIR": "/opt/ghidra"}):
            config = agent_worker.opencode_config(manifest)
            self.assertEqual(config["model"], "amazon-bedrock/anthropic.claude-3-5-sonnet")
            self.assertIn("ghidra", config["mcp"])
            self.assertEqual(config["mcp"]["ghidra"]["timeout"], 120000)
            self.assertIn("rename", config["agent"])
            self.assertEqual(config["agent"]["rename"]["permission"]["ghidra_function_rename"], "allow")
            self.assertEqual(config["agent"]["rename"]["permission"]["*"], "deny")

    def test_attempt_validates_required_manifest_fields(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            work_path = Path(tmp_dir)
            with patch.dict(os.environ, {"DECOMP_WORK_DIR": str(work_path)}):
                # Missing manifest
                with self.assertRaises(ValueError) as ctx:
                    agent_worker.attempt()
                self.assertIn("manifest.json missing or empty", str(ctx.exception))

                # Manifest missing required keys
                (work_path / "manifest.json").write_text(json.dumps({"address": "0x401000"}))
                with self.assertRaises(ValueError) as ctx:
                    agent_worker.attempt()
                self.assertIn("manifest missing required key 'new_name'", str(ctx.exception))

    def test_mcp_server_guard_when_missing_env(self):
        with patch.object(agent_worker, "MCPServerStdio", MagicMock()), \
             patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError) as ctx:
                agent_worker.mcp_server()
            self.assertIn("GHIDRA_INSTALL_DIR environment variable is not set", str(ctx.exception))


class TestDurableQueueDegradation(unittest.TestCase):
    """Test queue graceful degradation when optional dependencies are absent."""

    def test_connect_raises_actionable_error_without_psycopg(self):
        import engine.queue as queue_mod
        original_psycopg = queue_mod.psycopg
        try:
            queue_mod.psycopg = None
            queue = DurableQueue("postgresql://localhost/test", MagicMock())
            with self.assertRaises(RuntimeError) as ctx:
                queue._connect()
            self.assertIn("PostgreSQL driver 'psycopg' is not installed", str(ctx.exception))
            self.assertIn("requirements-decomp.txt", str(ctx.exception))
        finally:
            queue_mod.psycopg = original_psycopg


if __name__ == "__main__":
    unittest.main()
