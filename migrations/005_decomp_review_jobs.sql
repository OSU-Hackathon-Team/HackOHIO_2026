-- Independent semantic review has its own bounded, recoverable admission pool.
CREATE TABLE IF NOT EXISTS decomp_review_jobs (
    task_id uuid PRIMARY KEY REFERENCES decomp_tasks(id),
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'leased', 'completed', 'failed')),
    lease_epoch bigint NOT NULL DEFAULT 0,
    leased_by text,
    lease_until timestamptz,
    attempts_count integer NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    review_artifact char(64),
    terminal_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((state = 'leased') = (leased_by IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS decomp_review_jobs_dispatch
    ON decomp_review_jobs (state, available_at, created_at);
CREATE INDEX IF NOT EXISTS decomp_review_jobs_expiry
    ON decomp_review_jobs (lease_until) WHERE state = 'leased';
