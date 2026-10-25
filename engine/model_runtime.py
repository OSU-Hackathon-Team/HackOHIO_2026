"""Evidence-only OpenCode invocation shared by semantic and review workers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

AWS_KEYS = {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE"}


def add_aws_env(env: dict[str, str], env_file: Path) -> None:
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if key not in AWS_KEYS or not value:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        env.setdefault(key, value)


def invoke_opencode(opencode: Path, folder: Path, prompt: str, *, model: str,
                    timeout: int, env_file: Path, agent_name: str,
                    agent_instruction: str, mcp: dict | None = None,
                    allow_tools: tuple[str, ...] = ()) -> dict:
    version = subprocess.run([str(opencode), "--version"], capture_output=True,
                             text=True, check=True, timeout=10).stdout.strip()
    # Everything is denied unless named in allow_tools (e.g. read-only MCP tools).
    permission = {"*": "deny", **{name: "allow" for name in allow_tools}}
    config = {"$schema": "https://opencode.ai/config.json", "model": model, "small_model": model,
              "permission": permission,
              "agent": {agent_name: {"mode": "primary", "model": model,
                                    "prompt": agent_instruction,
                                    "permission": permission}}}
    provider, _, model_id = model.partition("/")
    if provider == "amazon-bedrock" and model_id.startswith("qwen."):
        # The configured Bedrock model can be valid even when OpenCode's catalog omits it.
        # Conservative client budgets keep these evidence-only calls bounded.
        config["provider"] = {provider: {"models": {model_id: {
            "name": model_id, "id": model_id, "status": "active",
            "provider": {"npm": "@ai-sdk/amazon-bedrock"},
            "limit": {"context": 32768, "output": 4000},
        }}}}
    if mcp:
        config["mcp"] = mcp
    config_path = folder / "opencode.json"
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    events_path = folder / "events.jsonl"
    stderr_path = folder / "stderr.log"
    env = os.environ.copy()
    add_aws_env(env, env_file)
    env.update(PWD=str(folder.resolve()), OPENCODE_CONFIG=str(config_path), OPENCODE_DISABLE_AUTOUPDATE="true",
               OPENCODE_DISABLE_EXTERNAL_SKILLS="true")
    with events_path.open("w") as events, stderr_path.open("w") as stderr:
        completed = subprocess.run([str(opencode), "run", "--pure", "--print-logs",
                                    "--title", agent_name, "--agent",
                                    agent_name, "--model", model, "--format", "json",
                                    prompt], cwd=folder, env=env, stdout=events, stderr=stderr,
                                   timeout=timeout, check=False)
    rows = [json.loads(line) for line in events_path.read_text().splitlines()
            if line.startswith("{")]
    if completed.returncode:
        failures = [row.get("error", {}) for row in rows if row.get("type") == "error"]
        message = failures[-1].get("data", {}).get("message", "") if failures else ""
        raise RuntimeError(f"OpenCode exited {completed.returncode}: {message}; see {stderr_path}")
    texts = [row.get("part", {}).get("text", "") for row in rows
             if row.get("type") == "text"]
    if not texts:
        raise ValueError("model returned no text")
    usage = {"input": 0, "output": 0, "reasoning": 0, "cost": 0.0}
    for row in rows:
        if row.get("type") == "step_finish":
            part = row.get("part", {})
            tokens = part.get("tokens") or {}
            for key in ("input", "output", "reasoning"):
                usage[key] += tokens.get(key, 0)
            usage["cost"] += part.get("cost", 0)
    return {"text": texts[-1], "usage": usage, "runtime_version": version}
