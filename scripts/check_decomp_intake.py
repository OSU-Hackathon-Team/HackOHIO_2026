"""Check multi-module ELF intake, dependency identity, and persisted progress."""

import json
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.analysis.links import link_modules  # noqa: E402
from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.intake import analyze_project  # noqa: E402
from engine.models import ScopeRequest  # noqa: E402
from engine.project_export import export_project  # noqa: E402
from engine.project_queue import enqueue_project_scope, project_queue_status  # noqa: E402
from engine.project_scope import persist_project_scope  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402
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
        links = json.loads(engine.store.get(project["symbol_links_artifact"]))
        bound = [item for item in links["candidates"] if item["symbol"] == "project_adjust"]
        assert len(bound) == 1 and bound[0]["from_module"] == "app"
        assert bound[0]["to_module"] == "math" and bound[0]["call_sites"]
        assert bound[0]["binding"] == "candidate_static"
        assert project["symbol_link_counts"]["candidates"] == len(links["candidates"])
        indexes = {}
        for module in project["modules"]:
            manifest = json.loads(Path(module["analysis_manifest"]).read_text())
            assert manifest["campaign"] == module["analysis_campaign"]
            assert manifest["index_artifact"] == module["index_artifact"]
            assert module["function_count"] > 0
            indexes[module["id"]] = engine.index(manifest)
            entry = next(item["entry"] for item in indexes[module["id"]]["functions"]
                         if not item["external"] and not item["thunk"])
            scope = persist_scope(engine, manifest, ScopeRequest.from_dict({
                "mode": "subsystem", "query": f"{module['id']} entry", "seeds": [entry],
                "max_functions": 1, "max_depth": 0}))
            assert scope["campaign"] == module["analysis_campaign"]
            assert scope["included"]
        duplicate = {**next(item for item in project["modules"] if item["id"] == "math"),
                     "id": "math_copy"}
        contested = link_modules([*project["modules"], duplicate],
                                 {**indexes, "math_copy": indexes["math"]},
                                 [*project["dependencies"],
                                  {"from": "app", "to": "math_copy", "source": "declared"}])
        assert not any(item["symbol"] == "project_adjust"
                       for item in contested["candidates"])
        assert any(item["symbol"] == "project_adjust" and len(item["candidates"]) == 2
                   for item in contested["ambiguous"])
        exported = export_project(engine, project["artifact"])
        repeated_export = export_project(engine, project["artifact"])
        assert exported == repeated_export
        assert exported["complete_discovered_exports"]
        assert exported["discovered_functions"] == sum(module["function_count"] for module in
                                                        project["modules"])
        assert sum(exported["counts"].values()) == exported["discovered_functions"]
        assert exported["unreported_functions"] == 0
        assert all(module["inventory_artifact"] for module in exported["modules"])
        assert exported["unassigned_instructions"] == sum(
            module["static_inventory"]["unassigned_instructions"]
            for module in exported["modules"])
        assert exported["unclassified_executable_bytes"] == sum(
            module["static_inventory"]["unclassified_executable_bytes"]
            for module in exported["modules"])
        for module in exported["modules"]:
            inventory = module["static_inventory"]
            assert inventory["executable_bytes"] == (
                inventory["assigned_instruction_bytes"] +
                inventory["unassigned_instruction_bytes"] +
                inventory["defined_executable_data_bytes"] +
                inventory["unclassified_executable_bytes"])
            if not module["unclassified_executable_regions_truncated"]:
                assert len(module["unclassified_executable_regions"]) == (
                    inventory["unclassified_executable_regions"])
                assert sum(region["bytes"] for region in
                           module["unclassified_executable_regions"]) == (
                               inventory["unclassified_executable_bytes"])
        app_entries = {item["entry"] for item in indexes["app"]["functions"]
                       if not item["external"] and not item["thunk"]}
        caller = next(site["caller"] for site in bound[0]["call_sites"]
                      if site["caller"] in app_entries)
        project_request = {"mode": "subsystem", "query": "adjust from executable",
                           "seeds": [{"module": "app", "seed": caller}],
                           "max_functions_per_module": 4, "max_depth": 1}
        project_scope = persist_project_scope(engine, project["artifact"], project_request)
        assert persist_project_scope(engine, project["artifact"], project_request) == project_scope
        scope_modules = {item["module_id"]: item for item in project_scope["module_scopes"]}
        assert set(scope_modules) == {"app", "math"}
        math_scope = json.loads(engine.store.get(scope_modules["math"]["scope_artifact"]))
        app_scope = json.loads(engine.store.get(scope_modules["app"]["scope_artifact"]))
        assert bound[0]["target_entry"] in {item["entry"] for item in math_scope["included"]}
        assert app_scope["project_context"]["project_scope_id"] == project_scope["scope_id"]
        assert any(item["kind"] == "cross_module_binding_unverified" and
                   item["target_entry"] == bound[0]["target_entry"] and item["call_sites"]
                   for item in app_scope["unresolved"])
        assert any(item["symbol"] == "project_adjust" and item["target_included"]
                   for item in project_scope["cross_module_candidates"])
        assert any(item["kind"] == "cross_module_binding_unverified" and
                   item["symbol"] == "project_adjust" for item in project_scope["unresolved"])
        whole = persist_project_scope(engine, project["artifact"],
                                      {"mode": "project", "query": "entire linked fixture",
                                       "max_functions_per_module": 100})
        assert len(whole["module_scopes"]) == 2
        assert whole["coverage"]["unclassified_executable_bytes"] == (
            exported["unclassified_executable_bytes"])
        assert any(json.loads(engine.store.get(item["scope_artifact"]))["unresolved"]
                   for item in whole["module_scopes"])
        admin_dsn = os.environ.get(
            "DECOMP_TEST_PG_DSN", "host=127.0.0.1 port=55479 dbname=postgres user=mitch")
        dbname = "decomp_project_intake_check_" + uuid.uuid4().hex[:12]
        with psycopg.connect(admin_dsn, autocommit=True) as admin:
            admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
            try:
                params = psycopg.conninfo.conninfo_to_dict(admin_dsn)
                params["dbname"] = dbname
                queue = DurableQueue(psycopg.conninfo.make_conninfo(**params),
                                     LocalArtifactStore(root / "state" / "artifacts"))
                first = enqueue_project_scope(queue, project_scope["artifact"])
                assert first["enqueued"] == project_scope["coverage"]["tasks"]
                assert enqueue_project_scope(queue, project_scope["artifact"])["enqueued"] == 0
                queued = project_queue_status(queue, project_scope["artifact"])
                assert len(queued["modules"]) == 2
                assert all(item["scope_tasks"]["missing"] == 0
                           for item in queued["modules"])
            finally:
                admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                    sql.Identifier(dbname)))
        status = subprocess.check_output(
            [sys.executable, str(ROOT / "launch.py"), "status", "--state",
             str(root / "state"), "--campaign", project["project_id"]], text=True)
        progress = json.loads(status)[project["project_id"]]["project"]
        assert progress["state"] == "finished" and progress["module_count"] == 2
        assert progress["symbol_links"]["counts"]["candidates"] >= 1
        assert progress["export"]["state"] == "finished"
        assert progress["export"]["complete_discovered_exports"]
        assert progress["export"]["unclassified_executable_bytes"] == (
            exported["unclassified_executable_bytes"])
        assert len(progress["export"]["modules"]) == 2
        assert project_scope["scope_id"] in progress["scopes"]
        assert all(module["state"] == "finished" for module in progress["modules"].values())
        assert all(module["analysis"]["function_count"] > 0 and
                   module["analysis"]["scope_count"] >= 1
                   for module in progress["modules"].values())
        print(json.dumps({"project_id": project["project_id"],
                          "modules": {module["id"]: module["function_count"]
                                      for module in project["modules"]},
                          "dependencies": project["dependencies"],
                          "symbol_link_counts": project["symbol_link_counts"],
                          "export_counts": exported["counts"],
                          "unresolved": project["unresolved_dependencies"]}))


if __name__ == "__main__":
    main()
