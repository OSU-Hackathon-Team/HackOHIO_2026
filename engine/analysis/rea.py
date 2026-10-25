"""REA (rea-agents) for native triage: find where a feature lives before decompiling anything.

REA is used for what it is good at on Linux ELF targets:
  * static search over its own provider analysis (search_procedures / search_strings), and
  * runtime observation through a persistent Frida session attached to the running app.
observe_native_calls is LLDB/Mach-O only and inspect_native_load_image is DOS-only, so
neither is used here. Bulk decompilation stays with GhidraAnalysis (warm workers).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import shutil
import time
from typing import Callable

from engine.analysis.mcp_stdio import McpStdioClient, tool_payload

REA_VERSION = os.environ.get("REA_VERSION", "6.7.0")
ROOT = Path(__file__).resolve().parents[2]


def rea_command(env: dict[str, str] | None = None) -> list[str]:
    """REA_COMMAND, else the pinned local install, else npx with the pinned version."""
    env = os.environ if env is None else env
    if env.get("REA_COMMAND"):
        return shlex.split(env["REA_COMMAND"])
    for entry in (ROOT / "node_modules/rea-agents/scripts/rea.mjs",
                  ROOT / "packages/backend/node_modules/rea-agents/scripts/rea.mjs"):
        if entry.is_file():
            return [shutil.which("node") or "node", str(entry), "mcp"]
    return ["npx", "-y", f"rea-agents@{REA_VERSION}", "mcp"]


def _walk(value: object):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from _walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from _walk(item)


def _address(item: dict) -> str | None:
    for key in ("address", "entry", "entrypoint", "entry_point", "start"):
        value = item.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, int):
            return hex(value)
    return None


def procedures(payload: object) -> list[dict]:
    """Every {name, address} pair in a search/list result, in order, without duplicates."""
    seen, found = set(), []
    for item in _walk(payload):
        # Native search_procedures returns {address, value}; evidence repeats raw/normalized rows.
        name = item.get("name") or item.get("symbol") or item.get("label") or item.get("value")
        address = _address(item)
        if isinstance(name, str) and name and address and (name, address) not in seen:
            seen.add((name, address))
            found.append({"name": name, "address": address})
    return found


def strings(payload: object) -> list[dict]:
    seen, found = set(), []
    for item in _walk(payload):
        value = item.get("value") if isinstance(item.get("value"), str) else item.get("string")
        address = _address(item)
        if isinstance(value, str) and address and address not in seen:
            seen.add(address)
            found.append({"value": value, "address": address})
    return found


def _first(payload: object, key: str) -> object:
    for item in _walk(payload):
        if key in item:
            return item[key]
    return None


class ReaSession:
    """One REA MCP server process. Calls are sequential; REA serializes providers anyway."""

    def __init__(self, client: McpStdioClient):
        self.client = client

    @classmethod
    def launch(cls, *, timeout: float = 600.0, env: dict[str, str] | None = None) -> "ReaSession":
        client = McpStdioClient(rea_command(), cwd=str(ROOT), timeout=timeout, env={
            "REA_MCP_INPUT_SCHEMA_PROFILE": "compact",
            "REA_GHIDRA_STARTUP_TIMEOUT_MS": os.environ.get("REA_GHIDRA_STARTUP_TIMEOUT_MS", "600000"),
            **(env or {})})
        client.start()
        return cls(client)

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "ReaSession":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def call(self, tool: str, arguments: dict | None = None, *, timeout: float | None = None) -> object:
        return tool_payload(self.client.call_tool(tool, arguments, timeout=timeout))

    def open_binary(self, path: Path, provider: str = "auto") -> object:
        return self.call("open_binary", {"path": str(path), "provider_id": provider})

    def close_binary(self) -> object:
        return self.call("close_binary", {})


def static_triage(session: ReaSession, binary: Path, *, procedure_patterns: list[str],
                  string_patterns: list[str] = (), max_per_pattern: int = 40,
                  provider: str = "auto", clock: Callable[[], float] = time.monotonic) -> dict:
    """Search REA's provider analysis for candidate procedures; no decompilation."""
    started = clock()
    session.open_binary(binary, provider)
    opened = clock() - started
    try:
        overview = session.call("binary_overview", {})
        candidates: dict[str, dict] = {}

        def offer(proc: dict, reason: str) -> None:
            entry = candidates.setdefault(proc["address"], {**proc, "reasons": []})
            if reason not in entry["reasons"]:
                entry["reasons"].append(reason)

        for pattern in procedure_patterns:
            found = procedures(session.call("search_procedures",
                                            {"pattern": pattern, "mode": "regex"}))
            for proc in found[:max_per_pattern]:
                offer(proc, f"procedure:{pattern}")
        string_hits = []
        for pattern in string_patterns:
            for item in strings(session.call("search_strings", {"pattern": pattern}))[:max_per_pattern]:
                refs = procedures(session.call("xrefs", {"address": item["address"]}))
                string_hits.append({**item, "pattern": pattern, "referenced_by": refs})
                for proc in refs:
                    offer(proc, f"string:{pattern}")
    finally:
        session.close_binary()
    counts = {key: _first(overview, key) for key in ("procedure_count", "string_count", "segment_count")}
    return {"schema": 1, "binary": str(binary), "provider_open_seconds": round(opened, 3),
            "elapsed_seconds": round(clock() - started, 3), "overview": counts,
            "candidates": list(candidates.values()), "strings": string_hits}


FRIDA_HOOK_TEMPLATE = r"""
const MODULE = __MODULE__;
const PATTERNS = __PATTERNS__;
const LIMIT = __LIMIT__;
const OFFSETS = __OFFSETS__;
const mod = Process.getModuleByName(MODULE);
const end = mod.base.add(mod.size);
const inModule = (a) => a.compare(mod.base) >= 0 && a.compare(end) < 0;
const targets = new Map();
// Offsets resolved by the caller from the ELF and its build-id debug file; Frida's own symbol
// lookup does not read separate debug files, so internal (non-exported) functions need these.
for (const offset of Object.keys(OFFSETS)) {
  if (targets.size >= LIMIT) break;
  const address = mod.base.add(ptr(offset));
  if (inModule(address)) targets.set(address.toString(), address);
}
for (const pattern of (targets.size ? [] : PATTERNS)) {
  let found = [];
  try { found = DebugSymbol.findFunctionsMatching(pattern); } catch (e) { found = []; }
  for (const address of found) {
    if (targets.size >= LIMIT) break;
    if (inModule(address)) targets.set(address.toString(), address);
  }
}
if (targets.size === 0) {
  const globs = PATTERNS.map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"));
  for (const e of mod.enumerateExports()) {
    if (targets.size >= LIMIT) break;
    if (e.type === "function" && globs.some((g) => g.test(e.name))) targets.set(e.address.toString(), e.address);
  }
}
let counts = {};
let seq = 0;
const names = {};
for (const address of targets.values()) {
  const offset = "0x" + address.sub(mod.base).toString(16);
  names[offset] = OFFSETS[offset] || DebugSymbol.fromAddress(address).name || offset;
  try {
    Interceptor.attach(address, { onEnter() { counts[offset] = (counts[offset] || 0) + 1; } });
  } catch (e) { delete names[offset]; }
}
const flush = () => {
  if (Object.keys(counts).length === 0) return;
  seq += 1;
  send({ type: "hits", seq: seq, hits: counts });
  counts = {};
};
setInterval(flush, __FLUSH_MS__);
// A short-lived spawned program can exit between intervals; flush its last counts on the way out.
for (const name of ["exit", "_exit"]) {
  try {
    const f = Module.findGlobalExportByName ? Module.findGlobalExportByName(name) : Module.findExportByName(null, name);
    if (f) Interceptor.attach(f, { onEnter: flush });
  } catch (e) {}
}
send({ type: "ready", hooked: Object.keys(names).length, names: names });
"""


def frida_hook_source(module: str, patterns: list[str], *, limit: int = 400,
                      flush_ms: int = 200, offsets: dict[str, str] | None = None) -> str:
    return (FRIDA_HOOK_TEMPLATE.replace("__MODULE__", json.dumps(module))
            .replace("__PATTERNS__", json.dumps(list(patterns)))
            .replace("__OFFSETS__", json.dumps(offsets or {}))
            .replace("__LIMIT__", str(int(limit)))
            .replace("__FLUSH_MS__", str(int(flush_ms))))


def script_messages(payload: object) -> list[dict]:
    """Payloads the hook script sent with send(), however REA wraps them."""
    found = []
    for item in _walk(payload):
        inner = item.get("payload")
        if isinstance(inner, str):
            try:
                inner = json.loads(inner)
            except ValueError:
                inner = None
        if isinstance(inner, dict) and inner.get("type") in {"ready", "hits"}:
            found.append(inner)
    return found


def spawn_triage(session: "ReaSession", cases: list[dict], *, program: str,
                 argv_for: Callable[[dict], list[str]], module: str, patterns: list[str],
                 image_base: int, offsets: dict[str, str] | None = None, limit: int = 1500,
                 duration_ms: int = 3000) -> dict:
    """Per case: spawn the program under Frida with that case's arguments and count entries.

    For short-lived command-line programs, which cannot be attached to once and driven.
    argv includes argv[0], as the program would receive it.
    """
    source = frida_hook_source(module, patterns, limit=max(limit, len(offsets or {})),
                               flush_ms=50, offsets=offsets)
    names: dict[str, str] = {}
    observed = {}
    for case in cases:
        payload = session.call("instrument_with_frida", {
            "mode": "spawn", "program": program, "argv": [program, *argv_for(case)],
            "source_kind": "inline", "source": source, "duration_ms": duration_ms},
            timeout=duration_ms / 1000 + 60)
        counts: dict[str, int] = {}
        for message in script_messages(payload):
            if message["type"] == "ready":
                names.update(message.get("names") or {})
            for offset, count in (message.get("hits") or {}).items():
                counts[offset] = counts.get(offset, 0) + int(count)
        observed[case["id"]] = {"label": case["id"], "outcome": None, "hits": [
            {"offset": offset, "entry": format(image_base + int(offset, 16), "08x"),
             "name": names.get(offset, offset), "count": count}
            for offset, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]}
    if not names:
        raise RuntimeError(f"no functions in {module} matched {patterns}; are debug symbols installed?")
    return {"hooked": len(names), "cases": observed}


class RuntimeTracer:
    """Count entries into a module's functions while the caller drives one scenario at a time.

    Offsets are module-relative, so a hit maps to a Ghidra entry as image_base + offset.
    """

    def __init__(self, session: ReaSession, *, pid: int, module: str, patterns: list[str],
                 image_base: int, limit: int = 400, flush_seconds: float = 0.2,
                 sleep: Callable[[float], None] = time.sleep,
                 offsets: dict[str, str] | None = None):
        self.session = session
        self.pid = pid
        self.module = module
        self.patterns = patterns
        self.offsets = offsets or {}
        if self.offsets:
            limit = max(limit, len(self.offsets))
        self.image_base = image_base
        self.limit = limit
        self.flush_seconds = flush_seconds
        self.sleep = sleep
        self.session_id: str | None = None
        self.names: dict[str, str] = {}
        self._seen: set[int] = set()

    def start(self) -> dict:
        started = self.session.call("start_frida_session", {"mode": "attach", "pid": self.pid})
        session_id = _first(started, "session_id")
        if not isinstance(session_id, str):
            raise RuntimeError("start_frida_session returned no session_id")
        self.session_id = session_id
        loaded = self.session.call("load_frida_script", {
            "session_id": session_id, "source_kind": "inline",
            "source": frida_hook_source(self.module, self.patterns, limit=self.limit,
                                        flush_ms=int(self.flush_seconds * 1000),
                                        offsets=self.offsets)})
        ready = [m for m in script_messages(loaded) if m["type"] == "ready"]
        if not ready:
            self.sleep(self.flush_seconds * 2)
            ready = [m for m in self._messages() if m["type"] == "ready"]
        if not ready:
            raise RuntimeError("Frida hook script did not report ready")
        self.names = ready[-1].get("names", {})
        if not self.names:
            raise RuntimeError(f"no functions in {self.module} matched {self.patterns}; "
                               "are debug symbols installed?")
        self._messages()  # drain hits from before the first scenario
        return {"session_id": session_id, "hooked": len(self.names)}

    def _messages(self) -> list[dict]:
        status = self.session.call("frida_session_status", {"session_id": self.session_id})
        fresh = []
        for message in script_messages(status):
            seq = message.get("seq")
            if message["type"] == "hits" and seq in self._seen:
                continue  # status may repeat messages it already returned
            if message["type"] == "hits":
                self._seen.add(seq)
            fresh.append(message)
        return fresh

    def observe(self, label: str, drive: Callable[[], object]) -> dict:
        if self.session_id is None:
            raise RuntimeError("tracer is not started")
        self._messages()
        outcome = drive()
        self.sleep(self.flush_seconds * 3)
        counts: dict[str, int] = {}
        for message in self._messages():
            for offset, count in (message.get("hits") or {}).items():
                counts[offset] = counts.get(offset, 0) + int(count)
        hits = [{"offset": offset, "entry": format(self.image_base + int(offset, 16), "08x"),
                 "name": self.names.get(offset, offset), "count": count}
                for offset, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
        return {"label": label, "outcome": outcome, "hits": hits}

    def close(self) -> None:
        if self.session_id is not None:
            try:
                self.session.call("close_frida_session", {"session_id": self.session_id})
            finally:
                self.session_id = None
