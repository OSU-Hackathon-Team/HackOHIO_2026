-- Persist terminal attempt timing and usage for model and queue throughput reports.
ALTER TABLE decomp_attempts
    ADD COLUMN IF NOT EXISTS finished_at timestamptz;
