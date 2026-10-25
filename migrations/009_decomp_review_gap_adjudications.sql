-- Link a reviewed gap adjudication to the exact task draft and review it challenged.
ALTER TABLE decomp_tasks
    ADD COLUMN IF NOT EXISTS review_gap_adjudication_artifact char(64);

CREATE TABLE IF NOT EXISTS decomp_review_gap_adjudications (
    task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    draft_artifact char(64) NOT NULL,
    review_artifact char(64) NOT NULL,
    adjudication_artifact char(64) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (task_id, review_artifact)
);
