"""First-party Frida spawn observation for short-lived native programs.

REA's MCP instrumentation is the default transport for attach-mode targets, but a
command-line program takes its input on the command line and exits in milliseconds, so
the observation has to start before the first instruction and be collected when the
process is already gone. This module owns that lifecycle directly: spawn suspended,
install the same module-offset hooks `engine.analysis.rea` builds, resume, and drain
messages until the process exits or the observation window closes.

Returned records keep `spawn_triage`'s shape so callers and artefacts stay identical.
"""

from __future__ import annotations

import time
from typing import Callable

from engine.analysis.rea import frida_hook_source, script_messages

DEFAULT_DURATION_MS = 3000


def _frida():
    try:
        import frida
    except ImportError as error:  # pragma: no cover - dependency is declared
        raise RuntimeError("the frida python package is required for spawn observation") from error
    return frida


def observe(args: list[str], *, module: str, patterns: list[str],
            offsets: dict[str, str] | None = None, limit: int = 1500,
            duration_ms: int = DEFAULT_DURATION_MS, flush_ms: int = 25,
            sleep: Callable[[float], None] = time.sleep) -> dict:
    """Run one program once, in a private attempt directory, and count function entries.

    `args` includes argv[0]. Counts are module-relative and are returned under their
    offset, exactly as the hook script reports them.
    """
    frida = _frida()
    if not args:
        raise ValueError("spawn observation needs a program path")
    if duration_ms < 1 or duration_ms > 600_000:
        raise ValueError("observation window is out of range")
    source = frida_hook_source(module, patterns, limit=max(limit, len(offsets or {})),
                              flush_ms=flush_ms, offsets=offsets)
    messages: list[dict] = []
    # The observed program's own output is not this function's result; keep it out of
    # the parent's stdout so pipeline logs stay readable.
    pid = frida.spawn(args, stdio="pipe")
    session = None
    detached = None
    try:
        session = frida.attach(pid)
        import threading
        detached = threading.Event()
        session.on("detached", lambda *_: detached.set())
        script = session.create_script(source)
        script.on("message", lambda message, _data: messages.append(message))
        script.load()
        frida.resume(pid)
        detached.wait(duration_ms / 1000.0)
        # A program that survived its window still owes us its last flush.
        if not detached.is_set():
            sleep(flush_ms / 1000.0 * 3)
    finally:
        try:
            if session is not None:
                session.detach()
        except Exception:
            pass
    names: dict[str, str] = {}
    counts: dict[str, int] = {}
    for message in script_messages(messages):
        if message["type"] == "ready":
            names.update(message.get("names") or {})
        for offset, count in (message.get("hits") or {}).items():
            counts[offset] = counts.get(offset, 0) + int(count)
    if not names:
        raise RuntimeError(f"no functions in {module} matched {patterns}; "
                          "are debug symbols installed?")
    return {"names": names, "counts": counts}


def cases_triage(cases: list[dict], *, program: str, module: str, patterns: list[str],
                 image_base: int, offsets: dict[str, str] | None = None,
                 argv_for: Callable[[dict], list[str]] | None = None,
                 limit: int = 1500, duration_ms: int = DEFAULT_DURATION_MS,
                 observe_fn: Callable[..., dict] = observe) -> dict:
    """Per case: spawn the original program with that case's arguments and count entries."""
    argv_for = argv_for or (lambda case: list(case["args"]))
    names: dict[str, str] = {}
    observed: dict[str, dict] = {}
    for case in cases:
        result = observe_fn([program, *argv_for(case)], module=module, patterns=patterns,
                            offsets=offsets, limit=limit, duration_ms=duration_ms)
        names.update(result["names"])
        observed[case["id"]] = {"label": case["id"], "outcome": None, "hits": [
            {"offset": offset, "entry": format(image_base + int(offset, 16), "08x"),
             "name": result["names"].get(offset, offset), "count": count}
            for offset, count in sorted(result["counts"].items(), key=lambda kv: (-kv[1], kv[0]))]}
    if not names:
        raise RuntimeError(f"no functions in {module} matched {patterns}; "
                          "are debug symbols installed?")
    return {"hooked": len(names), "cases": observed}
