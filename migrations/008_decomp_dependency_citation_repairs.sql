-- One deterministic citation repair per reviewed task; preserve immutable lineage.
ALTER TABLE decomp_tasks
    ADD COLUMN IF NOT EXISTS dependency_citation_repair_count integer NOT NULL DEFAULT 0
        CHECK (dependency_citation_repair_count BETWEEN 0 AND 1);

CREATE TABLE IF NOT EXISTS decomp_dependency_citation_repairs (
    task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    source_draft_artifact char(64) NOT NULL,
    source_review_artifact char(64) NOT NULL,
    repaired_draft_artifact char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, source_draft_artifact)
);
