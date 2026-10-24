-- Bounded, traceable claim coverage revisions after independent review.
ALTER TABLE decomp_tasks
    ADD COLUMN IF NOT EXISTS coverage_revision_count integer NOT NULL DEFAULT 0
        CHECK (coverage_revision_count BETWEEN 0 AND 2);

CREATE TABLE IF NOT EXISTS decomp_coverage_revisions (
    task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    source_review_artifact char(64) NOT NULL,
    expansion_artifact char(64) NOT NULL,
    candidate_artifact char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, source_review_artifact)
);
