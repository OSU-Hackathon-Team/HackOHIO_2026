-- A reviewed caller pins every consequential helper contract before acceptance.
ALTER TABLE decomp_tasks
    ADD COLUMN IF NOT EXISTS dependency_resolution_artifact char(64);
