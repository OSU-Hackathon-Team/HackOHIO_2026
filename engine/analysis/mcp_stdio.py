"""Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0).

Used for deterministic tool calls (REA triage and runtime tracing) where no model is
in the loop. OpenCode agents talk to the same servers through their own MCP client.
"""

from __future__ import annotations

from collections import deque
import json
import os
import queue
import subprocess
import threading
import time

PROTOCOL_VERSION = "2025-06-18"


class McpError(RuntimeError):
    pass


class McpToolError(McpError):
    def __init__(self, tool: str, message: str):
        super().__init__(f"{tool}: {message}")
        self.tool = tool


def result_text(result: dict) -> str:
    return "\n".join(item.get("text", "") for item in result.get("content", [])
                     if isinstance(item, dict) and item.get("type") == "text")


def tool_payload(result: dict) -> object:
    """Structured result when the server sent one, else the text content parsed as JSON."""
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured.get("result", structured)
    text = result_text(result)
    try:
        value = json.loads(text)
    except ValueError:
        return text
    return value.get("result", value) if isinstance(value, dict) else value


class McpStdioClient:
    def __init__(self, command: list[str], *, env: dict[str, str] | None = None,
                 cwd: str | None = None, timeout: float = 60.0,
                 client_name: str = "splice-decomp"):
        self.command = list(command)
        self.env = env
        self.cwd = cwd
        self.timeout = timeout
        self.client_name = client_name
        self.process: subprocess.Popen | None = None
        self.server_info: dict = {}
        self.stderr_tail: deque[str] = deque(maxlen=200)
        self._responses: queue.Queue = queue.Queue()
        self._pending: dict[int, dict] = {}
        self._next_id = 0
        self._write_lock = threading.Lock()
        self._request_lock = threading.Lock()  # one caller reads responses at a time

    def __enter__(self) -> "McpStdioClient":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def start(self) -> None:
        if self.process is not None:
            return
        self.process = subprocess.Popen(
            self.command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, cwd=self.cwd,
            env={**os.environ, **(self.env or {})}, text=True, encoding="utf-8",
            errors="replace", bufsize=1)
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        result = self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION, "capabilities": {},
            "clientInfo": {"name": self.client_name, "version": "0.1.0"}})
        self.server_info = result.get("serverInfo", {})
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _read_stdout(self) -> None:
        assert self.process and self.process.stdout
        for line in self.process.stdout:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            if "method" in message and "id" in message:
                # Server-initiated request: answer pings, decline everything else.
                if message["method"] == "ping":
                    self._send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
                else:
                    self._send({"jsonrpc": "2.0", "id": message["id"],
                                "error": {"code": -32601, "message": "not supported"}})
            elif "id" in message:
                self._responses.put(message)
        self._responses.put(None)

    def _read_stderr(self) -> None:
        assert self.process and self.process.stderr
        for line in self.process.stderr:
            self.stderr_tail.append(line.rstrip())

    def _send(self, message: dict) -> None:
        if self.process is None or self.process.stdin is None:
            raise McpError("MCP server is not running")
        with self._write_lock:
            try:
                self.process.stdin.write(json.dumps(message) + "\n")
                self.process.stdin.flush()
            except (BrokenPipeError, OSError) as error:
                raise McpError(f"MCP server closed its input: {error}; "
                               f"stderr: {' | '.join(list(self.stderr_tail)[-5:])}") from error

    def request(self, method: str, params: dict | None = None, *,
                timeout: float | None = None) -> dict:
        with self._request_lock:
            return self._request(method, params, timeout)

    def _request(self, method: str, params: dict | None, timeout: float | None) -> dict:
        self._next_id += 1
        request_id = self._next_id
        self._send({"jsonrpc": "2.0", "id": request_id, "method": method,
                    "params": params or {}})
        deadline = time.monotonic() + (timeout or self.timeout)
        while request_id not in self._pending:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpError(f"{method} timed out after {timeout or self.timeout:.0f}s")
            try:
                message = self._responses.get(timeout=remaining)
            except queue.Empty:
                continue
            if message is None:
                self._responses.put(None)
                raise McpError(f"MCP server exited during {method}; "
                               f"stderr: {' | '.join(list(self.stderr_tail)[-5:])}")
            self._pending[message["id"]] = message
        message = self._pending.pop(request_id)
        if "error" in message:
            raise McpError(f"{method}: {message['error'].get('message', message['error'])}")
        return message.get("result", {})

    def list_tools(self) -> list[dict]:
        return self.request("tools/list").get("tools", [])

    def call_tool(self, name: str, arguments: dict | None = None, *,
                  timeout: float | None = None) -> dict:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}},
                              timeout=timeout)
        if result.get("isError"):
            raise McpToolError(name, result_text(result)[:2000] or "tool reported an error")
        return result

    def close(self) -> None:
        if self.process is None:
            return
        process, self.process = self.process, None
        try:
            if process.stdin:
                process.stdin.close()
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            process.kill()
            process.wait(timeout=5)
