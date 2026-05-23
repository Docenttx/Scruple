-- Migration 018: persist the witness server's countersignature on the
-- lock event itself.
--
-- Pre-018: the witness server already signed every per-iteration record
-- (HMAC on the v2.1 canonical record → leaf_hash). For chain lock, the
-- witness server ALSO signed the lock event (the {project_id, merkle_root,
-- witnessed_count, locked_at} tuple from handleLock or
-- handleConfirmAndExecute → projects.witness_signature), and that gets
-- minted onto RVN. For checkpoint and local lock, the dev-bypass path
-- skipped the witness server entirely — the lock event was a web-only
-- assertion with no second-party countersignature.
--
-- Post-018 (paired with the lock-route cleanup):
--   - All four lock actions (checkpoint, local, chain-basic, chain-pinned)
--     always go through the witness server.
--   - The witness server returns server_signature + locked_at on the lock
--     event; both are persisted here. The receipt renders them as the
--     "Scruple second-party seal" on this lock.
--   - Distinct from projects.witness_signature, which historically meant
--     "signature on the chain-anchor lock data." Keeping both for
--     back-compat; new flows populate lock_server_signature.

ALTER TABLE projects ADD COLUMN lock_server_signature   TEXT;
ALTER TABLE projects ADD COLUMN lock_locked_at_witnessed TEXT;
