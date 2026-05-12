-- Migration 006 (pivot): execution backend + attestation + storage slots
-- on iterations. Per D-016 (TEE-attested only cloud) and D-017 (BYOS).

ALTER TABLE iterations ADD COLUMN execution_backend     TEXT;
ALTER TABLE iterations ADD COLUMN execution_attestation TEXT;  -- JSON, null when non-attested
ALTER TABLE iterations ADD COLUMN storage_pointer       TEXT;  -- JSON {provider, path, url?}

-- Indexes for future analytics ("which backends did this user use this month?")
CREATE INDEX IF NOT EXISTS idx_iterations_backend ON iterations(execution_backend);
