-- Migration 039 — §9.5 modality selection and §12.4 attestation status.
--
-- Two clauses of Standard v1.7 that no column could express.
--
-- §9.5: "The user's modality selection is itself recorded in the event's
-- leaf, so a downstream verifier can distinguish 'the user chose not to
-- attach C2PA' from 'C2PA was attached and later stripped.'"
--
-- This cannot be backfilled. Absence of a credential proves nothing
-- unless the selection was committed at signing time, so every event
-- witnessed before this migration is permanently ambiguous on the point.
-- That is not a reason to delay; it is a reason not to delay further.
--
-- §12.4: "A passthrough attestation MUST NOT present identically to a
-- root-verified one. 'Stored' MUST NOT read as 'verified.'"
--
-- Migration 034 added platform_attestation_verified as an INTEGER, which
-- conflates three distinct states into two: root-verified, stored-but-
-- unverified (a legitimate outcome §12.4 explicitly provides for), and
-- verification-attempted-and-failed (which must never be stored at all —
-- §12.4 says invalid reports are rejected with a 4xx). A boolean cannot
-- carry that. The column stays for compatibility; the new TEXT column is
-- authoritative.

ALTER TABLE iterations ADD COLUMN modalities_requested TEXT;
ALTER TABLE iterations ADD COLUMN modalities_applied   TEXT;
ALTER TABLE iterations ADD COLUMN modalities_outstanding TEXT;

-- 'verified'    — chained to a vendor root, nonce matched, within freshness
-- 'passthrough' — stored opaquely; downstream verification is the
--                 receipt-consumer's responsibility, and the receipt says so
-- NULL          — no attestation was supplied. Honest absence.
ALTER TABLE iterations ADD COLUMN platform_attestation_status TEXT
  CHECK (platform_attestation_status IN ('verified', 'passthrough'));

-- §9.6 — an event produced OUTSIDE Scruple's witness path during an
-- outage, using the customer's own C2PA credentials, recorded on
-- reconnect. Distinct from the SDK retry queue, which retries Scruple's
-- own witnessing. Such a leaf is explicitly NOT Scruple-witnessed.
ALTER TABLE iterations ADD COLUMN continuity_json TEXT;

CREATE INDEX IF NOT EXISTS idx_iterations_attestation_status
  ON iterations(platform_attestation_status);
