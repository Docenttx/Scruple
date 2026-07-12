# WO-09 — `scruple-verify` CLI v1 (leaf, c2pa, trust-manifest subcommands)

**Sprint:** 1
**Estimate:** 12 owner-hours
**Blocking:** WO-05 (canonical leaf spec + parity function), WO-07
(checkpoint output shape + trust manifest structure)
**Blocks:** WO-10 (E2E smoke uses the CLI as its verification step)

## Goal

Ship the reference verifier CLI. It runs standalone with no dependency on
any Scruple service beyond public HTTPS + optional blockchain RPC. It is
the load-bearing credibility artifact for the whole system: **any auditor,
customer, or regulator can pull this CLI and independently verify a signed
asset against the public ledger** without our cooperation.

Canonical design §14 explicitly names this as the LAST thing to cut, not
the first. Ship it in Sprint 1 even if pared down.

## What to build

### 1. Package layout `packages/scruple-verify/`

```
packages/scruple-verify/
  package.json                # bin: {"scruple-verify": "./dist/cli.js"}
  tsconfig.json
  src/
    cli.ts                    # argv parsing + subcommand dispatch
    subcommands/
      leaf.ts                 # `scruple-verify leaf <leaf.json> <proof.json>`
      c2pa.ts                 # `scruple-verify c2pa <signed-asset.png> [--fetch-leaf]`
      trustManifest.ts        # `scruple-verify trust-manifest`
    core/
      canonicalLeafV23.ts     # COPIED from lib/witness/ — MUST stay in sync
      canonicalCheckpointV1.ts # COPIED
      merkleVerify.ts         # inclusion + consistency proof verification
      trustManifest.ts        # fetch + Ed25519 verify
      c2paReader.ts           # thin wrapper over c2pa-node
      rvnLookup.ts            # fetch RVN asset issuance metadata from a public explorer
      arweaveLookup.ts        # fetch an Arweave record by tx id
      ipfsLookup.ts           # fetch content by CID from a public gateway
  test/
    fixtures/                 # sample assets + proofs + expected verdicts
    leaf.test.ts
    c2pa.test.ts
    trustManifest.test.ts
```

**File-copy discipline:** `canonicalLeafV23.ts` and `canonicalCheckpointV1.ts`
are copied byte-for-byte from `lib/witness/`. A CI check
(`test/witness/verify-cli-parity.test.ts` in the main repo) diffs them
against the master copies and fails on drift. The CLI cannot depend on the
main repo at runtime because it ships as a standalone npm package, but its
sources must stay in lock-step.

### 2. `scruple-verify leaf <leaf.json> <proof.json>`

Input files:

- `leaf.json`: `{tenant_id, principal_id, stream_id, tenant_seq, event_time,
  payload_hash, dims, meta}` — the canonical leaf fields.
- `proof.json`: bundle from `/v1/proof/leaf/{stream_id}/{tenant_seq}`
  (endpoint scaffolded here, full impl in WO-13):
  ```json
  {
    "leaf_hash": "sha256:...",
    "inclusion": [{"sibling":"sha256:...","position":"L|R"}, ...],
    "checkpoint": {
      "bundle": {stream_id, epoch_index, first_seq, last_seq,
                 merkle_root, prev_checkpoint_id, is_heartbeat, created_at},
      "witness_sig": "hex",
      "witness_key_id": "scruple-witness-checkpoint-prod",
      "tsa_token_b64": null
    },
    "anchor": {
      "anchor_id": "ANC_...",
      "super_root": "sha256:...",
      "inclusion_to_super_root": [...],
      "rvn_txid": "...",
      "arweave_id": "...",
      "ipfs_cid": "..."
    }
  }
  ```

Verification steps + output:

```
1. Recompute leaf hash from canonical leaf .................... [OK/FAIL]
2. Walk inclusion proof to Merkle root ......................... [OK/FAIL]
3. Verify checkpoint signature ................................ [OK/FAIL]
     └─ key: scruple-witness-checkpoint-prod (Ed25519)
     └─ pulled from trust manifest v1 at scruple.stooges.ai
4. Verify RFC 3161 timestamp (if present) ..................... [OK/SKIP/FAIL]
5. Walk super-root inclusion path ............................. [OK/FAIL]
6. Fetch RVN transaction and confirm super-root ............... [OK/FAIL]
     └─ RVN txid <hash> at block <height>
7. Fetch Arweave record and confirm super-root ................ [OK/FAIL]
8. Fetch IPFS pin and confirm content hash .................... [OK/FAIL]

Verdict: VALID
```

Exit 0 on all-OK; exit N on N failures.

### 3. `scruple-verify c2pa <signed-asset.png> [--fetch-leaf]`

Steps:

1. Parse asset with c2pa-node, extract JUMBF manifest.
2. Verify C2PA signature via c2pa-node → collect `validation_status`
   entries.
3. Report C2PA signer cert subject / issuer / serial + trust chain
   evaluation.
4. Look for the `ai.scruple.witness.v1` assertion (added by WO-08).
   If absent: report "no Scruple witness trail" and stop after C2PA check.
5. If `--fetch-leaf`: pull the proof bundle from the URL in the assertion
   (default `https://scruple.stooges.ai/v1/proof/leaf/<stream_id>/<tenant_seq>`),
   then run the `leaf` subcommand's verification steps 1–8.
6. Report combined verdict.

Handles both cases:
- Asset signed by our production path with Scruple witness assertion → full
  end-to-end verification.
- Asset signed by another C2PA implementer (no Scruple witness) → C2PA-only
  verification.

### 4. `scruple-verify trust-manifest [--url URL]`

Fetches `https://scruple.stooges.ai/.well-known/witness-trust.json` (or the
`--url` override), validates the manifest's own signature against the
witness root pubkey (which is pinned into the CLI binary as a constant),
prints the currently-valid checkpoint keys + topologies + attestation
providers per topology.

Pinned root pubkey lives in `src/pinnedRoot.ts` — updated on witness root
key rotation via a new CLI release.

### 5. `--offline` mode

For `leaf` and `c2pa` subcommands, an `--offline` flag accepts pre-fetched
ledger responses on disk instead of network calls:

```
scruple-verify leaf leaf.json proof.json \
  --offline \
  --rvn-response ./rvn-tx.json \
  --arweave-response ./arweave.json \
  --ipfs-content ./epoch-proof.json
```

This is what the Rider §4 "Principal direct access" promises operationally
— an auditor can archive a proof bundle + ledger responses to a laptop and
verify with no internet.

### 6. Ergonomics

- Human output by default (with color if TTY).
- `--json` flag switches to structured JSON output for CI / piping.
- `--quiet` prints only the final verdict.
- `--verbose` prints intermediate hashes so a debugger can trace a failure.

### 7. Distribution

- npm package `@scruple/verify`.
- Publish workflow (`.github/workflows/publish-verify.yml`, gated to main
  branch tag pushes).
- README with the same worked example we'll use in the Sprint 1 demo
  script (WO-10).
- Homebrew tap for `brew install scruple-verify` (Sprint 3 nice-to-have,
  not blocking).

### 8. Reproducible fixtures

The `test/fixtures/` directory contains at least:

- `valid-sample-01/{leaf.json,proof.json,expected.txt}` — a signed leaf +
  proof bundle produced by a captured Sprint 1 run.
- `tampered-leaf-01/…` — a leaf whose `payload_hash` has been altered; CLI
  must return non-zero.
- `stale-checkpoint-01/…` — leaf against a checkpoint whose signature was
  produced by a rotated-out key; CLI must warn.
- `c2pa-external-01/…` — a Truepic-signed asset (from our interop test);
  CLI verifies C2PA layer only, cleanly reports no Scruple witness.
- `c2pa-with-witness-01/…` — a Scruple-signed asset with witness trail;
  full end-to-end verification succeeds.

Fixtures are re-generated by a `scripts/regen-verify-fixtures.mjs` script
in the main repo whenever the leaf or checkpoint canonicalization
changes (which requires a version bump per WO-05 discipline).

## What NOT to build

- Do not depend on the Scruple main repo at runtime. Standalone package.
- Do not embed any Scruple-internal API credentials in the CLI. Everything
  it fetches is public.
- Do not implement checkpoint SIGNING here — this is verify only.
- Do not build a GUI. CLI only.
- Do not require `c2patool` at runtime — c2pa-node is a Node dependency
  that comes with the package.
- Do not proceed past a signature failure to keep validating downstream —
  short-circuit and report the failure clearly.

## Deliverables

- `packages/scruple-verify/` full source tree per §1.
- Published to npm as `@scruple/verify@0.1.0`.
- Fixture library.
- README with worked example.
- CI job in the CLI's own package: runs the fixture tests on every push.

## Acceptance criteria

- [ ] `npx @scruple/verify c2pa docs/c2pa-interop/scruple-test-signed.png`
      returns "no Scruple witness trail" cleanly (that asset predates
      WO-08).
- [ ] After a Sprint 1 fresh sign with witness emit, `npx @scruple/verify
      c2pa <new-asset.png> --fetch-leaf` returns VALID and prints
      the leaf hash + checkpoint id + (once Sprint 2 anchors) the RVN txid.
- [ ] Tampered-leaf fixture returns FAIL with the failing step named.
- [ ] `--offline` mode with pre-fetched responses succeeds without any
      network egress (verified by running under network-restricted shell).
- [ ] `--json` output is valid JSON parseable by `jq`.
- [ ] The trust-manifest subcommand rejects a manifest whose signature
      doesn't match the pinned root pubkey.
- [ ] Fixture tests pass in the CLI's own CI.

## Related

- Canonical design §7 (Reference Verifier CLI)
- Canonical design §14 (non-compaction discipline — CLI is critical path)
- WO-05 — canonical leaf module we copy
- WO-07 — canonical checkpoint module we copy + trust manifest structure
- WO-08 — witness assertion in the C2PA JUMBF
- WO-10 — demo script uses this CLI as the verification step
- WO-13 (Sprint 2) — full proof API this CLI reads from
