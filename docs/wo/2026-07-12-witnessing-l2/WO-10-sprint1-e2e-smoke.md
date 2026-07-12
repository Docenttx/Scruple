# WO-10 — Sprint 1 E2E smoke + vendor demo script

**Sprint:** 1
**Estimate:** 4 owner-hours
**Blocking:** WO-01 through WO-09 all green
**Blocks:** nothing — this is the Sprint 1 acceptance gate

## Goal

Prove Sprint 1 end-to-end and produce a repeatable, ~5-minute vendor demo
that a sales conversation can run against a live environment. After this WO,
a vendor conversation can be closed on "we have this working today" with a
recorded artifact.

## What to prove

The chain:

1. **Sign an asset** through `/api/scruple/c2pa/sign` (WO-04 signer daemon,
   WO-03 refactored code path, WO-01 OCI Vault key).
2. **Observe the leaf** appear in `log_leaves` for the `scruple.c2pa.sign`
   stream (WO-08 emit path, WO-06 ingest, WO-05 schema).
3. **Wait for the checkpoint** (WO-07 scheduler) or force-tick for the
   demo — at `enhanced` tier default 300s; for the demo, override to 30s
   in a dedicated demo stream `scruple.c2pa.sign.demo` so the wait fits.
4. **Fetch the proof bundle** from `/v1/proof/leaf/scruple.c2pa.sign.demo/<seq>`
   (endpoint scaffolded in WO-09; full impl in WO-13 but Sprint 1 needs
   the read side sufficient for the CLI to work).
5. **Verify offline with `scruple-verify`** (WO-09) → VALID.
6. **Independent second-source read**: pull the same signed asset through
   `c2pa-node` (independent SDK from our interop pass) → validation clean.

## What to build

### 1. Demo stream provisioning script `scripts/demo/provision-demo-stream.mjs`

Idempotent:

- Ensures `scruple.c2pa.sign.demo` stream exists on tenant `TEN_scruple`
  with `checkpoint_secs=30`, `tsa_mode='none'`, `anchor_epoch_secs=3600`
  (or force-tick — see below).
- Ensures a demo principal `PRN_demo` + delegation.
- Prints stream_id + principal_id + a fresh API key for a "demo tenant"
  (separate from `TEN_scruple`) so the vendor can drive the ingest side
  themselves if we want to demo the full audit-API surface too.

### 2. Sign-and-verify script `scripts/demo/sign-and-verify.sh`

```bash
#!/usr/bin/env bash
# scripts/demo/sign-and-verify.sh
# Sprint 1 E2E smoke + vendor demo.
# Prereqs: signer daemon running, ingest API up, checkpoint scheduler up,
#          scruple-verify installed globally (npm i -g @scruple/verify).

set -euo pipefail

ASSET=${ASSET:-/tmp/demo-source.png}
OUTPUT_DIR=${OUTPUT_DIR:-/tmp/scruple-demo}
mkdir -p "$OUTPUT_DIR"

if [ ! -f "$ASSET" ]; then
  cp /data/scruple-web/public/scruple_wordmark_crimson.png "$ASSET"
fi

echo "== Step 1: sign the asset =="
RESP=$(curl -sS -X POST http://localhost:3001/api/scruple/c2pa/sign \
  -H "Authorization: Bearer ${DEMO_API_KEY}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg asset "$ASSET" --arg tier "witnessed" '{
    project_id: 1, asset_path: $asset, product: "studio", tier: $tier
  }')")

SIGNED_PATH=$(echo "$RESP" | jq -r .signed_path)
STREAM_ID=$(echo "$RESP" | jq -r .witness.stream_id)
TENANT_SEQ=$(echo "$RESP" | jq -r .witness.tenant_seq)
LEAF_HASH=$(echo "$RESP" | jq -r .witness.leaf_hash)
CHECKPOINT_EPOCH=$(echo "$RESP" | jq -r .witness.pending_checkpoint_epoch)

echo "  Signed:            $SIGNED_PATH"
echo "  Leaf hash:         $LEAF_HASH"
echo "  Tenant seq:        $TENANT_SEQ"
echo "  Pending epoch:     $CHECKPOINT_EPOCH"

echo "== Step 2: wait for checkpoint =="
# Poll the streams endpoint until latest_checkpoint_epoch >= pending
for i in {1..40}; do
  LATEST=$(curl -sS -H "Authorization: Bearer ${DEMO_API_KEY}" \
    http://localhost:3001/v1/streams | \
    jq -r ".streams[] | select(.stream_id==\"$STREAM_ID\") | .latest_checkpoint_epoch")
  if [ "$LATEST" -ge "$CHECKPOINT_EPOCH" ]; then
    echo "  Checkpoint reached (epoch=$LATEST)."
    break
  fi
  sleep 1
done

echo "== Step 3: fetch proof bundle =="
PROOF_FILE="$OUTPUT_DIR/proof.json"
curl -sS "http://localhost:3001/v1/proof/leaf/${STREAM_ID}/${TENANT_SEQ}" > "$PROOF_FILE"
echo "  Proof bundle:      $PROOF_FILE"

echo "== Step 4: verify with scruple-verify (offline) =="
scruple-verify leaf <(curl -sS "http://localhost:3001/v1/leaf/${STREAM_ID}/${TENANT_SEQ}") "$PROOF_FILE"

echo "== Step 5: verify C2PA layer with c2pa-node (independent SDK) =="
node -e "
  const c = require('c2pa-node').createC2pa();
  c.read({mimeType:'image/png',path:'$SIGNED_PATH'}).then(r => {
    const errs = (r.validation_status || []).filter(s => s.code && !s.code.match(/valid|match|untrusted/));
    if (errs.length) { console.error('FAIL:', errs); process.exit(1); }
    console.log('  c2pa-node:         VALID');
  });
"

echo
echo "== ALL GREEN =="
echo "  Signed asset:      $SIGNED_PATH"
echo "  Witness leaf:      $LEAF_HASH"
echo "  Verification:      passes offline via scruple-verify + c2pa-node"
```

Run against a fresh checkout of the branch. Wall-clock target: <2 minutes.

### 3. Recorded demo artifact

- One-time: run the script against dev.stooges.ai (or localhost) with
  `asciinema` recording to
  `docs/wo/2026-07-12-witnessing-l2/sprint1-demo.cast`.
- Also produce a screenshot montage: (1) signed asset preview, (2)
  `log_leaves` row in the DB, (3) checkpoint row, (4) verifier output —
  saved under
  `docs/wo/2026-07-12-witnessing-l2/sprint1-demo-artifacts/`.
- These are the "receipts" a sales call points at.

### 4. Runbook `docs/wo/2026-07-12-witnessing-l2/sprint1-demo-runbook.md`

Written for a non-engineer to execute:

- Prereqs: env vars, signer daemon running, checkpoint scheduler running.
- Run the script.
- What to say to the vendor at each step ("this is your asset, now witnessed,
  now verifiable by anyone with just this CLI").
- Handling common failures (checkpoint didn't tick — check
  `systemctl status scruple-witness-checkpoint`; ingest 401 — check the
  demo API key; etc.).

### 5. Sprint 1 sign-off checklist

Consolidated pass/fail against all Sprint 1 acceptance criteria:

- [ ] WO-01 acceptance items green (Vault + IAM + audit archive).
- [ ] WO-02 CSR submitted, waiting on issuer (dev cert OK to smoke).
- [ ] WO-03 signer refactored, no file-based key path exists.
- [ ] WO-04 systemd unit running as isolated user; socket permissions
      correct; rate limits enforce.
- [ ] WO-05 migration applied, parity tests green.
- [ ] WO-06 ingest API accepts leaves, HMAC-authenticated, rate-limited.
- [ ] WO-07 checkpoint scheduler running, checkpoints emitted at correct
      cadence including heartbeats.
- [ ] WO-08 sign event lands as leaf on every sign; C2PA JUMBF contains
      witness assertion.
- [ ] WO-09 verifier CLI installed, fixture tests pass.
- [ ] **This WO**: full E2E script runs to VALID exit 0 on a fresh sign.

## What NOT to build

- Do not build a UI for the demo. The script + recorded terminal is
  enough. UI is Sprint 3 for the general product.
- Do not integrate with the anchor pipeline (RVN/IPFS/Arweave). That
  demo is Sprint 2 WO-12's smoke. Sprint 1 stops at "checkpoint signed."
- Do not gate the demo on the production C2PA cert. Dev cert with
  `SCRUPLE_C2PA_DEV=1` on the demo box is fine; the vendor is being
  shown the pipeline, not the cert.
- Do not run this against production DB. Use a dedicated demo tenant
  and stream so the demo leaves don't pollute the C2PA sign stream.

## Deliverables

- `scripts/demo/provision-demo-stream.mjs`
- `scripts/demo/sign-and-verify.sh`
- `docs/wo/2026-07-12-witnessing-l2/sprint1-demo.cast` (asciinema recording)
- `docs/wo/2026-07-12-witnessing-l2/sprint1-demo-artifacts/`
  (screenshots + representative JSON files)
- `docs/wo/2026-07-12-witnessing-l2/sprint1-demo-runbook.md`
- Sprint 1 sign-off note appended to
  `docs/wo/2026-07-12-witnessing-l2/INDEX.md` recording the pass date +
  Git SHA + demo artifact links.

## Acceptance criteria

- [ ] `bash scripts/demo/sign-and-verify.sh` exits 0 on a clean environment.
- [ ] Wall-clock from sign to VALID verification: < 2 minutes.
- [ ] Recorded asciinema exists and plays cleanly.
- [ ] Screenshots exist and are legible.
- [ ] The runbook was successfully executed by someone who did NOT
      write it (product / support / partner-team member — informal test
      that the docs stand alone).
- [ ] Sprint 1 sign-off note committed to INDEX.md.

## Related

- All Sprint 1 WOs (this is their gate)
- Sprint 2 WO-12 — extends this to include anchor verification
- Sprint 3 WO-18 — L2 evidence package uses the same demo shape but
  against the production cert + anchored proofs
- Canonical design §12 (Rollout Plan — Sprint 1 target)
