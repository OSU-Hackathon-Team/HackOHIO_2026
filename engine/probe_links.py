"""Store analyst claim-to-original-observation links for dossier validation."""

from __future__ import annotations

import json
from pathlib import Path

from engine.artifacts import LocalArtifactStore
from engine.dossier import canonical


def persist_probe_links(state: Path, path: Path) -> dict:
    document = json.loads(Path(path).read_text())
    if not isinstance(document, dict) or document.get("schema") != 1 or not isinstance(
            document.get("links"), list) or not document["links"]:
        raise ValueError("probe links need schema 1 and a nonempty links array")
    required = ("draft_artifact", "claim_index", "probe_report_artifact", "case_id",
                "observed_pointer", "expected_observed", "rationale")
    store = LocalArtifactStore(Path(state) / "artifacts")
    for link in document["links"]:
        if not isinstance(link, dict) or any(key not in link for key in required):
            raise ValueError("probe link is missing required fields")
        for key in ("draft_artifact", "probe_report_artifact"):
            store.get(link[key])
        if not isinstance(link["claim_index"], int) or link["claim_index"] < 0:
            raise ValueError("probe claim_index must be a nonnegative integer")
        if not isinstance(link["case_id"], str) or not link["case_id"].strip():
            raise ValueError("probe case_id must be nonempty")
        if not isinstance(link["observed_pointer"], str) or not link["observed_pointer"].startswith("/"):
            raise ValueError("probe observed_pointer must start with /")
        if not isinstance(link["rationale"], str) or not link["rationale"].strip():
            raise ValueError("probe link needs a rationale")
    artifact = store.put(canonical(document))
    return {"artifact": artifact, "links": len(document["links"])}
