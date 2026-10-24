"""Check multi-module ELF intake, dependency identity, and persisted progress."""

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.intake import analyze_project  # noqa: E402
from engine.models import ScopeRequest  # noqa: E402
from engine.scope import persist_scope  # noqa: E402


def main() -> None:
    with TemporaryDirectory(prefix="decomp-intake-", dir=ROOT / "decomp-state") as temporary:
        root = Path(temporary)
        library = root / "libdecomp_math.so"
        executable = root / "decomp_app"
        subprocess.run(["gcc", "-O2", "-fPIC", "-shared", "-Wl,-soname,libdecomp_math.so",
                        str(ROOT / "fixtures/decomp/project_math.c"), "-o", str(library)],
                       check=True)
        subprocess.run(["gcc", "-O2", str(ROOT / "fixtures/decomp/project_app.c"),
                        "-L", str(root), "-ldecomp_math", "-Wl,-rpath,$ORIGIN",
                        "-o", str(executable)], check=True)
        subprocess.run(["strip", "--strip-all", str(library), str(executable)], check=True)
        original = subprocess.run([str(executable)], text=True, capture_output=True, check=True)
        assert original.stdout == "12\n"
        alternate = subprocess.run([str(executable), "negative"], text=True,
                                   capture_output=True, check=False)
        assert alternate.returncode == 1 and alternate.stdout == "3\n"
        request = root / "project.json"
        request.write_text(json.dumps({"schema": 1, "modules": [
            {"id": "app", "kind": "executable", "path": executable.name},
            {"id": "math", "kind": "shared", "path": library.name}]}) + "\n")
        engine = GhidraAnalysis(root / "state", Path("/opt/ghidra/support/analyzeHeadless"))
        project = analyze_project(engine, request)
        repeated = analyze_project(engine, request)
        assert repeated == project
        assert {module["id"] for module in project["modules"]} == {"app", "math"}
        assert any(edge["from"] == "app" and edge["to"] == "math" and
                   edge["source"] == "elf_needed" for edge in project["dependencies"])
        assert any(edge["name"] == "libc.so.6" and edge["reason"] == "external"
                   for edge in project["unresolved_dependencies"])
        for module in project["modules"]:
            manifest = json.loads(Path(module["analysis_manifest"]).read_text())
            assert manifest["campaign"] == module["analysis_campaign"]
            assert manifest["index_artifact"] == module["index_artifact"]
            assert module["function_count"] > 0
            entry = next(item["entry"] for item in engine.index(manifest)["functions"]
                         if not item["external"] and not item["thunk"])
            scope = persist_scope(engine, manifest, ScopeRequest.from_dict({
                "mode": "subsystem", "query": f"{module['id']} entry", "seeds": [entry],
                "max_functions": 1, "max_depth": 0}))
            assert scope["campaign"] == module["analysis_campaign"]
            assert scope["included"]
        status = subprocess.check_output(
            [sys.executable, str(ROOT / "launch.py"), "status", "--state",
             str(root / "state"), "--campaign", project["project_id"]], text=True)
        progress = json.loads(status)[project["project_id"]]["project"]
        assert progress["state"] == "finished" and progress["module_count"] == 2
        assert all(module["state"] == "finished" for module in progress["modules"].values())
        assert all(module["analysis"]["function_count"] > 0 and
                   module["analysis"]["scope_count"] >= 1
                   for module in progress["modules"].values())
        print(json.dumps({"project_id": project["project_id"],
                          "modules": {module["id"]: module["function_count"]
                                      for module in project["modules"]},
                          "dependencies": project["dependencies"],
                          "unresolved": project["unresolved_dependencies"]}))


if __name__ == "__main__":
    main()
