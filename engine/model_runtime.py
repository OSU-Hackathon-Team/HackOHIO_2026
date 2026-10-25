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
                    agent_instruction: str) -> dict:
    version = subprocess.run([str(opencode), "--version"], capture_output=True,
                             text=True, check=True, timeout=10).stdout.strip()
    ambient = model == "opencode/ambient"
    events_path = folder / "events.jsonl"
    stderr_path = folder / "stderr.log"
    env = os.environ.copy()
    if env.get("AWS_PROFILE"):
        # A selected profile must not be shadowed by stale ambient session keys.
        for key in AWS_KEYS - {"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION"}:
            env.pop(key, None)
    command = [str(opencode), "run", "--pure"]
    if ambient:
        # OpenCode's local default can be available without a provider key.
        # It rejects an explicit model or permission override. Keep the run in
        # its private attempt directory and reject any tool-use event below.
        env.pop("OPENCODE_CONFIG", None)
        env.pop("OPENCODE_CONFIG_CONTENT", None)
        for key in AWS_KEYS:
            env.pop(key, None)
        prompt = agent_instruction + "\n" + prompt
    else:
        config = {"$schema": "https://opencode.ai/config.json", "model": model,
                  "permission": {"*": "deny"},
                  "agent": {agent_name: {"mode": "primary", "model": model,
                                        "prompt": agent_instruction,
                                        "permission": {"*": "deny"}}}}
        config_path = folder / "opencode.json"
        config_path.write_text(json.dumps(config, indent=2) + "\n")
        if not env.get("AWS_PROFILE"):
            add_aws_env(env, env_file)
        env["OPENCODE_CONFIG"] = str(config_path)
        command.extend(["--agent", agent_name, "--model", model])
    env.update(OPENCODE_DISABLE_AUTOUPDATE="true",
               OPENCODE_DISABLE_EXTERNAL_SKILLS="true")
    command.extend(["--format", "json", prompt])
    with events_path.open("w") as events, stderr_path.open("w") as stderr:
        completed = subprocess.run(command, cwd=folder, env=env, stdout=events, stderr=stderr,
                                   timeout=timeout, check=False)
    rows = [json.loads(line) for line in events_path.read_text().splitlines()
            if line.startswith("{")]
    if completed.returncode:
        failures = [row.get("error", {}) for row in rows if row.get("type") == "error"]
        message = failures[-1].get("data", {}).get("message", "") if failures else ""
        raise RuntimeError(f"OpenCode exited {completed.returncode}: {message}; see {stderr_path}")
    if ambient and any(row.get("type") == "tool_use" or
                       row.get("part", {}).get("type") == "tool" for row in rows):
        raise RuntimeError("ambient model attempted a tool call; output rejected")
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
