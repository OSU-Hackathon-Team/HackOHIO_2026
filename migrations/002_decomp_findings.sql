-- Versioned reviewed findings and reverse dependency edges.
CREATE TABLE IF NOT EXISTS decomp_contract_heads (
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    contract_key text NOT NULL,
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    artifact char(64),
    state text NOT NULL DEFAULT 'unpublished'
        CHECK (state IN ('unpublished', 'active', 'disputed')),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, contract_key)
);

CREATE TABLE IF NOT EXISTS decomp_contract_versions (
    campaign_id text NOT NULL,
    contract_key text NOT NULL,
    version bigint NOT NULL CHECK (version > 0),
    artifact char(64) NOT NULL,
    source_task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    claim_index integer NOT NULL CHECK (claim_index >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, contract_key, version),
    FOREIGN KEY (campaign_id, contract_key)
        REFERENCES decomp_contract_heads(campaign_id, contract_key)
);

CREATE TABLE IF NOT EXISTS decomp_findings (
    id uuid PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    task_id uuid NOT NULL REFERENCES decomp_tasks(id),
    claim_index integer NOT NULL CHECK (claim_index >= 0),
    subject text NOT NULL,
    semantic_slot text NOT NULL,
    statement text NOT NULL,
    claim_artifact char(64) NOT NULL,
    draft_artifact char(64) NOT NULL,
    review_artifact char(64) NOT NULL,
    state text NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'conflicted', 'stale', 'superseded')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (task_id, claim_index)
);
CREATE INDEX IF NOT EXISTS decomp_findings_slot
    ON decomp_findings (campaign_id, subject, semantic_slot, state);

CREATE TABLE IF NOT EXISTS decomp_finding_dependencies (
    finding_id uuid NOT NULL REFERENCES decomp_findings(id),
    campaign_id text NOT NULL,
    contract_key text NOT NULL,
    contract_version bigint NOT NULL,
    PRIMARY KEY (finding_id, contract_key),
    FOREIGN KEY (campaign_id, contract_key, contract_version)
        REFERENCES decomp_contract_versions(campaign_id, contract_key, version)
);
CREATE INDEX IF NOT EXISTS decomp_finding_dependencies_reverse
    ON decomp_finding_dependencies (campaign_id, contract_key, contract_version);

CREATE TABLE IF NOT EXISTS decomp_claim_conflicts (
    id uuid PRIMARY KEY,
    campaign_id text NOT NULL REFERENCES decomp_campaigns(id),
    finding_a uuid NOT NULL REFERENCES decomp_findings(id),
    finding_b uuid NOT NULL REFERENCES decomp_findings(id),
    state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'resolved')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (finding_a, finding_b),
    CHECK (finding_a <> finding_b)
);
