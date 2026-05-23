# Scruple Web — Changelog

Format: per-release version + protocol bumps + commit summary. The
**leaf protocol** is the canonical record schema the witness server
hashes; bumping it is a protocol change that older receipts can still
verify against (the audit script's record_hash_v2x fallbacks handle
cross-version reproduction).

## v2.1.0 — 2026-05-23 — Model fingerprinting + identity-gated dev + paid lock countersignature

**Leaf protocol: v2.1** (was v2.0).
v2.1 canonical record:
```
{ run_sequence, output_hash, input_hash, workflow_hash,
  model_fingerprints_hash,
  server_timestamp, prev_record_hash }
leaf = sha256(canonical(record))
```
v2.0 leaves remain verifiable; the audit script tries v2.1 first, then v2.0.

**Witness server: 2 patches.** Both with `.bak` + PATCH_NOTES per convention.

### Threat-vector closures shipped

| ID | What it closes |
|----|----|
| T3 | Input → output binding folded into the anchored Merkle leaf (was operator-mutable in local DB only) |
| T4 | Async ingest now binds the producing workflow into `input_hash` + `workflow_hash` (was a regression I'd introduced) |
| T7 | `prev_record_hash` chains witness records; deletion/reorder breaks the chain |
| T11 (partial) | `model_fingerprints_hash` binds the exact weight bytes the runner loaded — not just the filename the workflow asked for |
| (separate) | Lock event itself now witness-countersigned for checkpoint + local lock (was only chain lock) |

**Deferred:** T1/T2 (TEE attestation), T5 (Ed25519 — desktop-only concern, doesn't apply to web), M-2 (hash-on-upload for `fetch_to_volume`).

### Commits

| Commit | Title | Domain |
|---|---|---|
| `25433e3` | CAP-6: fix checkpoint/training capture — break poll on completion, not /view outputs | Runner |
| `ab80697` | Witness v2: full-record leaf — RVN anchor now commits inputs + workflow + order + time | Protocol |
| `e95bba9` | Provenance receipt: surface full v2 spectrum + lock audit logs | Receipt |
| `a03372d` | Receipt + audit: full-spectrum audit script + canonicalization UTF-8 note | Audit |
| `ddb059f` | Persistent chain lock: wire wallet pinned tier (IPFS+Arweave) + 8-hex receipt regex + extended audit | Lock |
| `5251f7c` | Model fingerprinting: in-container hash-at-load — v2.1 leaf binds the actual weights | Protocol |
| `6fe2571` | Identity-gated dev + paid lock countersignature: kill the dev bypass | Auth + Lock |

### Schema (migrations 015–018)

| Migration | Table | Columns added |
|---|---|---|
| 015 | `generation_jobs` | `run_inputs`, `run_output_kind`, `run_prompt`, `run_workflow` (async run path) |
| 016 | `iterations` | `workflow_hash`, `leaf_scheme` (v1/v2) |
| 017 | `iterations` | `model_fingerprints` (JSON manifest), `model_fingerprints_hash` |
| 018 | `projects` | `lock_server_signature`, `lock_locked_at_witnessed` |

**Witness DB** (`/opt/scruple-witness/witness.db`) ALTERs applied in-band per patch:
- `witnesses` gained `input_hash`, `workflow_hash`, `prev_record_hash`, `leaf_hash`, `leaf_scheme`, `model_fingerprints_hash`.

### Code-level changes

**Runner (`modal/scruple_runner.py`):**
- `_tail_comfy_log()` — error/timeout returns now include ComfyUI log tail (instrumentation that was missing during CAP-6 dig).
- Poll loop breaks on `status.completed`/`status_str=='success'`, not just `outputs` presence. Terminal nodes (`SaveLoRA`, `TrainLoraNode`, `CheckpointSave`) register no `/view` output; the old check spun the full 1700s timeout on every checkpoint workflow. The single bug masqueraded as GPU preemption, slow training, step count, and queue contention for the whole CAP-6 investigation.
- `RUN_GPU` constant — separate from `GPU` so heavy `run_workflow` can use A10G while warm/ping functions stay on cheap T4.
- `MODEL_LOADERS` registry + `_hash_workflow_models()` + `_fingerprint_file()` — walks workflow for known loader-node inputs (Checkpoint/Lora/VAE/UNET/CLIP/Dual/Triple/ControlNet/Style/GLIGEN/Upscale), hashes each file on the volume (chunked sha256 + safetensors header), returns manifest. Cached by `(path, mtime_ns, size)` so canonical bases hash once per warm container.

**Web (`/data/scruple-web/`):**
- `lib/auth/auth.ts` — `signIn` callback gates on `SCRUPLE_ALLOWED_EMAILS`.
- `lib/iterations/ingest.ts` — restructured for v2: witness BEFORE insert, `model_fingerprints_hash` computed and folded into the leaf preimage; storage paths decoupled from leaf_hash (output_hash for content addressing, leaf_hash for Merkle identity).
- `lib/scruple/witness.ts` — `WitnessIterationInput` gains `inputHash`, `workflowHash`, `modelFingerprintsHash`; `lockProject` accepts `tier`; `ConfirmAndExecuteResult` exposes `serverSignature`/`merkleRoot`/`witnessedCount`/`ipfsCid`/`arweaveTxId`.
- `lib/runs/execute.ts` — async `pollRunJob` threads `run_workflow` into spec.providerExtras; both paths pass `modelFingerprints` to ingest.
- `lib/compute/{backends,modal}.ts` — `ComputeResult` + `ModalResponse` gain `modelFingerprints`.
- `app/api/lock/checkpoint/route.ts`, `app/api/lock/local/route.ts` — payment required; witness called for every lock; countersignature persisted.
- `app/api/lock/chain/route.ts` — wallet path now forwards `tier` to witness and captures `ipfs_cid` + `arweave_uri` from the wallet response (was Stripe-path-only).
- `app/api/stripe/payment-intent/route.ts` — drops the `sw:<userId>:<id>` namespacing so the witness's anti-tamper check on `confirmAndExecute` round-trips correctly (this bug had silently broken the Stripe-paid chain-lock path for everyone — only wallet-mode worked).
- `app/receipt/[scrId]/page.tsx` — full v2.1 spectrum per iteration card (leaf/output/input/workflow/models row, model-files block with content+header hashes per file, input-artifacts list), verification recipe section walking outsiders through reproduction, lock countersignature section.
- `components/ActiveProjectBanner.tsx` — image src switched from `leaf_hash` to `output_hash` (leaf_hash is no longer the storage key in v2).
- `lib/db/migrations/{015,016,017,018}.sql` — schema additions documented above.

**Witness server (`/opt/scruple-witness/server.js`):**
- `canonicalRecord` — adds `model_fingerprints_hash` between `workflow_hash` and `server_timestamp`.
- `handleWitness` — accepts new v2 fields; chains `prev_record_hash` from this project's most recent witness leaf; `[WITNESS]` log line shows `mf=<8>`, `wf=<8>`, `in=<8>`, `prev=<8>` flags.
- `handleConfirmAndExecute` — both finalize AND checkpoint compute `lockData = { project_id, action, merkle_root, witnessed_count, locked_at }`, sign it (action in tuple → no replay across actions), return `serverSignature`.
- `handleLock` — already returned IPFS/Arweave anchors; now reached from the web wallet path too.
- New `/api/admin/confirm-pi` — loopback-only, drives `stripe.paymentIntents.confirm` with `pm_card_visa` for CLI test harness.

**Scripts:**
- `scripts/audit-receipts.py` — independent re-derivation of every hash + Merkle root + per-step audit. Tries v2.1 leaf first, falls back to v2.0. **331/331 across 12 projects** at end of session.
- `scripts/stripe-test-pay.mjs` — sandbox PaymentIntent + confirm helper.
- `scripts/scruple-run.ts --lock <action>` — one CLI invocation: capture → test-pay → lock.

### Architecture decisions made this session

1. **Receipt protocol versioning is forward-compatible.** v2.1 adds `model_fingerprints_hash` between `workflow_hash` and `server_timestamp`. Verifiers must try schema versions in order; old receipts stay valid.
2. **Desktop divergence accepted.** Web-only v2 rollout; desktop still emits v1 leaves. Reconcile when desktop is next touched.
3. **HMAC stays; T5 (Ed25519) not a web concern.** HMAC was a desktop anti-user-spoof; in web the witness is server-side, users can't reach the secret, server auth gates writes, and the public verifier is the RVN mint wallet — already asymmetric by virtue of being on-chain.
4. **Dev is identity, not code path.** One codebase against sandbox endpoints (sk_test, RVN testnet, arlocal, Kubo); `SCRUPLE_ALLOWED_EMAILS` gates which Google accounts can sign in on a given deployment. No bypass branches anywhere.

### Honest caveats remaining

- **TEE attestation (T1/T2)** — deferred. Without it, a compromised Modal container could substitute output bytes; the pipeline would faithfully hash + witness the substitution. Hardware attestation closes this; requires H100 CC deploy.
- **M-2 hash-on-upload** — `fetch_to_volume` doesn't yet hash + register the bytes on write. So a user who uploads a malicious model AND runs it immediately gets the malicious hash recorded (which is honest; later verifiers check it against canonical hashes). Add a hash step + canonical-catalog registry to flag mismatches at upload time.
- **Volume canonical hashes** — our copy of `v1-5-pruned-emaonly.safetensors` (sha256 `6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa`) differs from HuggingFace's official (`cc6cb27103…`). The system is honest about exactly what's there; whether to investigate or replace the volume copy is a product decision.
- **Login gate is one-tier today.** `SCRUPLE_ALLOWED_EMAILS` is a single whitelist. Future tiers (free / paying / admin) would need a policy layer.

## v2.0.0 — 2026-05-22 — Full-record leaf

**Leaf protocol: v2.0** (was v1: `leaf_hash == output_hash`).

Folded `input_hash + workflow_hash + prev_record_hash` into the canonical record so the RVN-anchored Merkle root commits the full provenance package, not just outputs. Closed T3/T7. See commit `ab80697` and `docs/sessions/2026-05-22.md` for the diagnostic arc that led here.

## v1.x — pre-2026-05-22

`leaf_hash == output_hash`. Per-iteration HMAC witness, sorted-pair Merkle, RVN testnet anchor + IPFS pin + Arweave token record at chain-lock time. Foundation work referenced in MEMORY.md (`project_storage_migration_shipped`, `project_scruple_witness_merkle`, `project_scruple_web_shipped`).
