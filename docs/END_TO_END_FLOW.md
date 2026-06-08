# Scruple Web — End-to-End Flow

> Linear narrative trace of one full user journey. Shows every system
> touched, every hash computed, every external call, and what gets
> persisted where, in the order it happens.
>
> Companion to `docs/CANONICAL_GUIDE.md` (which is by-component reference).
> This one is by-time-and-data-flow. Read this when you need to *follow* a
> request through the whole stack.
>
> Last updated: 2026-06-08. Leaf protocol v2.1. Branch `feature/pivot`.

---

## The Actors

In dependency order — top calls bottom, not vice versa.

| Layer | Actor | Where | Role |
|---|---|---|---|
| 0 | **Browser** | user's device | renders the UI, holds the session cookie, the Stripe Elements modal |
| 1 | **Scruple Web** | Next.js, `:3001` | orchestrator. Owns the iteration/project state, calls every other layer. |
| 2 | **Witness Server** | Node, `:5799`, `/opt/scruple-witness/` | independent signer. Holds the HMAC secret. Calls Stripe, RVN, IPFS, Arweave. |
| 3 | **Modal Runner** | Python, Modal Labs | executes ComfyUI workflows on GPU. Hashes loaded model files. |
| 3 | **Storage Provider** | Drive / OneDrive / GitHub / local FS | holds the user's content (inputs + outputs). One per account. |
| 4 | **ComfyUI** | inside Modal container | actual model inference / training |
| 4 | **Stripe** | api.stripe.com (sandbox/live) | payment verification for lock actions |
| 4 | **RVN testnet** | `raven-cli` | mints the SCR-ID as an asset; immutable public timestamp |
| 4 | **IPFS** | Kubo `:5001` (dev) | content-pins the proof record (pinned tier) |
| 4 | **Arweave** | `arlocal :1984` (dev) | permanent token-record entry (basic + pinned tier) |

Web is the only thing the user's browser talks to. Web orchestrates everything else.

---

## Phase 0 — Static Setup (one-time per deployment)

Before a user ever opens the app:

1. **Web is deployed.** `feature/pivot` branch built; `data/scruple.db` migrated to schema 018; `.env.local` has `SCRUPLE_ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID/SECRET`, `NEXTAUTH_URL`, `WITNESS_SERVER_URL`, `MODAL_RUNNER_ENDPOINT`.
2. **Witness server is running.** `/opt/scruple-witness/` systemd unit `scruple-witness.service` active. `witness.db` migrated. `SCRUPLE_WITNESS_SECRET`, `STRIPE_SECRET_KEY=sk_test_*`, `STRIPE_PUBLISHABLE_KEY=pk_test_*` in env. RVN wallet funded on testnet. arlocal funded. Kubo running.
3. **Modal runner deployed.** `modal/scruple_runner.py` → `scruple-runner` app. Volume `scruple-models` mounted; base models pre-fetched (SDXL, SD1.5, LTX-Video, etc.) via `fetch_to_volume`. `RUN_GPU=A10G`.

All endpoints point to **sandbox** copies. Same code paths run against `sk_live_*` / RVN mainnet / Arweave mainnet in production.

---

## Phase 1 — Sign In

User opens `https://scruple.stooges.ai/login`.

### 1.1 Browser → Web
```
GET /login
```
Web's `app/login/page.tsx` renders. Server component checks `auth()` — no session — returns the "Sign in with Google" form. The form has a `'use server'` action bound to `signIn('google', { redirectTo: '/' })`.

### 1.2 User clicks button
```
POST /login    (server action invocation, with Next-Action header)
```
NextAuth's `signIn('google', ...)` writes CSRF + state cookies, returns a 302 to Google's OAuth consent screen.

### 1.3 Browser → Google → Browser → Web
User consents; Google redirects to:
```
GET /api/auth/callback/google?code=<oauth_code>&state=<csrf>
```
NextAuth exchanges the code for tokens, fetches the userinfo, calls the **`signIn` callback in `lib/auth/auth.ts`**:

```ts
if (!ALLOWED_EMAILS.includes(user.email.toLowerCase())) {
  console.warn('[auth] rejected signin for ...')
  return false   // → user bounced back to /login
}
return true
```

If allowed: NextAuth's `SqliteAdapter` (`lib/auth/db-adapter.ts`) upserts a `users` row and inserts a `sessions` row with a fresh 32-byte token + 30-day expiry. The token is set as the `__Secure-authjs.session-token` cookie. Redirect to `/`.

### 1.4 Subsequent requests
Every subsequent request carries the cookie. `auth()` server-side looks up the session token in `sessions`, joins to `users`, returns `{user: {id, email, name}}`. The `user.id` is the stable identifier used for everything else.

---

## Phase 2 — Setup a Project

### 2.1 Optional: connect storage provider
User goes to Settings → connects Google Drive (or OneDrive / GitHub). NextAuth OAuth flow for the provider runs; the access+refresh tokens land encrypted in `user_settings` via `lib/auth/encryption.ts`. The chosen provider goes into `storage_settings`. From now on, every artifact upload writes to that provider.

If no provider is connected, web falls back to local FS (`lib/scruple/artifacts.storeArtifact` → `/data/scruple-web/artifacts/`). Receipts and `/api/artifact/[hash]` work from there too.

### 2.2 Create the project
```
POST /api/projects   { name: "...", type: "image" | "video" | "training" }
```
`app/api/projects/route.ts` inserts a row into `projects` with `status='unlocked'`, `user_id=<the dev user>`, etc. Returns the new project id.

---

## Phase 3 — Capture One Iteration

This is the core: one workflow, end-to-end, every hash, every system. Followed step-by-step for an **img2img run on Modal**.

### 3.1 User provides a run spec
Either:
- **Browser canvas** — user designs a ComfyUI graph, points it at an input image stored in their Drive.
- **CC dev pipeline** — `scripts/scruple-run.ts <spec.json>` reads a JSON spec like:

```json
{
  "projectId": 19,
  "async": true,
  "outputKind": "image",
  "prompt": "v2 suite img2img test",
  "workflowApiJson": { ... ComfyUI graph ... },
  "inputs": [
    { "kind": "init_image", "filename": "init.png", "iterationHash": "9274b9b5..." }
  ]
}
```

The `inputs[]` carry **references**, not bytes. Web resolves each to bytes server-side.

### 3.2 Web resolves input bytes
`lib/runs/inputs.ts` `resolveInput()`:

```
For each input spec:
  inlineBase64?     → decode → bytes
  localPath?        → fs.readFileSync(path)
  iterationHash?    → readArtifact(hash) from local artifact store
  storagePointer?   → provider.readFile(userId, pointer)   ← pulls from Drive/OneDrive/etc.
```

**Each input's bytes now live in web server memory.** Atomically with reading, sha256 is taken (later in ingest). This is the trust boundary: web is responsible for the integrity of bytes from this point onward.

### 3.3 Web ships to Modal
For async runs:
```
POST /api/runs?async=1   { projectId, workflowApiJson, inputs, outputKind, prompt }
  → lib/runs/execute.ts executeRunAsync()
  → modal.spawnWorkflow(workflowApiJson, runnerInputs)
  → Modal returns a callId
  → INSERT INTO generation_jobs (id, modal_call_id, run_inputs, run_workflow, ...) VALUES (...)
  → returns 202 { jobId, callId }
```

`runnerInputs` are `[{filename, bytes_b64}]` — the resolved bytes base64-encoded. Spec persisted in `generation_jobs` so `pollRunJob` can re-resolve later.

### 3.4 Modal container boots ComfyUI
First call to `run_workflow` cold-starts a container (~90s on A10G; cached on warm). Inside the container:
- `_start_comfy()` boots ComfyUI on `127.0.0.1:8188`.
- Bytes from `inputs[]` are written to `/opt/ComfyUI/input/<filename>` (relative subfolders allowed for training datasets).

### 3.5 Modal hashes every model the workflow will load — **v2.1 model fingerprinting**
Before queueing the prompt, `_hash_workflow_models(workflow)` walks the workflow JSON for known loader nodes (CheckpointLoaderSimple, LoraLoader, VAELoader, UNETLoader, CLIPLoader/Dual/Triple, ControlNetLoader, StyleModelLoader, GLIGENLoader, UpscaleModelLoader). For each referenced filename:

```python
full = "/opt/ComfyUI/models/<subdir>/<filename>"
content_hash = sha256(file bytes)             # chunked, 1 MiB at a time
header_hash, header_size = sha256(safetensors header)
manifest[<subdir/filename>] = { content_hash, header_hash, header_size, bytes, mtime }
```

Result is a manifest like:
```python
{
  "checkpoints/v1-5-pruned-emaonly.safetensors": {
    "content_hash": "6ce0161689b3...",
    "header_hash":  "ed6e1a1f33ba...",
    "bytes": 4265146304,
    ...
  },
  "loras/myStyle.safetensors": { ... }
}
```

Cached by `(path, mtime_ns, size)` — canonical bases hash once per warm container; subsequent runs reuse.

### 3.6 Modal submits the prompt to ComfyUI
```
POST 127.0.0.1:8188/prompt   { prompt: workflowApiJson }   → { prompt_id }
```
Then polls `/history/<prompt_id>` until `status.completed`. Per the bug fix in `25433e3`, the break condition is `status_str == 'success'` — NOT `outputs` presence. Terminal nodes (SaveLoRA, CheckpointSave) write to disk without registering `/view` outputs; the old code spun for 1700s.

ComfyUI executes the graph: loads model files (which we just hashed), runs samplers, decodes, writes outputs.

### 3.7 Modal collects the output
- **Image / video** → fetch via `GET /view?filename=<fn>&subfolder=&type=output` → bytes.
- **Checkpoint / LoRA** → snapshot-diff `/opt/ComfyUI/models/loras/` (and `/output/`) for new `.safetensors`, read the freshest.

Output bytes get base64-encoded. Return payload:
```python
{
  "ok": True,
  "image_bytes_b64": "...",
  "content_type": "image/png" | "video/webm" | "application/octet-stream",
  "output_kind": "image" | "video" | "checkpoint",
  "output_filename": "...",
  "prompt_id": "...",
  "duration_ms": 39000,
  "gpu": "A10G",
  "attestation": None,
  "model_fingerprints": { ...the manifest from 3.5... }
}
```

### 3.8 Web polls and ingests
`/api/runs/status?jobId=<id>` → `pollRunJob()` calls `getWorkflowStatus(callId)`:
- If still running → `{status: 'running'}` → browser keeps polling.
- If failed → mark `generation_jobs.status='failed'`, return error.
- If done → re-resolve the inputs (same bytes — content-addressed), call `ingestIteration()`.

### 3.9 ingestIteration — every hash that goes into the leaf
`lib/iterations/ingest.ts` is the provenance heart. Walk through it line by line for one iteration:

#### 3.9.1 — output_hash
```ts
const outputHash = sha256Hex(p.imageBytes)
```
Hash of the runner's returned bytes. This is what `/api/artifact/[hash]` will serve.

#### 3.9.2 — Per-input artifact hash + manifest
```ts
for (const inp of p.inputs ?? []) {
  const hash = sha256Hex(inp.bytes)              // hash of THIS input file
  storeArtifact(hash, inp.bytes)                 // local FS cache
  if (provider) {
    pointer = await provider.uploadFile(userId, `inputs/${hash.slice(0,12)}.${ext}`, inp.bytes, ...)
  }
  inputArtifacts.push({ kind, hash, filename, content_type, bytes, storage_pointer: pointer })
}
```
Each input file's bytes are hashed, locally cached, optionally uploaded to user storage, and their record appended to the manifest persisted on the iteration row.

#### 3.9.3 — input_hash
```ts
const inputCanonical = JSON.stringify({
  provider: 'comfydeploy',
  prompt: p.prompt,
  spec: p.spec,                                       // includes providerExtras.workflowApiJson
  inputs: inputArtifacts.map(a => ({ kind: a.kind, hash: a.hash })),
})
const inputHash = sha256Hex(inputCanonical)
```
Binds the request: who ran it, what they asked for, what spec, what inputs (by their content hash).

#### 3.9.4 — workflow_hash
```ts
const wf = p.spec.providerExtras?.workflowApiJson
let workflowHash = null
if (wf) workflowHash = sha256Hex(JSON.stringify(wf))
```
Binds the ComfyUI graph that produced the output.

#### 3.9.5 — model_fingerprints_hash
```ts
const sortedKeys = Object.keys(p.modelFingerprints).sort()
const canonical = Object.fromEntries(sortedKeys.map(k => [k, p.modelFingerprints[k]]))
modelFingerprintsHash = sha256Hex(JSON.stringify(canonical))
```
Binds the actual weight bytes the runner loaded (v2.1). Manifest is persisted in `iterations.model_fingerprints`, hash in `iterations.model_fingerprints_hash`, and folded into the v2.1 record below.

#### 3.9.6 — Upload output to user storage
```ts
storagePointer = await provider.uploadFile(userId, `iterations/${outputHash.slice(0,12)}.${ext}`, p.imageBytes, ...)
storeArtifact(outputHash, p.imageBytes)   // local cache, content-addressed
```
Storage path is keyed by `output_hash` (content-addressed by the actual bytes), NOT by `leaf_hash` (which is now the record hash).

#### 3.9.7 — Allocate run_sequence + look up project name
```ts
const next = (SELECT COALESCE(MAX(run_sequence),0) + 1 FROM iterations WHERE project_id = ?).n
const projectRow = SELECT name FROM projects WHERE id = ?
```

### 3.10 Web → Witness Server (POST /api/witness)
```ts
await witness.witnessIteration({
  projectId: String(p.projectId),
  projectName: projectRow.name,
  runSequence: next,
  contentHash: outputHash,         // → witness "content_hash"
  inputHash,
  workflowHash,
  modelFingerprintsHash,
})
```

`lib/scruple/witness.ts` POSTs `http://127.0.0.1:5799/api/witness` with:
```json
{
  "project_id": "19",
  "project_name": "v2-image-suite",
  "run_sequence": 1,
  "content_hash": "<output_hash>",
  "input_hash": "<input_hash>",
  "workflow_hash": "<workflow_hash>",
  "model_fingerprints_hash": "<mf_hash>",
  "client_timestamp": "..."
}
```

### 3.11 Witness Server — handleWitness
`/opt/scruple-witness/server.js handleWitness()`:

#### 3.11.1 — Lock check
```js
locked = SELECT 1 FROM locked_projects WHERE project_id = ?
if (locked) return 403 'Project is locked, no new iterations allowed'
```

#### 3.11.2 — Look up previous leaf (chains the log)
```js
prevRow = SELECT leaf_hash FROM witnesses WHERE project_id = ? ORDER BY run_sequence DESC LIMIT 1
prev_record_hash = prevRow?.leaf_hash ?? ''
```

#### 3.11.3 — Build canonical v2.1 record
```js
record = {
  run_sequence:            <seq>,
  output_hash:             <content_hash>,
  input_hash:              <input_hash>,
  workflow_hash:           <workflow_hash>,
  model_fingerprints_hash: <mf_hash>,
  server_timestamp:        new Date().toISOString(),
  prev_record_hash:        <prev>,
}
canonical = JSON.stringify(record)           // compact, fixed-order, raw UTF-8
leaf_hash = sha256(canonical)
```

**The byte layout is the protocol.** Any verifier reproducing this must match Node's `JSON.stringify` byte-for-byte: compact, insertion-order, raw UTF-8 (not `\uXXXX`). The audit script uses `json.dumps(obj, separators=(',',':'), ensure_ascii=False)`.

#### 3.11.4 — HMAC sign
```js
signature = HMAC-SHA256(SECRET, leaf_hash)
```
Scruple's per-record seal. Symmetric; verifying requires SECRET (or Scruple's published verifier). The public verifier is later, at chain-lock time, via the RVN mint wallet.

#### 3.11.5 — Persist
```sql
INSERT INTO witnesses (
  witness_id, project_id, project_name, run_sequence, content_hash,
  visual_hash, client_timestamp, server_timestamp, signature,
  input_hash, workflow_hash, prev_record_hash, leaf_hash, leaf_scheme,
  model_fingerprints_hash
) VALUES (...)
```

#### 3.11.6 — Log + return
```
[WITNESS] v2-image-suite #1 → wit_abc... (v2 leaf 0612aa23... · in=fb6f3167 · wf=329c4900 · mf=592c8587 · prev=∅)
→ { witness_id, server_timestamp, signature, leaf_hash, prev_record_hash, leaf_scheme: 'v2' }
```

### 3.12 Web persists the iteration
Back in `ingestIteration()`:
```ts
leafHash = witnessResult.leaf_hash       // <-- THIS is what gets Merkled later
leafScheme = witnessResult.leaf_scheme

INSERT INTO iterations (
  project_id, run_sequence, timestamp, leaf_hash, input_hash, output_hash,
  previous_hash, metadata, source_file, image_filename, prompt, provider, provider_job_id,
  execution_backend, execution_attestation, storage_pointer,
  output_kind, output_content_type, output_bytes, input_artifacts,
  workflow_hash, leaf_scheme,
  model_fingerprints, model_fingerprints_hash,
  witnessed, witness_id, witness_timestamp, witness_signature
) VALUES (...)

UPDATE projects SET iteration_count = iteration_count + 1, witnessed_count = witnessed_count + 1
```

### 3.13 What lives where after one capture

| Store | Row | Key contents |
|---|---|---|
| Web `iterations` | one row | leaf_hash + output_hash + input_hash + workflow_hash + model_fingerprints_hash + leaf_scheme + storage_pointer + witness_id + witness_signature + full input_artifacts manifest + model_fingerprints manifest |
| Witness `witnesses` | one row | Same hashes (independent copy) + server_timestamp + prev_record_hash + signature |
| Local artifact FS | output bytes + input bytes | Content-addressed by their own sha256 |
| User storage (Drive) | output file + input files | Uploaded to `iterations/<hash>.<ext>` and `inputs/<hash>.<ext>` |
| Modal volume | model files (untouched) | Hashes recorded in iteration row; bytes stay on volume |

**Two independent storage systems (web + witness DB) hold the same record, both signed.** This is what "the iteration is witnessed" means.

---

## Phase 4 — Lock the Project

Three options (state machine: `unlocked → checkpointed → terminal {local_locked | chain_locked | persistent_locked}`).

### 4.1 Browser: Create PaymentIntent
```
POST /api/stripe/payment-intent    { action: "finalize" | "checkpoint" | "chain-lock-basic" | "chain-lock-pinned", projectId: 19 }
  → forwards to witness /api/create-payment-intent (bare projectId, NOT namespaced — that bug bit us)
  → witness server uses STRIPE_SECRET_KEY to stripe.paymentIntents.create({ amount, currency, metadata: { action, projectId, ... } })
  → returns { paymentIntentId, clientSecret, amountCents }
```

### 4.2 Browser: Confirm payment
- **In the browser:** Stripe Elements collects card details, confirms client-side. Test card `4242 4242 4242 4242` in sandbox.
- **From CLI:** `scripts/stripe-test-pay.mjs` → `POST witness/api/admin/confirm-pi { paymentIntentId, paymentMethod: "pm_card_visa" }` → witness calls `stripe.paymentIntents.confirm(id, { payment_method, return_url })`. Status → `succeeded`.

### 4.3 Browser → Web: Trigger lock
```
POST /api/lock/local    { projectId: 19, paymentIntentId: "pi_..." }
```

Web: `app/api/lock/local/route.ts`:
1. Verify project ownership + state (must be `unlocked` or `checkpointed`).
2. Pull all `iterations WHERE project_id = ? ORDER BY run_sequence ASC`.
3. **Build Merkle tree over `iteration.leaf_hash` values** (`lib/scruple/merkle.ts buildMerkle()`):
   ```
   sorted-pair: combined = a < b ? a + b : b + a
                next = sha256(combined)
   pad odd levels by duplicating last
   single leaf → root = that leaf (depth 0)
   ```
4. **Derive SCR-ID:** `deriveScrId(merkleRoot, false)` → `SCR_<first 6 hex of merkleRoot, uppercased>` for local lock. (Chain lock uses 8 hex via witness; receipt regex accepts both.)

### 4.4 Web → Witness: confirmAndExecute
```
POST witness/api/confirm-and-execute  {
  action: "finalize",
  projectId: "19",
  paymentIntentId: "pi_...",
  merkleRoot: <local Merkle root>,
  preScrId: <local SCR-ID>
}
```

Witness `handleConfirmAndExecute()`:
1. `stripe.paymentIntents.retrieve(paymentIntentId)` — re-fetches the PI.
2. Verify `status === 'succeeded'`.
3. Verify `metadata.action === action`.
4. Verify `metadata.projectId === projectId` ← (the bug we fixed: namespacing here would break the round-trip).
5. Verify `amount === expectedCents` for that action.
6. For `finalize` + `checkpoint`:
   - Pull all witnesses for this project from witness DB.
   - Recompute the Merkle root from the witness's own copy.
   - Build `lockData = { project_id, action, merkle_root, witnessed_count, locked_at }`.
   - `serverSignature = sign(lockData)` — **action is in the tuple, so a checkpoint sig can't be replayed as a finalize sig.**
   - For finalize: `INSERT INTO locked_projects (project_id, merkle_root, witnessed_count, server_signature, locked_at)`.
   - For checkpoint: signed but NOT persisted (project remains open).
   - Insert a `tsd_auth_tokens` row for the Stripe payment audit trail.
7. Returns `{ success, action, lockedAt, merkleRoot, witnessedCount, serverSignature }`.

### 4.5 Web persists the lock state
```ts
UPDATE projects SET
  status = 'local_locked',
  merkle_root = ?,
  scr_id = ?,
  lock_server_signature = ?,        // witness countersignature
  lock_locked_at_witnessed = ?,     // witness timestamp
  locked_at = ?,
  updated_at = ?,
  is_active = 0
WHERE id = ?

DELETE FROM merkle_nodes WHERE project_id = ?
INSERT INTO merkle_nodes (level, position, hash, left_child_hash, right_child_hash) ...
```

Local lock is now persisted on both sides. Receipt at `/receipt/<SCR-ID>` renders.

### 4.6 (Optional) Chain Lock — RVN + Arweave + IPFS

If the user wants their project anchored on a public chain, separate route:

```
POST /api/lock/chain   { projectId, paymentIntentId, tier: "basic" | "pinned" }
```

(There's also a **wallet** non-custodial path that skips Stripe: `witness.lockProject(projectId, merkleRoot, tier)`. Same downstream effect.)

Web → `witness.confirmAndExecute({action: "chain-lock-pinned", ...})`. Witness:

1. Verifies Stripe PI (~$65 for pinned, $50 for basic).
2. Computes the SCR-ID: `'SCR_' + sha256(merkleRoot)[:8].toUpperCase()` (8 hex).
3. **RVN mint** — `testnet-locker.issueAsset(scrId, null)`:
   - Calls `raven-cli issue <scrId> 1` against the testnet wallet.
   - Returns a txid. SCR-ID becomes a real RVN asset, name = SCR-ID.
4. **`anchorPermanence(...)`**:
   - **Arweave** (basic + pinned): builds a JSON token record `{ type, version, scrId, merkleRoot, rvnTxId, witnessedCount, lockedAt, witnessSignature }` and posts to `arlocal :1984` (dev) / Arweave mainnet (prod).
   - **IPFS** (pinned only): same record posted to Kubo `:5001`, returns a CID. The Arweave record for pinned includes the IPFS CID.
5. Builds and signs lockData; persists `locked_projects` row with the server signature.
6. Returns `{ success, scrId, proofTxId, proofChain: 'rvn-testnet', mintError, lockTier, ipfsCid, ipfsError, arweaveTxId, arweaveError, serverSignature, lockedAt }`.

Web persists:
```sql
UPDATE projects SET
  status = 'persistent_locked',   -- or 'chain_locked' for basic
  merkle_root, scr_id,
  rvn_txid = ?,
  ipfs_cid = ?,
  arweave_uri = ?,
  lock_server_signature = ?,
  lock_locked_at_witnessed = ?,
  witnessed_count = ?,
  locked_at, updated_at, is_active = 0
WHERE id = ?
```

**SCR-ID is now public, on-chain, immutable.** Anyone can look up the RVN asset and find the Merkle root in its metadata.

---

## Phase 5 — The Receipt (what's public)

`https://scruple.stooges.ai/receipt/<SCR-ID>` — public, unauthenticated.

`app/receipt/[scrId]/page.tsx` server-renders:

| Section | Source | Contents |
|---|---|---|
| Header | `projects` | name, scr_id, status label, locked_at |
| Stats grid | `projects` | iteration_count, witnessed_count, Merkle depth, type |
| Merkle root | `projects.merkle_root` | full 64-hex hash |
| Witness server signature (chain anchor) | `projects.witness_signature` | HMAC on the chain-anchor lock data (chain locks) |
| **Lock countersignature** | `projects.lock_server_signature` | HMAC on `{project_id, action, merkle_root, witnessed_count, locked_at}` — the Scruple second-party seal |
| Iteration cards (one per row in `iterations`) | `iterations` | per-card: leaf scheme badge (v1/v2), backend, output_kind, timestamp, hash grid (leaf_hash/output_hash/input_hash/workflow_hash/models_hash), input artifacts list (kind/filename/hash/size), **model files loaded** (path/content_hash/header_hash/size), witness id+sig |
| **Verification recipe** | static + project state | step-by-step formula for an outsider to reproduce |
| Execution attestation summary | `iterations.execution_backend/attestation` | L1+L2 trust ladder per Pivot D-016 |
| Model fingerprints (training only) | `training_runs` | tensor count, parameters, dtypes, header hash for trained checkpoints |
| On-chain references | `projects.{rvn_txid, ipfs_cid, arweave_uri}` | links/values for the chain anchors |

The entire v2.1 spectrum is on this page in full — no truncated hashes. An outsider with this page in their browser has everything they need to verify (next phase).

---

## Phase 6 — Third-Party Verification (the inverse flow)

Anyone with the SCR-ID can verify the package is untampered. **No Scruple-side trust required.**

### 6.1 Pull the on-chain anchor
```bash
# On RVN testnet (sandbox; prod would be mainnet)
raven-cli getassetdata SCR_DD31408E
# → { name, amount, units, ipfs_hash: <root-encoded-as-IPFS-style>, ... }
# OR for richer metadata, query the Arweave record:
curl http://arlocal:1984/<arweaveTxId>
# → { type: 'scruple-proof-record', version: '2.0', scrId, merkleRoot, witnessedCount, lockedAt, ... }
```
You now have the **canonical Merkle root** as committed at lock time. RVN's blockchain timestamp says when (and no one can change either).

### 6.2 Fetch the receipt
```bash
curl https://scruple.stooges.ai/receipt/SCR_DD31408E
# Parse the HTML — every full hash + canonical formula is on the page.
```

Or, with API access:
```bash
sqlite3 scruple.db "SELECT * FROM iterations WHERE project_id = ? ORDER BY run_sequence"
```

You now have: every iteration's `run_sequence`, `output_hash`, `input_hash`, `workflow_hash`, `model_fingerprints_hash`, `server_timestamp`, `prev_record_hash`, `leaf_scheme`, full `model_fingerprints` manifest, full `input_artifacts` manifest.

### 6.3 Reproduce each leaf_hash
For each iteration, build the canonical record:
```python
record = {
  "run_sequence": iter.run_sequence,
  "output_hash":  iter.output_hash,
  "input_hash":   iter.input_hash,
  "workflow_hash": iter.workflow_hash or "",
  "model_fingerprints_hash": iter.model_fingerprints_hash or "",
  "server_timestamp": iter.witness_timestamp,
  "prev_record_hash": <previous iter's leaf_hash or "">,
}
canonical = json.dumps(record, separators=(',',':'), ensure_ascii=False)
my_leaf = hashlib.sha256(canonical.encode()).hexdigest()

assert my_leaf == iter.leaf_hash       # ← if false, the record was tampered
```

### 6.4 Reproduce input_hash
```python
input_canon = json.dumps({
  "provider": iter.provider,
  "prompt":   iter.prompt,
  "spec":     iter.metadata.generationSpec,        # has providerExtras.workflowApiJson
  "inputs":   [{"kind": a.kind, "hash": a.hash} for a in iter.input_artifacts],
}, separators=(',',':'), ensure_ascii=False)
assert sha256(input_canon) == iter.input_hash
```

### 6.5 Reproduce workflow_hash
```python
assert sha256(json.dumps(spec.providerExtras.workflowApiJson, separators=(',',':'), ensure_ascii=False))
    == iter.workflow_hash
```

### 6.6 Reproduce model_fingerprints_hash
```python
manifest = iter.model_fingerprints                     # JSON manifest
sorted_canon = json.dumps({k: manifest[k] for k in sorted(manifest)},
                          separators=(',',':'), ensure_ascii=False)
assert sha256(sorted_canon) == iter.model_fingerprints_hash
```

### 6.7 Hash the artifacts and confirm
For each input artifact and the output:
```bash
curl https://scruple.stooges.ai/api/artifact/<hash> | sha256sum
# Must equal the hash itself (it's content-addressed)
```

For each model file in `model_fingerprints`, if you have access to the bytes (e.g., the canonical SD1.5 from HuggingFace):
```bash
sha256sum v1-5-pruned-emaonly.safetensors
# Compare to manifest entry's content_hash. If it diverges → bytes on the runner volume were swapped after this run.
```

### 6.8 Rebuild the Merkle root
```python
leaves = [iter.leaf_hash for iter in iterations]   # in run_sequence order
def build(level):
    if len(level) == 1: return level[0]
    if len(level) % 2: level.append(level[-1])     # pad odd
    return build([sha256((a+b if a<b else b+a).encode()).hexdigest()
                  for a, b in zip(level[0::2], level[1::2])])
my_root = build(leaves)

assert my_root == project.merkle_root              # local
assert my_root == on_chain_root                    # ← THE PROOF
```

### 6.9 What you've just proven

If steps 6.3 → 6.8 all match, you've shown:
- The bytes you can fetch by hash today **match** the bytes that were captured.
- The leaf for each iteration **reproduces** from the recorded fields.
- The Merkle root **reproduces** from the leaves.
- The on-chain anchor **commits** to that root, with the RVN timestamp.

Therefore: **every input, every model file, every workflow graph, every output, in this exact order, at this exact server timestamp** — were the bytes existing at the moment the RVN tx was mined. Anything tampered with after that point produces a hash mismatch you just detected.

The verification needs **only**: the SCR-ID, the receipt page, sha256, json.dumps, and a way to read the RVN asset. No Scruple, no Witness server, no API key.

---

## Appendix A — End-to-end ASCII sequence (one chain-locked iteration)

```
USER         WEB           WITNESS       MODAL          STORAGE       CHAINS
 │            │              │             │             │             │
 │ /login    │              │             │             │             │
 ├───────────▶              │             │             │             │
 │            │ Google OAuth │             │             │             │
 │            │ + whitelist  │             │             │             │
 │ session    │              │             │             │             │
 ◀────────────┤              │             │             │             │
 │            │              │             │             │             │
 │ POST /api/runs?async=1                  │             │             │
 ├───────────▶ resolveInput(spec.inputs)   │             │             │
 │            ├──────────────────────────────────────────▶             │
 │            │              │             │  pull bytes │             │
 │            ◀──────────────────────────────────────────┤             │
 │            │ spawnWorkflow(graph, b64)               │             │
 │            ├─────────────────────────▶  │             │             │
 │            │ jobId        │             │             │             │
 │            ◀─────────────────────────┤  │             │             │
 │ jobId      │              │             │             │             │
 ◀────────────┤              │             │             │             │
 │            │              │             │ load models │             │
 │            │              │             │ hash each   │             │
 │            │              │             │ → manifest  │             │
 │            │              │             │             │             │
 │            │              │             │ run ComfyUI │             │
 │            │              │             │ output bytes│             │
 │ poll       │              │             │             │             │
 ├───────────▶ getWorkflowStatus(callId)   │             │             │
 │            ├─────────────────────────▶  │             │             │
 │            ◀─────────────────────────┤ { bytes, model_fingerprints }│
 │            │              │             │             │             │
 │            │ ingestIteration():        │             │             │
 │            │  - sha256(output bytes)   │             │             │
 │            │  - sha256(each input)     │             │             │
 │            │  - sha256(canonical(req)) = input_hash  │             │
 │            │  - sha256(workflow)       = workflow_hash             │
 │            │  - sha256(canonical(manifest)) = mf_hash              │
 │            │  - upload output    ────────────────────▶             │
 │            │ POST /api/witness          │             │             │
 │            ├─────────────▶│             │             │             │
 │            │              │ prev_record_hash lookup   │             │
 │            │              │ build canonical record    │             │
 │            │              │ leaf = sha256(canonical)  │             │
 │            │              │ HMAC(leaf) = signature    │             │
 │            │              │ INSERT INTO witnesses     │             │
 │            ◀─────────────┤ { leaf_hash, signature, server_timestamp, prev_record_hash }
 │            │ INSERT INTO iterations (leaf_hash=record_hash, …)     │
 │ ←  done    │              │             │             │             │
 ◀────────────┤              │             │             │             │
 │            │              │             │             │             │
 │ ... N more iterations ...                                          │
 │            │              │             │             │             │
 │ POST /api/lock/chain { tier: pinned, paymentIntentId }              │
 ├───────────▶ buildMerkle(leaves) → root  │             │             │
 │            │ deriveScrId(root) → SCR_…  │             │             │
 │            │ POST /api/confirm-and-execute            │             │
 │            ├─────────────▶│             │             │             │
 │            │              │ stripe.paymentIntents.retrieve(...)     │
 │            │              │ verify status + metadata + amount       │
 │            │              │ raven-cli issue SCR_…    │ ───────────▶ RVN mint
 │            │              │                          │ ◀─ proofTxId │
 │            │              │ ipfs add proof_record    │ ───────────▶ IPFS
 │            │              │                          │ ◀─ ipfsCid   │
 │            │              │ arweave post token record│ ───────────▶ Arweave
 │            │              │                          │ ◀─ arweaveTx │
 │            │              │ lockData = {project_id, action, root, count, time}│
 │            │              │ serverSig = HMAC(lockData)│             │
 │            │              │ INSERT INTO locked_projects             │
 │            ◀─────────────┤ { scrId, proofTxId, ipfsCid, arweaveTxId, serverSignature, lockedAt }
 │            │ UPDATE projects SET status=persistent_locked, scr_id, rvn_txid, ipfs_cid, arweave_uri, lock_server_signature, ...
 │ scrId      │              │             │             │             │
 ◀────────────┤              │             │             │             │
```

## Appendix B — Schema cross-reference

| Hash | Computed in | Stored in (web) | Stored in (witness) | In leaf preimage? |
|---|---|---|---|---|
| `output_hash` | `ingest.ts` `sha256Hex(bytes)` | `iterations.output_hash` | `witnesses.content_hash` | ✓ |
| `input_hash` | `ingest.ts` `sha256Hex(canonical(...))` | `iterations.input_hash` | `witnesses.input_hash` | ✓ |
| `workflow_hash` | `ingest.ts` `sha256Hex(JSON.stringify(wf))` | `iterations.workflow_hash` | `witnesses.workflow_hash` | ✓ |
| `model_fingerprints_hash` | `ingest.ts` `sha256Hex(canonical(manifest))` | `iterations.model_fingerprints_hash` | `witnesses.model_fingerprints_hash` | ✓ (v2.1) |
| `leaf_hash` | witness `handleWitness` `sha256(canonical(record))` | `iterations.leaf_hash` | `witnesses.leaf_hash` | — (it IS the leaf) |
| `prev_record_hash` | witness lookup of prior leaf | — | `witnesses.prev_record_hash` | ✓ |
| `server_timestamp` | witness `new Date().toISOString()` | `iterations.witness_timestamp` | `witnesses.server_timestamp` | ✓ |
| `signature` (per leaf) | witness `HMAC(leaf_hash)` | `iterations.witness_signature` | `witnesses.signature` | — (seals the leaf) |
| `merkle_root` | web at lock `buildMerkle(leaves)` | `projects.merkle_root` + `merkle_nodes` | — (recomputed at lock) | n/a |
| `scr_id` | web `deriveScrId(root)` (local) OR witness `'SCR_'+sha256(root)[:8]` (chain) | `projects.scr_id` / `pre_scr_id` | — | n/a |
| `lock_server_signature` | witness `HMAC({project_id, action, root, count, time})` | `projects.lock_server_signature` | `locked_projects.server_signature` | — (seals the lock event) |
| `rvn_txid` | raven-cli mint | `projects.rvn_txid` | — | n/a (on RVN chain) |
| `ipfs_cid` | Kubo `add` | `projects.ipfs_cid` | — | n/a (on IPFS) |
| `arweave_uri` | arlocal post | `projects.arweave_uri` | — | n/a (on Arweave) |

## Appendix C — One iteration in numbers

A real example from the audit (project 25, the v2.1 paid-flow smoke):

```
run_sequence:            1
output_hash:             e6f7b767d05673821809d54b32d8bbf31b34624cb0fd7bccde98beb2d58f68ef
input_hash:              (empty — txt2img, no inputs)
workflow_hash:           b58c64f0... (sha256 of the SD1.5 txt2img graph)
model_fingerprints_hash: 592c8587838f0f3d183473143c232eb1df90a12a110bf2a05faf7887cd4dbe15
   manifest entry:
     checkpoints/v1-5-pruned-emaonly.safetensors
       content_hash: 6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa
       header_hash:  ed6e1a1f33ba3a02193e599f6441e213f973f2949dedcfafefd570da536eae9e
       bytes:        4,265,146,304
server_timestamp:        2026-05-23T01:25:05.000Z
prev_record_hash:        "" (first iteration in this project)

canonical(record) = '{"run_sequence":1,"output_hash":"e6f7b76...","input_hash":"...","workflow_hash":"b58c64f0...","model_fingerprints_hash":"592c8587...","server_timestamp":"2026-05-23T01:25:05.000Z","prev_record_hash":""}'

leaf_hash = sha256(canonical) = bc4d560981a74ac33fef7e960b5f2a329c0768d63ba5fa0addd7af1ad7f3e0a9
signature = HMAC(SECRET, leaf_hash) = ... (per-record seal)

(After local lock — 1 leaf → root = leaf)
merkle_root            = bc4d560981a74ac33fef7e960b5f2a329c0768d63ba5fa0addd7af1ad7f3e0a9
scr_id                 = SCR_BC4D56
lock_server_signature  = ebb986b1e2e614469b1840c81e86de9e61ce7cdc2948353091f8dae896f5a2a9
                         signed over {project_id: "25", action: "finalize", merkle_root, witnessed_count: 1, locked_at: "..."}
```

This is the actual data behind the audit. Receipt at `/receipt/SCR_BC4D56` shows all of it.

---

## See also

- `docs/CANONICAL_GUIDE.md` — by-component reference (what each piece is, how it's organized, how to do common things).
- `CHANGELOG.md` — versioned release log, v2.1.0 entry has the technical change set.
- `docs/sessions/2026-05-22.md` — narrative dev log: the diagnostic war stories behind v2.1.
- `scripts/audit-receipts.py` — the canonical regression test. Reproduces this entire flow from raw data.
- `/opt/scruple-witness/PATCH_NOTES.md` — witness-server patch history.
