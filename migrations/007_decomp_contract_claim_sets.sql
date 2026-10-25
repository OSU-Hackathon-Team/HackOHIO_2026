-- A helper contract can include every reviewed effect of one accepted source task.
ALTER TABLE decomp_contract_versions
    ADD COLUMN IF NOT EXISTS claim_indices jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE decomp_contract_versions
SET claim_indices = jsonb_build_array(claim_index)
WHERE claim_indices = '[]'::jsonb;
