"""Evidence-only OpenCode invocation shared by semantic and review workers."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess


def _invoke_bedrock(folder: Path, prompt: str, *, model: str, timeout: int,
                    env_file: Path, agent_instruction: str) -> dict:
    import boto3
    from botocore.config import Config

    env = os.environ.copy()
    if env.get("AWS_PROFILE"):
        for key in AWS_KEYS - {"AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION"}:
            env.pop(key, None)
        session = boto3.Session(profile_name=env["AWS_PROFILE"])
    else:
        add_aws_env(env, env_file)
        keys = {key: env.get(key) for key in
                ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN")}
        session = (boto3.Session(aws_access_key_id=keys["AWS_ACCESS_KEY_ID"],
                                aws_secret_access_key=keys["AWS_SECRET_ACCESS_KEY"],
                                aws_session_token=keys["AWS_SESSION_TOKEN"])
                   if keys["AWS_ACCESS_KEY_ID"] and keys["AWS_SECRET_ACCESS_KEY"]
                   else boto3.Session())
    client = session.client(
        "bedrock-runtime", region_name=env.get("AWS_REGION") or
        env.get("AWS_DEFAULT_REGION") or "us-east-2",
        config=Config(connect_timeout=10, read_timeout=timeout,
                      retries={"mode": "standard", "max_attempts": 3}))
    response = client.converse(
        modelId=model.removeprefix("amazon-bedrock/"),
        messages=[{"role": "user", "content": [{"text": agent_instruction + "\n" + prompt}]}],
        inferenceConfig={"maxTokens": 4096})
    pieces = [part["text"] for part in response["output"]["message"]["content"]
              if "text" in part]
    if not pieces:
        raise ValueError("Bedrock returned no text")
    answer = "\n".join(pieces)
    usage = response.get("usage", {})
    normalized = {"input": usage.get("inputTokens", 0),
                  "output": usage.get("outputTokens", 0),
                  "reasoning": usage.get("cacheReadInputTokens", 0), "cost": 0.0}
    (folder / "events.jsonl").write_text(json.dumps({
        "type": "text", "part": {"text": answer},
        "provider": "bedrock_converse", "model": model,
        "stop_reason": response.get("stopReason"), "usage": normalized},
        sort_keys=True) + "\n")
    return {"text": answer, "usage": normalized,
            "runtime_version": "boto3-" + boto3.__version__}

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
    # Direct Converse has no tools; tool-using agents (the investigator) need OpenCode.
    if model.startswith("amazon-bedrock/") and not mcp and not allow_tools:
        return _invoke_bedrock(folder, prompt, model=model, timeout=timeout,
                               env_file=env_file, agent_instruction=agent_instruction)
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
        prompt = (agent_instruction + "\nDo not use any tools, files, shell commands, "
                  "or network searches. Answer from the supplied prompt only.\n" + prompt)
    else:
        # Everything is denied unless named in allow_tools (e.g. read-only MCP tools).
        permission = {"*": "deny", **{name: "allow" for name in allow_tools}}
        config = {"$schema": "https://opencode.ai/config.json", "model": model,
                  "small_model": model, "permission": permission,
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
        if not env.get("AWS_PROFILE"):
            add_aws_env(env, env_file)
        env["OPENCODE_CONFIG"] = str(config_path)
        command.extend(["--print-logs", "--title", agent_name, "--agent", agent_name,
                        "--model", model])
    env.update(PWD=str(folder.resolve()), OPENCODE_DISABLE_AUTOUPDATE="true",
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
