"""Check project-scope registration and progress in a disposable PostgreSQL database."""

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

from engine.artifacts import LocalArtifactStore  # noqa: E402
from engine.project_queue import enqueue_project_scope, project_queue_status  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402


def put(store: LocalArtifactStore, value: dict) -> str:
    return store.put(json.dumps(value, sort_keys=True).encode())


def main() -> None:
    admin_dsn = os.environ.get(
        "DECOMP_TEST_PG_DSN", "host=127.0.0.1 port=55479 dbname=postgres user=mitch")
    dbname = "decomp_project_queue_check_" + uuid.uuid4().hex[:12]
    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
        try:
            with TemporaryDirectory(prefix="decomp-project-queue-") as temporary:
                store = LocalArtifactStore(Path(temporary) / "artifacts")
                params = psycopg.conninfo.conninfo_to_dict(admin_dsn)
                params["dbname"] = dbname
                dsn = psycopg.conninfo.make_conninfo(**params)
                queue = DurableQueue(dsn, store)
                project_id, project_scope_id = "a" * 64, "d" * 64
                modules = [{"id": "app", "analysis_campaign": "b" * 64,
                            "binary_sha256": "1" * 64},
                           {"id": "math", "analysis_campaign": "c" * 64,
                            "binary_sha256": "2" * 64}]
                for module in modules:
                    module["index_artifact"] = put(store, {"schema": 1,
                                                            "module": module["id"]})
                project_artifact = put(store, {"schema": 2, "project_id": project_id,
                                               "modules": modules})
                entries = []
                for number, module in enumerate(modules):
                    scope_id = f"{number + 3:064x}"
                    task = {"kind": "behavior", "subject": f"{0x1000 + number:08x}",
                            "question": "Explain observable behavior",
                            "deduplication_key": f"{number + 5:064x}", "priority": 50,
                            "index_artifact": module["index_artifact"]}
                    scope_artifact = put(store, {
                        "schema": 1, "campaign": module["analysis_campaign"],
                        "scope_id": scope_id, "revision": 1,
                        "index_artifact": module["index_artifact"],
                        "project_context": {"project_scope_id": project_scope_id,
                                            "project_artifact": project_artifact},
                        "included": [{"entry": task["subject"]}], "tasks": [task]})
                    entries.append({"module_id": module["id"],
                                    "campaign": module["analysis_campaign"],
                                    "scope_id": scope_id, "revision": 1,
                                    "scope_artifact": scope_artifact,
                                    "included": 1, "tasks": 1})
                project_scope = {"schema": 1, "project_id": project_id,
                                 "project_artifact": project_artifact,
                                 "scope_id": project_scope_id,
                                 "module_scopes": entries, "unresolved": [{"kind": "link"}],
                                 "unexplored_modules": []}
                broken = put(store, {**project_scope, "module_scopes": [
                    {**entries[0], "tasks": 2}, entries[1]]})
                try:
                    enqueue_project_scope(queue, broken)
                except ValueError as error:
                    assert "identity changed" in str(error)
                else:
                    raise AssertionError("mutated project scope was accepted")
                artifact = put(store, project_scope)
                first = enqueue_project_scope(queue, artifact)
                second = enqueue_project_scope(queue, artifact)
                assert first["enqueued"] == 2 and second["enqueued"] == 0
                status = project_queue_status(queue, artifact)
                assert status["planned_tasks"] == 2 and status["unresolved"] == 1
                assert {item["module_id"]: item["scope_tasks"]["states"]["queued"]
                        for item in status["modules"]} == {"app": 1, "math": 1}
                assert all(item["scope_tasks"]["missing"] == 0 and
                           item["scope_tasks"]["shared_from_other_scopes"] == 0
                           for item in status["modules"])
                shared_entries = []
                for entry in entries:
                    prior_scope = json.loads(store.get(entry["scope_artifact"]))
                    shared_scope_id = "e" * 63 + str(len(shared_entries))
                    shared_artifact = put(store, {
                        **prior_scope, "scope_id": shared_scope_id,
                        "project_context": {"project_scope_id": "f" * 64,
                                            "project_artifact": project_artifact}})
                    shared_entries.append({**entry, "scope_id": shared_scope_id,
                                           "scope_artifact": shared_artifact})
                shared_project_artifact = put(store, {
                    **project_scope, "scope_id": "f" * 64,
                    "module_scopes": shared_entries})
                assert enqueue_project_scope(queue, shared_project_artifact)["enqueued"] == 0
                shared_status = project_queue_status(queue, shared_project_artifact)
                assert all(item["scope_tasks"]["shared_from_other_scopes"] == 1
                           for item in shared_status["modules"])
                cli = subprocess.check_output([
                    sys.executable, str(ROOT / "launch.py"), "project-queue-status",
                    "--project-scope-artifact", artifact, "--state", temporary,
                    "--dsn", dsn], text=True)
                assert json.loads(cli)["modules"][0]["scope_tasks"]["present"] == 1
                for module in modules:
                    lease = queue.lease(f"check-{module['id']}",
                                        campaign=module["analysis_campaign"])
                    assert lease and lease["campaign"] == module["analysis_campaign"]
                print(json.dumps({"project_id": project_id,
                                  "enqueued": first["enqueued"],
                                  "modules": len(status["modules"])}))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
