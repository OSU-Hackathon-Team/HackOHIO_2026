"""One isolated agent attempt or a fresh-process persistence check."""

import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    from agents.mcp import MCPServerStdio
except ImportError:
    MCPServerStdio = None

def work_dir() -> Path:
    return Path(os.environ.get("DECOMP_WORK_DIR", "/work"))


WORK = work_dir()


def load_manifest(target: Path | None = None) -> dict:
    manifest_file = (target or work_dir()) / "manifest.json"
    if manifest_file.exists():
        try:
            return json.loads(manifest_file.read_text())
        except Exception:
            return {}
    return {}


MANIFEST = load_manifest()


def sanitize_secrets(value: str) -> str:
    """Mask credentials matching sensitive environment keys."""
    if not isinstance(value, str):
        return str(value)
    sanitized = value
    for var in ("AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID"):
        val = os.environ.get(var)
        if val and len(val) > 4 and val in sanitized:
            sanitized = sanitized.replace(val, f"[{var}_REDACTED]")
    return sanitized


def payload(result):
    if result.is_error:
        raise RuntimeError("Ghidra MCP error: " + json.dumps(result.model_dump(mode="json")))
    if result.structured_content is not None:
        return result.structured_content
    if result.content and getattr(result.content[0], "text", None):
        try:
            return json.loads(result.content[0].text)
        except json.JSONDecodeError:
            pass
    raise RuntimeError("Ghidra MCP returned no structured result")


def names(value):
    if isinstance(value, dict):
        for key, child in value.items():
            if key == "name" and isinstance(child, str):
                yield child
            else:
                yield from names(child)
    elif isinstance(value, list):
        for child in value:
            yield from names(child)


def mcp_server():
    if MCPServerStdio is None:
        raise RuntimeError(
            "The 'openai-agents' package is not installed. "
            "MCPServerStdio requires openai-agents, which is installed inside worker.Dockerfile."
        )
    ghidra_dir = os.environ.get("GHIDRA_INSTALL_DIR")
    if not ghidra_dir:
        raise RuntimeError("GHIDRA_INSTALL_DIR environment variable is not set.")
    return MCPServerStdio(
        name="ghidra",
        params={"command": "/opt/venv/bin/ghidra-headless-mcp",
                "args": ["--ghidra-install-dir", ghidra_dir]},
        client_session_timeout_seconds=120,
    )


async def call(server, tool_name, **arguments):
    return payload(await server.call_tool(tool_name, arguments))


def opencode_config(manifest: dict | None = None):
    manifest = manifest or load_manifest() or MANIFEST
    ghidra_dir = os.environ.get("GHIDRA_INSTALL_DIR", "/opt/ghidra_12.1.3_PUBLIC")
    model_name = manifest.get("model", "amazon-bedrock/anthropic.claude-3-5-sonnet")
    allowed = ("ghidra_program_open", "ghidra_function_at", "ghidra_function_report",
               "ghidra_decomp_function", "ghidra_function_rename", "ghidra_program_save",
               "ghidra_program_close")
    permissions = {"*": "deny", **{name: "allow" for name in allowed}}
    return {
        "$schema": "https://opencode.ai/config.json",
        "model": model_name,
        "mcp": {"ghidra": {
            "type": "local",
            "command": ["/opt/venv/bin/ghidra-headless-mcp", "--ghidra-install-dir",
                        ghidra_dir],
            "enabled": True,
            "timeout": 120000,
        }},
        "agent": {"rename": {
            "description": "Inspect and rename one assigned Ghidra function",
            "mode": "primary",
            "model": model_name,
            "prompt": (
                "You are in a private headless Ghidra attempt. Use only the ghidra MCP tools. "
                "Open the binary in the specified project with read_only=false. Inspect the "
                "assigned function, rename only that function, save the program, and close it. "
                "Do not claim success unless every tool call completed successfully."
            ),
            "permission": permissions,
        }},
        "permission": permissions,
    }


def attempt(target_work: Path | None = None):
    work = target_work or work_dir()
    manifest = load_manifest(work)
    if not manifest:
        raise ValueError("manifest.json missing or empty in WORK directory")
    for key in ("address", "new_name", "model"):
        if key not in manifest:
            raise ValueError(f"manifest missing required key '{key}'")
    config_path = work / "opencode.json"
    config_path.write_text(json.dumps(opencode_config(manifest), indent=2) + "\n")
    version = subprocess.run(["/usr/local/bin/opencode", "--version"],
                             capture_output=True, text=True, check=True).stdout.strip()
    prompt = (
        "Use the Ghidra MCP tools in this exact order:\n"
        "1. ghidra_program_open with path=/work/input.bin, read_only=false, "
        "project_location=/work/project, project_name=analysis, program_name=input.bin, "
        "update_analysis=true. Keep its session_id.\n"
        f"2. ghidra_function_at for address={manifest['address']} and that session_id; "
        "also inspect with ghidra_function_report.\n"
        f"3. ghidra_function_rename with function_start={manifest['address']}, "
        f"name={manifest['new_name']}, and that session_id.\n"
        "4. ghidra_program_save and ghidra_program_close with that session_id.\n"
        "Report the observed original name and new name."
    )
    env = os.environ.copy()
    env.update(OPENCODE_CONFIG=str(config_path), OPENCODE_DISABLE_AUTOUPDATE="true",
               OPENCODE_DISABLE_EXTERNAL_SKILLS="true")
    command = ["/usr/local/bin/opencode", "run", "--pure", "--agent", "rename",
               "--model", manifest["model"], "--format", "json", prompt]
    events_path = work / "opencode-events.jsonl"
    log_path = work / "opencode-stderr.log"
    with events_path.open("w") as events_file, log_path.open("w") as log_file:
        completed = subprocess.run(command, cwd=work, env=env, text=True,
                                   stdout=events_file, stderr=log_file,
                                   timeout=manifest.get("timeout_seconds", 180), check=False)
    if completed.returncode != 0:
        raise RuntimeError(f"OpenCode exited {completed.returncode}; see {log_path}")
    events = [json.loads(line) for line in events_path.read_text().splitlines()
              if line.startswith("{")]
    tool_events = [event for event in events if event.get("type") == "tool_use"]
    failed_tools = [event.get("part", {}).get("tool") for event in tool_events
                    if event.get("part", {}).get("state", {}).get("status") != "completed"]
    if failed_tools:
        raise RuntimeError(f"OpenCode MCP tool calls failed: {failed_tools}; see {events_path}")
    tool_calls = [event.get("part", {}).get("tool") for event in tool_events]
    for required in ("ghidra_program_open", "ghidra_function_at",
                     "ghidra_function_rename", "ghidra_program_save"):
        if required not in tool_calls:
            raise RuntimeError(f"OpenCode did not call {required}; see {events_path}")
    if any(event.get("type") == "error" for event in events):
        raise RuntimeError(f"OpenCode reported an error; see {events_path}")
    usage = {key: 0 for key in ("input", "output", "reasoning", "cost")}
    for event in events:
        if event.get("type") == "step_finish":
            part = event.get("part", {})
            tokens = part.get("tokens") or {}
            for key in ("input", "output", "reasoning"):
                usage[key] += tokens.get(key, 0)
            usage["cost"] += part.get("cost", 0)
    messages = [event.get("part", {}).get("text") for event in events
                if event.get("type") == "text"]
    report = {"status": "saved", "mode": "opencode", "attempt_id": manifest.get("attempt_id", ""),
              "address": manifest["address"], "agent_tool_calls": tool_calls,
              "model": manifest["model"],
              "model_role": manifest.get("model_role", "decomp_worker"),
              "opencode_version": version,
              "agent_output": messages[-1] if messages else "", "usage": usage,
              "events": events_path.name,
              "saved_at": datetime.now(timezone.utc).isoformat()}
    (work / "result.json").write_text(json.dumps(report, indent=2) + "\n")


async def verify(target_work: Path | None = None):
    work = target_work or work_dir()
    manifest = load_manifest(work)
    if not manifest:
        raise ValueError("manifest.json missing or empty in WORK directory")
    async with mcp_server() as server:
        opened = await call(server, "project.program.open_existing",
                            project_location=str(work / "project"),
                            project_name=manifest.get("project_name", "analysis"),
                            program_name=manifest.get("program_name", "input.bin"), read_only=True)
        session = opened["session_id"]
        observed = await call(server, "function.at", session_id=session,
                              address=manifest["address"])
        await call(server, "program.close", session_id=session)
    if manifest["new_name"] not in set(names(observed)):
        raise RuntimeError("rename did not survive fresh Ghidra process reopen")
    result_path = work / "result.json"
    report = json.loads(result_path.read_text())
    report.update(status="verified", reopened=observed,
                  verified_at=datetime.now(timezone.utc).isoformat())
    result_path.write_text(json.dumps(report, indent=2, default=str) + "\n")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"run", "verify"}:
        raise SystemExit("usage: agent_worker.py [run|verify]")
    try:
        if sys.argv[1] == "run":
            attempt()
        else:
            asyncio.run(verify())
    except Exception as error:
        safe_msg = sanitize_secrets(str(error))
        (WORK / "error.json").write_text(json.dumps({"stage": sys.argv[1],
                                                     "error": safe_msg}, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
