# WO-07 — Checkpoint scheduler + balanced Merkle + Ed25519 signing + heartbeats

**Sprint:** 1
**Estimate:** 12 owner-hours
**Blocking:** WO-06 (leaves must exist to checkpoint), WO-01 (checkpoint
signing key in Vault)
**Blocks:** WO-08 (C2PA leaves need a checkpoint to be verifiable), WO-09
(verifier CLI walks inclusion proofs into these checkpoints), WO-12 (Sprint 2
super-root anchoring reads checkpoints)

## Goal

Stand up the per-stream checkpoint scheduler (Tier 1 of the three-tier
architecture). After this WO, every active stream produces a signed Merkle-root
checkpoint every `checkpoint_secs`, chained to its previous checkpoint,
with heartbeat checkpoints on quiet streams so absence-of-events is itself
evidence.

## What to build

### 1. Balanced Merkle module `lib/witness/merkle.ts`

Not the existing `lib/scruple/merkle.ts` for lock-Merkle — this one is
tuned for streams with up to 10^6 leaves per epoch and needs to return
inclusion paths cheaply.

```typescript
export interface MerkleTree {
  root: string;                // 64 hex
  depth: number;
  leaves: string[];            // sha256 hex, original order
  /** Return sibling path from leaf index to root, top-down. */
  inclusionPath(leafIndex: number): Array<{sibling: string; position: 'L'|'R'}>;
}

export function buildBalancedMerkle(leafHashes: string[]): MerkleTree {
  if (leafHashes.length === 0) throw new Error('empty leaf set');
  // Pad to next power of two by repeating the last leaf (documented
  // convention; matches c2patool's Merkle style).
  // Hash function: sha256(0x00 || left || right) for interior;
  // sha256(0x01 || leaf) for leaves — prevents second-preimage attacks.
  // ...
}
```

Use domain-separated hashes (`0x00` interior, `0x01` leaf) — standard RFC 6962
style. Document that verifiers must match this convention.

Unit-test with a Known-Answer fixture: 8 fixed leaves, hand-computed root,
plus verify each of the 8 inclusion paths recomputes the root.

Extend to 10^6 synthetic leaves + verify one random inclusion path recomputes
the root in <10 ms.

### 2. Vault Ed25519 signer wrapper `lib/witness/vaultCheckpointSign.ts`

Same shape as WO-03's `vault_sign.py` but for the checkpoint key + Ed25519
(or ECDSA fallback per §4.1 Vault-support caveat).

```typescript
import { KmsCryptoClient } from 'oci-sdk';   // or the equivalent Node OCI SDK
import { createHash } from 'crypto';

const KEY_ID = process.env.SCRUPLE_WITNESS_CHECKPOINT_KEY_OCID!;
const ENDPOINT = process.env.SCRUPLE_WITNESS_CHECKPOINT_CRYPTO_ENDPOINT!;
const ALG = (process.env.SCRUPLE_WITNESS_CHECKPOINT_ALG ?? 'ED25519') as 'ED25519' | 'ECDSA_SHA_256';

let client: KmsCryptoClient | null = null;
async function getClient() {
  if (!client) {
    client = new KmsCryptoClient({/* instance principal auth */}, { endpoint: ENDPOINT });
  }
  return client;
}

/** Sign the checkpoint bundle; return sig as hex. */
export async function signCheckpointBundle(bundleBytes: Buffer): Promise<string> {
  const c = await getClient();
  const resp = await c.sign({
    signDataDetails: {
      keyId: KEY_ID,
      message: bundleBytes.toString('base64'),
      messageType: 'RAW',
      signingAlgorithm: ALG,
    },
  });
  // Ed25519: 64-byte sig, no conversion needed.
  // ECDSA_SHA_256: DER — convert to raw R||S for parity with C2PA path.
  const sigBytes = Buffer.from(resp.signature, 'base64');
  if (ALG === 'ED25519') return sigBytes.toString('hex');
  const { r, s } = decodeDerEcdsa(sigBytes);
  return Buffer.concat([r, s]).toString('hex');
}
```

### 3. Canonical checkpoint bundle

Same discipline as canonicalLeafV23: fixed field order, compact JSON.

```typescript
// lib/witness/canonicalCheckpointV1.ts

const CKPT_V1_FIELD_ORDER = [
  'stream_id', 'epoch_index', 'first_seq', 'last_seq',
  'merkle_root', 'prev_checkpoint_id', 'is_heartbeat', 'created_at',
] as const;

export function canonicalCheckpointV1(bundle: CheckpointBundle): Buffer {
  const out: Record<string, unknown> = {};
  for (const k of CKPT_V1_FIELD_ORDER) {
    out[k] = bundle[k] ?? (k === 'is_heartbeat' ? false :
                          k === 'prev_checkpoint_id' ? '' :
                          k === 'first_seq' || k === 'last_seq' || k === 'epoch_index' ? 0 : '');
  }
  return Buffer.from(JSON.stringify(out), 'utf-8');
}
```

Ship a Python parallel `services/witness/canonical_checkpoint_v1.py` +
parity tests same as WO-05.

### 4. Scheduler `services/witness/checkpoint_scheduler.mjs`

Long-running Node process (not a Next.js route). Deploy as separate systemd
unit `scruple-witness-checkpoint.service`.

Uses BullMQ (already in the project's dep tree per existing worker patterns —
if not, add it). One repeatable job per active stream with the stream's
`checkpoint_secs` interval.

Per-tick per stream:

1. `BEGIN IMMEDIATE` transaction (SQLite writer lock).
2. Look up latest checkpoint for this stream:
   ```sql
   SELECT * FROM checkpoints WHERE stream_id=? ORDER BY epoch_index DESC LIMIT 1
   ```
3. Fetch leaves:
   ```sql
   SELECT tenant_seq, leaf_hash FROM log_leaves
   WHERE stream_id=? AND tenant_seq > ?
   ORDER BY tenant_seq
   ```
   with `?` = `last_checkpoint.last_seq` (or 0 if none).
4. **If empty**: heartbeat.
   - `merkle_root = sha256(prev_checkpoint.merkle_root)` (as hex; input is
     the raw prev-root bytes).
   - `is_heartbeat = true`
   - `first_seq = last_seq = last_checkpoint.last_seq`
   - Or: if there is no prior checkpoint AND no leaves, use
     `merkle_root = sha256(canonicalCheckpointV1({stream_id, epoch_index:1,
     first_seq:0, last_seq:0, merkle_root:'', prev_checkpoint_id:'',
     is_heartbeat:true, created_at:now}))` bootstrapping — document this
     in the verifier CLI.
5. **If non-empty**: real checkpoint.
   - Build balanced Merkle tree over leaf hashes in `tenant_seq` order.
   - Root = tree.root.
   - `is_heartbeat = false`
   - `first_seq = leaves[0].tenant_seq`, `last_seq = leaves[-1].tenant_seq`
6. Assemble canonical bundle, `sha256(bundle) → digest`.
7. Sign digest via `signCheckpointBundle(bundle)` — returns hex sig.
8. `checkpoint_id = 'CKP_' + sha256(merkle_root).slice(0,8)`.
9. INSERT into `checkpoints` with `witness_sig`, `witness_key_id`,
   `prev_checkpoint = previous checkpoint's id`, `anchored_in = NULL`.
10. COMMIT.
11. If `stream.tsa_mode != 'none'`: enqueue TSA-timestamp job (Sprint 2
    WO-11 handles the actual TSA client; Sprint 1 stub records
    `tsa_token_b64 = NULL` and logs "TSA pending" — non-blocking).

Failure handling:

- Vault Sign failure → log error, DO NOT commit checkpoint, retry on next
  tick. Vendor sees the checkpoint fall behind schedule; on-call sees the
  alert.
- SQLite BUSY / lock timeout → back off and retry.
- Non-monotone tick (e.g., NTP jump backwards) → skip that tick, log,
  continue.

### 5. systemd unit `scruple-witness-checkpoint.service`

Same hardening posture as WO-04's signer unit but under user `scruple-witness`
(new). Egress rules include the OCI Vault crypto endpoint.

### 6. Consistency verification helper

`lib/witness/consistency.ts`:

```typescript
/** Return true iff checkpoint B's tree is an append-only extension
 *  of checkpoint A's tree. Used by the future /v1/proof/consistency
 *  endpoint (Sprint 2 WO-13) and by the verifier CLI. */
export function verifyConsistency(a: Checkpoint, b: Checkpoint, proof: string[]): boolean;
```

Standard Merkle consistency proof; document the algorithm inline.
Ship the corresponding Python function too.

### 7. Trust manifest bootstrap

Publish the checkpoint pubkey to
`/.well-known/witness-trust.json` (Next.js route at
`app/.well-known/witness-trust.json/route.ts`). Content:

```json
{
  "version": 1,
  "witness_root": "scruple-witness-v1",
  "checkpoint_keys": [{
    "key_id": "scruple-witness-checkpoint-prod",
    "alg": "ED25519",
    "public_key_pem": "...",
    "activated_at": "2026-07-12T...",
    "deprecated_at": null
  }],
  "topologies": [{
    "id": "scruple-hosted-oci",
    "signer_public_key_pem": "...",
    "attestation_providers": ["rats-oci-scc","rats-scruple-ledger"],
    "activated_at": "..."
  }]
}
```

Signed itself by the witness root key (a separate Vault key — for Sprint 1,
this signature can be a placeholder that the verifier CLI accepts with a
warning; harden in Sprint 3 lifecycle work).

## What NOT to build

- Do not build the anchor (Tier 2) scheduler in this WO — that's WO-12.
- Do not build the TSA client — that's WO-11. Stub the tsa_token as NULL.
- Do not couple the scheduler to Next.js. Independent process; can be
  restarted without affecting web serving.
- Do not build the inclusion-proof HTTP endpoint here — that's WO-09's
  concern for the verifier and WO-13 for the principal API.
- Do not do work inside the ingest write path. Everything Merkle happens
  in this scheduler.

## Deliverables

- `lib/witness/merkle.ts` + Python parallel
- `lib/witness/canonicalCheckpointV1.ts` + Python parallel + parity tests
- `lib/witness/vaultCheckpointSign.ts`
- `services/witness/checkpoint_scheduler.mjs`
- `deploy/systemd/scruple-witness-checkpoint.service`
- `app/.well-known/witness-trust.json/route.ts`
- `lib/witness/consistency.ts` + Python parallel
- Integration tests:
  - 10^6 synthetic leaves in one epoch: Merkle build + root; random inclusion
    path recomputes.
  - Empty stream produces a heartbeat checkpoint.
  - Two consecutive checkpoints on a live stream: `b.prev_checkpoint == a.id`.
  - Consistency proof verifies for a chain of 5 sequential checkpoints.
  - Vault Sign failure → no checkpoint row inserted; retried next tick.
  - Bootstrap: fresh stream, first tick produces `epoch_index=1` correctly.

## Acceptance criteria

- [ ] `systemctl status scruple-witness-checkpoint` shows active.
- [ ] For a test stream at `checkpoint_secs=60`, checkpoints appear
      every ~60s ±5s regardless of leaf volume.
- [ ] Heartbeat checkpoint appears when no leaves arrived in the interval.
- [ ] `prev_checkpoint` chain is intact when queried:
      `SELECT COUNT(*) FROM checkpoints c JOIN checkpoints p
       ON c.prev_checkpoint=p.checkpoint_id
       WHERE c.stream_id=? AND c.epoch_index > 1;`
      equals `MAX(epoch_index) - 1`.
- [ ] Parity tests (TypeScript vs Python) on canonical checkpoint bundle
      pass byte-identical.
- [ ] `curl -s https://scruple.stooges.ai/.well-known/witness-trust.json`
      returns the manifest, `Content-Type: application/json`.
- [ ] Consistency proof verifier passes for 5-checkpoint synthetic chain.

## Related

- Canonical design §6.4 (Checkpoint service Tier 1)
- Canonical design §16.3 (Satellite invariant — checkpoint scheduler always
  runs on OCI, never on satellites)
- WO-05 — schema
- WO-06 — writes what this reads
- WO-11 (Sprint 2) — plugs in TSA tokens
- WO-12 (Sprint 2) — reads unanchored checkpoints for super-root
