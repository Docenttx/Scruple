# Witness server — mint wiring (2026-05-12)

The fiat-chain-lock + lock handlers now call `testnet-locker.issueAsset`
to issue a real RVN testnet asset for each successful chain lock.

## Diffs

1. `server.js` line 36 — `const { issueAsset } = require('./testnet-locker');`
2. `server.js` line 235/240 — `decodeURIComponent(pathname.split('/')[3])`
   so colon-namespaced project ids (`sw:<userId>:<projectId>`) round-trip
   through URL paths.
3. `server.js` `handleLock` — now `async`. After persisting the lock row,
   computes `scrId = SCR_${sha256(merkle_root).substring(0,8).toUpperCase()}`
   and calls `issueAsset(scrId, null)`. On success, response includes
   `proofTxId`, `proofChain: 'rvn-testnet'`. On failure, `mintError` is
   populated and the lock still returns OK (lock state persisted, mint
   can be retried out-of-band).
4. `server.js` `handleFiatChainLock` — same mint integration. Replaces
   the previous "beta mock response" block.

## Backups

- `/opt/scruple-witness/server.js.bak.<timestamp>` — the pre-patch file

## Idempotency caveat

Ravencoin rejects re-issuance of an asset that already exists. The
second chain-lock of an identical merkle root will succeed at the
local-lock level + witness-lock level but the mint step will return
`mintError: '[LOCKER] raven-cli error: error code: -4'`. This is the
correct behavior. To make idempotency proper, future work: call
`verifyAsset(scrId)` first; if the asset exists, return its txid
rather than attempting reissue.

## Smoke verification

```
SCR_5677F4C9 → 961d46adb23dc01bfc5c036620c3d83e82ecdae7dcfe69709f7f77f8d24ad8e3
SCR_F404F746 → 2abc38c86ef6b0fb795de61517ca690de08956ad1dd857639ac3fb9fcae8b594
SCR_1AF5DC0C → 03f45d11bd367b48b4f6d7bbda2a97c1940b5e5afc71d92d5a62682ff0a08122
```

All visible in `raven-cli -testnet listmyassets 'SCR_*'`.

## 2026-05-21 — handleLock accepts canonical merkleRoot (additive, backward-compatible)
Discovered during scruple-web E2E (project 5 "Cat on a Sailboat"):
calculateMerkleRoot (positional concat, promote-odd) diverges from
scruple-web/desktop buildMerkle (sorted-pair concat, duplicate-odd).
Same 2 leaves → witness root c539ec31… vs canonical 230e123c…, so the
minted scrId derived from a root scruple-web's verifier can't reproduce.
Fix: handleLock now reads optional merkleRoot from the POST body; when
present it uses that canonical root for the lock record, server_signature,
and scrId. When absent (desktop today) it recomputes as before. No change
to already-minted assets.

## 2026-05-21 — confirm-and-execute chain-lock now mints for real
The Stripe/custodial chain-lock-basic|pinned branch previously returned
proofTxId:null ("future session"). It now calls issueAsset(scrId, null) —
same executor as handleLock — performing a real RVN testnet mint. Mint
failure does NOT fail the lock (payment already captured): records the lock
and returns mintError for retry. SCR-ID now derives from the canonical
merkleRoot ALONE (sha256(merkleRoot)[:8]) — identical to handleLock — so the
custodial and non-custodial wallet paths mint the same verifiable anchor for
the same content (previously it hashed merkleRoot+paymentIntentId, which was
not reproducible from provenance data). IPFS/Arweave remain stubbed.
Verified E2E: scruple-web project 4 -> $50 test PaymentIntent (pm_card_visa)
-> /api/stripe/confirm -> minted SCR_08A2D7D4 (tx 567356405c...), witness
locked_projects + scruple-web row both anchored to canonical root 7b92757a...

## 2026-05-22 — IPFS + Arweave wired into chain locks (full/pinned)
anchorPermanence() added: basic tier posts an Arweave token record; pinned
tier additionally pins a JSON proof record to local Kubo (/api/v0/add,
127.0.0.1:5001) and embeds that CID in the Arweave record. Wired into both
confirm-and-execute (Stripe) and handleLock (wallet) chain-lock paths.
New module ipfs-pinner.js. arweave-treasury default host → 127.0.0.1
(arlocal). Non-fatal: IPFS/Arweave failures surface as *Error fields; RVN
mint remains the primary anchor. arlocal.service fixed (WorkingDirectory +
--persist; ./logs is a FILE not a dir — EISDIR/EACCES crash loop resolved).


# v2 record-hash leaf scheme (2026-05-22)

Closes T3/T7 from the provenance threat-vector analysis: the RVN-anchored
Merkle root previously committed to output hashes only. With v2 leaves the
root commits to the WHOLE provenance package — inputs, workflow, order,
and time — so "anyone with the RVN asset ID can prove an untampered
provenance package" holds for the entire record, not just outputs.

## Diffs

1. `server.js` — added `canonicalRecord(rec)` + `recordHash(rec)` helpers
   after `sign()`. Fixed field order is part of the protocol:
       { run_sequence, output_hash, input_hash, workflow_hash,
         server_timestamp, prev_record_hash }
   `sign()` now also accepts a pre-stringified value so it can sign the
   leaf_hash directly.

2. `server.js` `handleWitness` — accepts new optional body fields
   `input_hash` and `workflow_hash`; looks up the previous row's
   `leaf_hash` for this project (v1 rows have NULL → empty string, which
   is correct: the chain starts at the v1→v2 transition); builds the
   canonical record, computes `leaf_hash = sha256(canonical(record))`,
   signs the leaf, persists all new columns + `leaf_scheme='v2'`, and
   returns `leaf_hash`, `prev_record_hash`, `leaf_scheme` in the response.

3. `witness.db` schema — `ALTER TABLE witnesses ADD COLUMN` for
   `input_hash`, `workflow_hash`, `prev_record_hash`, `leaf_hash`, and
   `leaf_scheme TEXT NOT NULL DEFAULT 'v1'`.

## Compatibility

- Existing v1 witnesses keep their NULL/v1 fields; lock-time Merkle of an
  all-v1 project still recomputes against `content_hash` leaves.
- The web verifier and desktop currently build leaves from
  `iterations.leaf_hash`. For v2 iterations that column holds the
  record_hash, so the Merkle and on-chain root naturally cover the full
  record. Desktop divergence is accepted for now (web-only rollout) and
  scheduled to reconcile when desktop is next touched.

## Backup

`/opt/scruple-witness/server.js.bak.1779492475` (timestamp before patch).


# v2.1 leaf — model_fingerprints_hash (2026-05-23)

Closes the "user swaps a model file on the shared volume between runs"
gap. workflow_hash binds the workflow GRAPH (which references models by
filename); the actual weight bytes loaded for those filenames were not
under the on-chain anchor. The Modal runner now hashes every model file
the workflow loads (in-container, at load time) and returns a manifest;
the web ingest folds sha256(canonical(manifest)) into the v2 record.

## Diffs

1. `server.js` `canonicalRecord` — new field `model_fingerprints_hash`
   between `workflow_hash` and `server_timestamp`. Empty string for
   iterations that loaded no model files. Bumps the leaf protocol
   version from v2.0 to v2.1.

2. `server.js` `handleWitness` — accepts `model_fingerprints_hash` in the
   request body; persists in the new `witnesses.model_fingerprints_hash`
   column; folds into the canonical record; adds `mf=<8 hex>|∅` flag to
   the `[WITNESS]` log line.

3. `witness.db` schema — ALTER TABLE witnesses ADD COLUMN
   model_fingerprints_hash TEXT.

## Compatibility

Pre-v2.1 leaves (anything witnessed before this patch) have leaf_hash
computed under the v2.0 canonical, with no model_fingerprints_hash field.
The web verifier (scripts/audit-receipts.py) tries v2.1 first, falls back
to v2.0 for older leaves — both reproduce correctly.

## Backup

`/opt/scruple-witness/server.js.bak.1779499331` (timestamp before patch).


# Lock countersignature for finalize + checkpoint (2026-05-23)

Closes the seam where checkpoint never countersigned, and finalize signed
but didn't return its signature. Both now sign the lock event over
{project_id, action, merkle_root, witnessed_count, locked_at} (action in
the tuple → checkpoint sig can't be replayed as finalize sig) and return
serverSignature in the response. Also adds /api/admin/confirm-pi
(loopback-only) so CLI tests can drive a Stripe sandbox PaymentIntent to
succeeded without browser interaction.

## Diffs

1. `server.js` `handleConfirmAndExecute` — both finalize AND checkpoint
   now compute `lockData = { project_id, action, merkle_root,
   witnessed_count, locked_at }`, sign it, and return `serverSignature`
   in the JSON response. Finalize still persists to locked_projects;
   checkpoint is signed-but-not-persisted (the project remains open).
2. `server.js` — new `/api/admin/confirm-pi` POST. Loopback-only
   (req.socket.remoteAddress must be 127.0.0.1/::1). Calls
   stripe.paymentIntents.confirm with pm_card_visa + a localhost
   return_url so the test confirm passes Stripe's automatic-payment-
   methods validator. Internal dev tool.

## Compatibility

Existing chain-lock signature path unchanged. Pre-patch checkpoint
responses had no serverSignature; new ones do. Callers that ignored
the field are unaffected.

## Backup

`/opt/scruple-witness/server.js.bak.1779501648` (before this patch).

## 2026-06-22 — Canvas v2 WO-8: leaf v2.2

Added `machine_manifest_hash` as an optional preimage field. When the
canvas proxy passes it (post-WO-4), the record commits the user's
pinned custom-node manifest into the leaf, leaf_scheme becomes 'v2.2'.
When absent (every other path), leaf_scheme stays 'v2' and the hash
matches what v2 produced — additive-compatible canonicalization.

DB migrations idempotent (ALTER TABLE … ADD COLUMN). Affected columns:
- witnesses.machine_manifest_hash (new)
- (back-fills) witnesses.leaf_scheme, leaf_hash, input_hash,
  workflow_hash, prev_record_hash, model_fingerprints_hash were
  added to the CREATE TABLE but never to ALTER fallbacks, so older
  installs gained them in this same migration block.

Server backup at server.js.bak.20260622-wo8.
