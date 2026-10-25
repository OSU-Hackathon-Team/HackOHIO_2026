"""Dumb mechanics: Ghidra export, name redaction, probe execution, artifacts.

No scoring, no priorities, no verdicts. Anything that interprets the
binary is an agent job. Symbol names are redacted before evidence
reaches agents (stripped-only decision, STUPID_ENGINE_PLAN.md section 8):
agents see FUN_<entry> placeholders; the real-name map never leaves
this module and exists only for evaluator grading.
"""

from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

from engine.analysis.ghidra import GhidraAnalysis
from engine.artifacts import LocalArtifactStore


def _placeholder(entry: str) -> str:
    return "FUN_" + entry.replace(":", "_").replace("0x", "")


class StupidTools:
    def __init__(self, state_dir: Path, headless: Path, *, warm_workers: int = 2):
        self.state_dir = Path(state_dir).resolve()
        self.engine = GhidraAnalysis(self.state_dir, Path(headless),
                                     warm_workers=warm_workers)
        self.store = LocalArtifactStore(self.state_dir / "artifacts")
        self._names: dict[str, str] = {}  # entry -> real name, evaluator-side only

    def close(self) -> None:
        self.engine.close()

    # -- analysis (no judgment) ------------------------------------------
    def analyze(self, binary: Path) -> dict:
        return self.engine.analyze(Path(binary))

    def _index(self, manifest: dict) -> dict:
        index = self.engine.index(manifest)
        self._names = {f["entry"]: f["name"] for f in index.get("functions", [])}
        return index

    def inventory_summary(self, manifest: dict) -> dict:
        """Counts only. Large binaries never dump the whole function list."""
        index = self._index(manifest)
        functions = index.get("functions", [])
        return {"function_count": len(functions),
                "thunk_count": sum(1 for f in functions if f.get("thunk")),
                "external_count": sum(1 for f in functions if f.get("external")),
                "call_edge_count": len(index.get("calls", [])),
                "string_count": len(index.get("strings", []))}

    def inventory_page(self, manifest: dict, offset: int = 0,
                       limit: int = 100) -> dict:
        """One slice of the function list. The agent decides what to page."""
        index = self._index(manifest)
        functions = index.get("functions", [])
        limit = max(1, min(limit, 200))
        offset = max(0, offset)
        return {"offset": offset, "limit": limit,
                "total": len(functions),
                "functions": [
                    {"entry": f["entry"], "thunk": bool(f.get("thunk")),
                     "external": bool(f.get("external")),
                     **({"thunk_target": f["thunk_target"]}
                        if f.get("thunk_target") else {})}
                    for f in functions[offset:offset + limit]]}

    def neighbors(self, manifest: dict, entry: str) -> dict:
        """Callers and callees of one entry. Graph walking for agents."""
        key = self.resolve_entry(manifest, entry)
        index = self._index(manifest)
        return {"entry": key,
                "callers": [c["caller"] for c in index.get("calls", [])
                            if c["target"] == key],
                "callees": [c["target"] for c in index.get("calls", [])
                            if c["caller"] == key]}

    def inventory(self, manifest: dict) -> dict:
        """What agents may see: entries, flags, call edges. No names."""
        index = self.engine.index(manifest)
        self._names = {f["entry"]: f["name"] for f in index.get("functions", [])}
        by_name = {name: entry for entry, name in self._names.items() if name}
        functions = [{"entry": f["entry"], "thunk": bool(f.get("thunk")),
                      "external": bool(f.get("external")),
                      **({"thunk_target": f["thunk_target"]}
                         if f.get("thunk_target") else {})}
                     for f in index.get("functions", [])]
        edges = [{"caller": c["caller"], "target": c["target"]}
                 for c in index.get("calls", [])]
        strings = []
        for s in index.get("strings", []):
            value = s.get("value", "")
            # Exact-match redaction only: dynamic symbol names are held out,
            # longer strings (format strings, section names) pass through.
            if value in by_name:
                s = {**s, "value": _placeholder(by_name[value])}
            strings.append(s)
        return {"function_count": len(functions), "functions": functions,
                "call_edges": edges, "strings": strings}

    def resolve_entry(self, manifest: dict, entry: str) -> str:
        """Mechanical address normalization: optional 0x, unique suffix."""
        index = self.engine.index(manifest)
        entries = [f["entry"] for f in index.get("functions", [])]
        if entry in entries:
            return entry
        bare = entry.lower().removeprefix("0x").lstrip("0") or "0"
        matches = [e for e in entries
                   if e.lower().lstrip("0") == bare]
        if len(matches) == 1:
            return matches[0]
        raise ValueError(f"function entry {entry} not in index")

    def read_function(self, manifest: dict, entry: str) -> dict:
        """Redacted function evidence + artifact id. Names never leave."""
        evidence = self.engine.function(manifest, self.resolve_entry(manifest, entry))
        redacted = self._redact(evidence)
        artifact = self.store.put(json.dumps(redacted, sort_keys=True).encode())
        return {"artifact": artifact, "evidence": redacted}

    def _redact(self, evidence: dict) -> dict:
        redacted = copy.deepcopy(evidence)
        table = {name: _placeholder(entry)
                 for entry, name in self._names.items() if name}
        # Structured name fields first.
        for key in ("name", "function_name", "target", "caller"):
            if isinstance(redacted.get(key), str) and redacted[key] in table:
                redacted[key] = table[redacted[key]]
        blob = json.dumps(redacted, sort_keys=True)
        for name in sorted(table, key=len, reverse=True):
            if len(name) >= 2:  # skip 1-char symbols; too noisy to replace
                blob = blob.replace(name, table[name])
        return json.loads(blob)

    # -- probes (execute only; the agent judges observed vs expected) -----
    def run_shared_probe(self, library: Path, adapter: Path, request: dict,
                         *, timeout: int = 120) -> dict:
        completed = subprocess.run(
            ["python3", str(adapter), str(library)], input=json.dumps(request),
            capture_output=True, text=True, timeout=timeout)
        if completed.returncode != 0:
            return {"ok": False, "stderr": completed.stderr[-2000:]}
        return {"ok": True, "observed": json.loads(completed.stdout)}

    def run_executable_probe(self, binary: Path, args: list[str], *,
                             timeout: int = 120) -> dict:
        completed = subprocess.run(
            [str(binary), *args], capture_output=True, text=True,
            timeout=timeout)
        return {"exit_code": completed.returncode,
                "stdout": completed.stdout.strip(),
                "stderr": completed.stderr.strip()[-2000:]}
