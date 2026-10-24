-- Durable decomp task control state. Artifacts are written before these pointers.
CREATE TABLE IF NOT EXISTS decomp_campaigns (
    id text PRIMARY KEY,
    binary_sha256 char(64) NOT NULL,
    state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'completed', 'budget_exhausted', 'stalled', 'infrastructure_failure')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS decomp_pools (
    name text PRIMARY KEY,
    capacity integer NOT NULL CHECK (capacity > 0),
    active integer NOT NULL DEFAULT 0 CHECK (active >= 0),
    CHECK (active <= capacity)
);

INSERT INTO decomp_pools (name, capacity) VALUES
    ('reasoning', 16), ('analysis', 2), ('review', 2)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS decomp_tasks (
    id uuid PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    pool text NOT NULL REFERENCES decomp_pools(name),
    scope_id text NOT NULL,
    scope_artifact char(64) NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    question text NOT NULL,
    deduplication_key char(64) NOT NULL,
    priority_class smallint NOT NULL DEFAULT 2 CHECK (priority_class BETWEEN 0 AND 3),
    priority integer NOT NULL DEFAULT 0,
    evidence_artifact char(64) NOT NULL,
    dependency_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'leased', 'result_pending', 'validated',
                         'accepted', 'needs_reconciliation', 'rejected', 'partial')),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_epoch bigint NOT NULL DEFAULT 0,
    leased_by text,
    lease_until timestamptz,
    attempts_count integer NOT NULL DEFAULT 0 CHECK (attempts_count >= 0),
    max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
    checkpoint_artifact char(64),
    result_artifact char(64),
    result_submission_key text,
    review_artifact char(64),
    support_level text NOT NULL DEFAULT 'none'
        CHECK (support_level IN ('none', 'static_only', 'execution_agreement')),
    terminal_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (campaign_id, deduplication_key),
    CHECK ((state = 'leased') = (leased_by IS NOT NULL AND lease_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS decomp_tasks_dispatch
    ON decomp_tasks (pool, state, available_at, priority_class, priority DESC);
CREATE INDEX IF NOT EXISTS decomp_tasks_expiry
    ON decomp_tasks (lease_until) WHERE state = 'leased';

CREATE TABLE IF NOT EXISTS decomp_attempts (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    epoch bigint NOT NULL,
    worker_id text NOT NULL,
    state text NOT NULL CHECK (state IN ('leased', 'expired', 'submitted',
                                        'retryable_failed', 'terminal_failed')),
    started_at timestamptz NOT NULL DEFAULT now(),
    heartbeat_at timestamptz NOT NULL DEFAULT now(),
    lease_until timestamptz NOT NULL,
    checkpoint_artifact char(64),
    result_artifact char(64),
    stale_result_artifact char(64),
    model text,
    runtime_version text,
    usage jsonb NOT NULL DEFAULT '{}'::jsonb,
    terminal_reason text,
    UNIQUE (task_id, epoch)
);

CREATE TABLE IF NOT EXISTS decomp_outbox (
    id bigserial PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decomp_outbox_campaign
    ON decomp_outbox (campaign_id, id);
