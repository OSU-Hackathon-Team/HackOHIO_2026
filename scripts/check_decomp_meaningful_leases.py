"""Verify 16 concurrent leases on one indexed, source-known native subsystem."""

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.analysis.ghidra import GhidraAnalysis  # noqa: E402
from engine.models import ScopeRequest  # noqa: E402
from engine.queue import DurableQueue  # noqa: E402
from engine.scope import persist_scope  # noqa: E402


def main() -> None:
    fixture_manifest = ROOT / "decomp-state" / "fixtures" / "telemetry_manifest.json"
    source = ROOT / "fixtures" / "decomp" / "telemetry_lab.c"
    if (not fixture_manifest.exists() or
            json.loads(fixture_manifest.read_text())["source_sha256"] !=
            hashlib.sha256(source.read_bytes()).hexdigest()):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build_telemetry_fixture.py")],
                       check=True)
    fixture = json.loads(fixture_manifest.read_text())
    binary = next(Path(item["analysis_path"]) for item in fixture["builds"]
                  if item["optimization"] == "O2" and item["kind"] == "shared")
    expected_hash = next(item["analysis_sha256"] for item in fixture["builds"]
                         if item["optimization"] == "O2" and item["kind"] == "shared")
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == expected_hash
    engine = GhidraAnalysis(ROOT / "decomp-state", Path(os.environ.get(
        "GHIDRA_HEADLESS", "/opt/ghidra/support/analyzeHeadless")))
    manifest = engine.analyze(binary)
    request = ScopeRequest.from_dict(json.loads((ROOT / "fixtures" / "decomp" /
                                                  "telemetry_scope_request.json").read_text()))
    scope = persist_scope(engine, manifest, request)
    assert len(scope["tasks"]) >= 16, len(scope["tasks"])
    assert not scope["unresolved"], scope["unresolved"]

    admin_dsn = os.environ.get(
        "DECOMP_TEST_PG_DSN", "host=127.0.0.1 port=55479 dbname=postgres user=mitch")
    dbname = "decomp_real_leases_" + uuid.uuid4().hex[:12]
    with psycopg.connect(admin_dsn, autocommit=True) as admin:
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(dbname)))
        try:
            params = psycopg.conninfo.conninfo_to_dict(admin_dsn)
            params["dbname"] = dbname
            queue = DurableQueue(psycopg.conninfo.make_conninfo(**params), engine.store)
            queue.migrate()
            queue.create_campaign(manifest["campaign"], manifest["binary_sha256"])
            assert len(queue.enqueue_scope(scope["artifact"])) == len(scope["tasks"])
            with ThreadPoolExecutor(max_workers=17) as executor:
                futures = [executor.submit(queue.lease, f"telemetry-worker-{i}",
                                           campaign=manifest["campaign"])
                           for i in range(17)]
                leased = [future.result() for future in futures]
            active = [item for item in leased if item]
            assert len(active) == 16, len(active)
            assert len({item["worker_id"] for item in active}) == 16
            assert len({item["subject"] for item in active}) == 16
            names = {item["entry"]: item["name"] for item in scope["included"]}
            active_names = sorted(names[item["subject"]] for item in active)
            status = queue.status(manifest["campaign"])
            assert next(item for item in status["pools"]
                        if item["name"] == "reasoning")["active"] == 16
            print(json.dumps({"binary_sha256": manifest["binary_sha256"],
                              "scope_artifact": scope["artifact"],
                              "meaningful_tasks": len(scope["tasks"]),
                              "simultaneous_leases": len(active),
                              "distinct_workers": len({item["worker_id"] for item in active}),
                              "distinct_functions": len(active_names),
                              "function_names": active_names}, indent=2))
        finally:
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(
                sql.Identifier(dbname)))


if __name__ == "__main__":
    main()
