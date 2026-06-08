# Scruple Web — Canonical Guide

> Single-source orientation for a fresh Claude / dev. Read this first.
> Last updated: 2026-06-08. State as of commit `f1f9282`, leaf protocol v2.1.

---

## TL;DR

Scruple Web is a Next.js 14 app at `/data/scruple-web` that proves the provenance of AI-generated content. Every iteration (image / video / checkpoint) is hashed end-to-end at creation time, sealed into a Merkle tree at lock time, and (optionally) anchored on a public chain (RVN testnet + IPFS + Arweave) so anyone with the public **SCR-ID** can verify the package is untampered. Branch: `feature/pivot`. Public dev URL: `https://scruple.stooges.ai` → proxied to local `:3001`.

**The claim is real.** A standalone Python script (`scripts/audit-receipts.py`) independently re-derives every hash + Merkle root + cross-checks against the witness DB, the rendered receipt HTML, and the audit log. **331/331 across 12 projects** at end of session 2026-05-22.

---

## System Map

```
┌─────────────────┐       ┌──────────────────┐       ┌────────────────────┐
│   Browser       │──────▶│  Scruple Web     │──────▶│  Witness Server    │
│   (NextAuth     │       │  Next.js :3001   │       │  Node :5799        │
│    Google +     │◀──────│  (this repo)     │◀──────│  /opt/scruple-     │
│    Stripe       │       │                  │       │   witness/         │
│    Elements)    │       │                  │       │  (NOT in git)      │
└─────────────────┘       └──────────────────┘       └────────────────────┘
                                  │                         │
                                  │                         ├── stripe SDK
                                  ▼                         ├── raven-cli (RVN testnet)
                          ┌──────────────────┐              ├── IPFS Kubo :5001
                          │  Modal runner    │              └── arlocal :1984 (Arweave)
                          │  scruple-runner  │
                          │  (Python @app)   │
                          │  A10G GPU        │
                          └──────────────────┘
                                  │
                                  ▼
                          ┌──────────────────┐
                          │ Modal Volume     │
                          │ scruple-models   │
                          │ (shared, ~50GB)  │
                          └──────────────────┘
```

Each box has its own state. Each has its own DB or persistence layer. **None of them are the source of truth alone** — provenance is the cross-reference between them, plus the on-chain anchor.

---

## Repo Layout

```
/data/scruple-web/                          ← THIS repo, branch feature/pivot
├── app/
│   ├── api/
│   │   ├── auth/[...nextauth]/             ← NextAuth v5 handlers
│   │   ├── dev/session/                    ← SSH/CLI session-mint (shared secret)
│   │   ├── runs/                           ← CC dev pipeline (POST /api/runs?async=1)
│   │   ├── runs/status/                    ← Async poll for runs
│   │   ├── lock/{checkpoint,local,chain}/  ← Lock actions (always paid, no bypass)
│   │   ├── stripe/{payment-intent,confirm,…}/  ← Stripe proxies to witness
│   │   ├── artifact/[hash]/                ← Content-addressed byte retrieval
│   │   ├── projects/                       ← Create/list projects
│   │   └── …
│   ├── login/page.tsx                      ← Google sign-in (server action)
│   ├── receipt/[scrId]/page.tsx            ← Public unauthenticated receipt
│   ├── projects/[id]/page.tsx              ← Per-project workspace
│   └── page.tsx                            ← Home (sidebar + project picker)
├── lib/
│   ├── auth/auth.ts                        ← NextAuth config + signIn whitelist gate
│   ├── compute/{backends,modal}.ts         ← Modal runner client
│   ├── iterations/ingest.ts                ← THE provenance heart: hash → witness → persist
│   ├── runs/{execute,inputs}.ts            ← Sync + async run path; resolveInput()
│   ├── scruple/{hash,merkle,witness,artifacts}.ts  ← Hash/Merkle/witness primitives
│   ├── db/
│   │   ├── sqlite.ts                       ← shared conn()
│   │   └── migrations/                     ← 001…018, applied via runMigrations()
│   ├── storage/                            ← Drive/OneDrive/GitHub provider dispatch
│   └── types.ts                            ← IterationRow, ProjectRow, etc.
├── modal/scruple_runner.py                 ← The Modal app (deploy from here)
├── scripts/
│   ├── audit-receipts.py                   ← REGRESSION GATE — run before any commit
│   ├── scruple-run.ts                      ← CLI: capture + (optional) --lock <action>
│   ├── stripe-test-pay.mjs                 ← Sandbox PI create+confirm helper
│   └── scrupel.mjs                         ← CLI auth helper (uses /api/dev/session)
├── components/                              ← React (Sidebar, WorkspaceView, LockButtons, …)
├── data/scruple.db                         ← THE web sqlite DB (project state, iterations, etc.)
├── docs/
│   ├── CANONICAL_GUIDE.md                  ← This file
│   ├── sessions/2026-05-22.md              ← Narrative dev log for v2.1 work
│   └── video-training-tamper-evident-2026-05-12.md
├── CHANGELOG.md                            ← Versioned release log
└── .env.local                              ← Secrets — NEVER commit

/opt/scruple-witness/                       ← Witness server (NOT in git)
├── server.js                               ← Single-file Node HTTP server
├── witness.db                              ← THE witness sqlite (independent from web)
├── PATCH_NOTES.md                          ← Manual changelog per patch
├── server.js.bak.<unix_ts>                 ← One per patch, kept
├── testnet-locker.js                       ← RVN mint via raven-cli
├── ipfs-pinner.js                          ← Kubo client
└── arweave-treasury.js                     ← arlocal client
```

Other relevant paths:
- `/opt/comfyui` or Modal's image — ComfyUI lives inside the runner container, not on the host.
- The Modal volume `scruple-models` mounts at `/opt/ComfyUI/models/` inside the runner.

---

## The Provenance Protocol

### Leaf scheme versions

| Version | Leaf preimage | When |
|---|---|---|
| **v1** | `leaf_hash = output_hash` | Pre-2026-05-22 |
| **v2.0** | `sha256(canonical({run_sequence, output_hash, input_hash, workflow_hash, server_timestamp, prev_record_hash}))` | 2026-05-22, migration 016 |
| **v2.1** | `sha256(canonical({run_sequence, output_hash, input_hash, workflow_hash, model_fingerprints_hash, server_timestamp, prev_record_hash}))` | 2026-05-23, migration 017 |

Each iteration row carries `leaf_scheme` (`v1` or `v2`) so the audit can pick the right reproduction formula. Pre-017 rows verify under v2.0; post-017 rows under v2.1. The script tries v2.1 first, falls back to v2.0.

### Canonicalization — fixed forever

```python
# Python verifier reproduction (must match Node JSON.stringify byte-for-byte)
canonical = json.dumps(record, separators=(',', ':'), ensure_ascii=False)
leaf      = hashlib.sha256(canonical.encode()).hexdigest()
```

**Rules:**
1. **Compact JSON** — no whitespace. Node's `JSON.stringify` default; Python needs `separators=(',', ':')`.
2. **Fixed field order** — exactly as listed above. Object insertion order matters.
3. **Raw UTF-8** — no `\uXXXX` escapes. Python needs `ensure_ascii=False`. **This is the trap that caught us once** — an em-dash in a prompt drifted the hash. The receipt's verification recipe explicitly calls this out for non-JS verifiers.

### What each hash binds

| Field | What it pins |
|---|---|
| `output_hash` | The bytes the runner returned (image / video / checkpoint) |
| `input_hash` | `sha256(canonical({provider, prompt, spec, inputs:[{kind,hash}]}))`. Binds the request + every input artifact hash. |
| `workflow_hash` | `sha256(canonical(workflowApiJson))`. Binds the ComfyUI graph. NULL if path has no workflow. |
| `model_fingerprints_hash` | `sha256(canonical(model_fingerprints_manifest))`. Binds the actual weight bytes loaded by the runner (not just the filename). |
| `server_timestamp` | When the witness server signed it (ISO 8601). |
| `prev_record_hash` | The previous iteration's `leaf_hash` on this project, OR `""` for the first. Hash-chains the iteration log. |

### Merkle + chain anchor

- **Sorted-pair Merkle** — `combined = a < b ? a + b : b + a`, sha256 it. Odd levels pad by duplicating last. See `lib/scruple/merkle.ts` for the canonical implementation; the audit script reproduces it byte-for-byte.
- **Chain anchor at lock time** — RVN testnet mint (always), IPFS pin (pinned tier), Arweave anchor (basic + pinned). SCR-ID derived from Merkle root.
- **Receipt regex** — `^(SCR|SCRB)_[A-F0-9]{6,8}$`. Local lock = 6 hex; chain lock = 8 hex.

---

## Components

### Web (Next.js 14, App Router)

- **Port:** 3001 (dev). **Don't use 3000** — that's the shared `ai-council` dev server proxied to `dev.stooges.ai`; disrupting it 404s the public dev site.
- **DB:** `data/scruple.db` (SQLite, `better-sqlite3`). Migrations auto-apply on import via `runMigrations()` in `lib/db/migrate.ts`. Duplicate-column warnings on startup are harmless (raw `sqlite3` CLI applied a migration, then the in-app migrator hits the same DDL).
- **Auth:** NextAuth v5, **database** session strategy (NOT JWT). Session token lives in `__Secure-authjs.session-token` cookie. `auth()` server-side returns the session.
- **Storage strategy:** account-level provider (Drive/OneDrive/GitHub/local-FS). One per user. See `lib/storage/dispatch.ts`. Outputs uploaded to user storage post-ingest; local FS keeps short-term copies for `/api/artifact/[hash]`.

### Witness server (Node, `:5799`)

- **NOT in git.** Lives at `/opt/scruple-witness/`. Single `server.js` plus testnet-locker/ipfs-pinner/arweave-treasury helpers.
- **Patch convention:** every edit gets a `server.js.bak.<unix_ts>` and a `PATCH_NOTES.md` entry. Restart via `sudo systemctl restart scruple-witness`. Health: `curl :5799/health`.
- **DB:** `/opt/scruple-witness/witness.db` (independent SQLite). Tables: `witnesses` (per-iteration), `locked_projects` (finalize/chain), `tsd_auth_tokens` (Stripe audit trail), and others.
- **What it signs:** every iteration with HMAC over the canonical record (sealed by `signature` in the witnesses row). Every lock event is also HMAC-signed but the tuple varies by lock path: finalize/checkpoint (via `handleConfirmAndExecute`) signs `{project_id, action, merkle_root, witnessed_count, locked_at}` (action in tuple → no cross-action replay on this path); wallet chain-lock (`handleLock`) signs `{project_id, merkle_root, witnessed_count, locked_at}` (no action); Stripe-paid chain-lock signs `{projectId, scrId, tier, paymentIntentId, proofTxId, locked_at}`. Unifying these is a worthwhile future cleanup; today each site's signature commits to its own tuple.
- **HMAC secret:** `SCRUPLE_WITNESS_SECRET` in the systemd unit env. **Don't paste this in code.** Symmetric — fine for web (it's a server-side seal; the public verifier is the RVN mint wallet, which is asymmetric by virtue of being on-chain).
- **Stripe:** `STRIPE_SECRET_KEY=sk_test_*` in the systemd env. Witness creates + verifies PaymentIntents. Web proxies through it.
- **Endpoints:** `/api/witness`, `/api/lock/:projectId`, `/api/confirm-and-execute`, `/api/verify`, `/api/stripe-config`, `/api/create-payment-intent`, `/api/admin/confirm-pi` (loopback-only dev helper).

### Modal runner (Python, `scruple-runner` app)

- **Code:** `modal/scruple_runner.py`. **Deploy:** `SCRUPLE_MODAL_RUN_GPU=A10G python3 -m modal deploy modal/scruple_runner.py`.
- **GPUs:** `GPU=T4` for warm/ping functions; `RUN_GPU=A10G` for the heavy `run_workflow`. Don't reverse — long jobs on T4 hit preemption.
- **Volume:** `scruple-models` mounted at `/opt/ComfyUI/models/`. Single volume across all users (subfolders: `checkpoints/`, `loras/`, `vae/`, `text_encoders/`, `controlnet/`, etc.).
- **Endpoints:** `web_run` (sync), `admin_spawn_workflow` / `admin_workflow_status` (async), `admin_list` / `admin_fetch` / `admin_delete` (model library).
- **Model fingerprinting:** `_hash_workflow_models()` walks workflow for known loader nodes (Checkpoint/Lora/VAE/UNET/CLIP/Dual/Triple/ControlNet/Style/GLIGEN/Upscale), hashes each file. Cached by `(path, mtime_ns, size)` per warm container.
- **The bug that ate two sessions:** poll loop USED to break only when `outputs` was non-empty. `SaveLoRA`/`TrainLoraNode`/`CheckpointSave` are terminal nodes that register no `/view` output → loop spun the full 1700s. Fix: break on `status.completed`/`status_str=='success'`. Symptoms looked like GPU preemption, slow training, queue contention, step count. **When something "runs forever" on Modal, get `/tmp/comfyui.log` from the container before theorizing about infra.**

### External anchors

| | Endpoint (dev) | Endpoint (prod) | Purpose |
|---|---|---|---|
| **RVN** | testnet via `raven-cli` | mainnet | Mints an asset per SCR-ID; tx is immutable public timestamp |
| **IPFS** | Kubo `:5001` | Pinning service (not yet wired) | Pins the proof record (pinned tier only) |
| **Arweave** | `arlocal :1984` | Arweave mainnet | Token-record entry (basic + pinned tier) |

The public chain is the public verifier — anyone can pull the Merkle root from the RVN asset metadata and compare against the recomputed root from the receipt.

---

## Authentication & Identity Model

**Dev mode is an identity, not a code path.** One codebase, one set of routes. Dev deployments point the same code at sandbox endpoints (RVN testnet, `sk_test_*`, arlocal, Kubo). Whitelist of dev accounts gates signin on that deployment.

### How to sign in

| Path | When | How |
|---|---|---|
| **Google OAuth** | Browser | Visit `/login`, click "Sign in with Google". Whitelist via `SCRUPLE_ALLOWED_EMAILS` (currently `aquanomous@gmail.com,test@scruple.dev,demo@scruple.local`). Non-whitelisted Google logins → rejected at `signIn` callback. |
| **Dev session** | SSH/CLI | `GET /api/dev/session?email=<addr>&secret=<SCRUPLE_DEV_AUTH_SECRET>`. Hard-gated by `NODE_ENV=development` + `SCRUPLE_DEV_AUTH=1` + matching secret. Returns `{sessionToken}` to use as the `__Secure-authjs.session-token` cookie. |

The session token is what you pass via Cookie header in CLI calls:

```bash
TOK=$(sqlite3 /data/scruple-web/data/scruple.db \
  "SELECT session_token FROM sessions WHERE user_id='VFkUaqCs4qELs3HViFrPm' ORDER BY expires DESC LIMIT 1;")
curl -H "Cookie: __Secure-authjs.session-token=$TOK" https://scruple.stooges.ai/...
```

User IDs are stable. `aquanomous@gmail.com` = `VFkUaqCs4qELs3HViFrPm`.

---

## The Lock Pipeline

```
Capture (per iteration)
  → bytes hashed (input + output + model_fingerprints) atomically with use
  → witness server signs the canonical record → leaf_hash
  → row inserted in both web DB and witness DB

Checkpoint  (paid: $5 Stripe sandbox)
  → web builds local Merkle over witnessed iterations
  → POST /api/lock/checkpoint → witness.confirmAndExecute
  → witness verifies Stripe, signs lock event, returns serverSignature
  → web persists merkle_nodes + status=checkpointed + lock_server_signature

Local lock  (paid: $5 Stripe sandbox)
  → same as checkpoint but status=local_locked, scr_id set, is_active=0
  → witness ALSO persists a locked_projects row (checkpoint does not)

Chain lock — basic     ($50 Stripe sandbox OR wallet mode)
  → mints RVN testnet asset, posts Arweave token record
  → status=chain_locked

Chain lock — pinned    ($65 Stripe sandbox OR wallet mode)
  → RVN mint + IPFS pin + Arweave token record (all three anchors)
  → status=persistent_locked
```

**Status state machine:** `unlocked → checkpointed → (local_locked | chain_locked | persistent_locked)`. All non-unlocked states except `checkpointed` are terminal.

**Status `is_active=0`** is set on terminal lock states. Iterations cannot be added.

**Witness countersignature** on every lock event includes `action` in the signed tuple — `{project_id, action, merkle_root, witnessed_count, locked_at}` — so a checkpoint sig can't be replayed as a finalize sig.

**Two chain-lock paths:**
- **Path A (Stripe custodial):** `witness.confirmAndExecute({action: 'chain-lock-pinned', paymentIntentId, …})`. Witness verifies Stripe + mints + anchors.
- **Path B (wallet non-custodial):** `witness.lockProject(projectId, merkleRoot, tier)`. No Stripe; witness mints directly. Use this when you have a wallet and don't want to pay through Stripe.

---

## Stripe Integration

| Surface | Where | Notes |
|---|---|---|
| Secret key | Witness server env (`STRIPE_SECRET_KEY=sk_test_*`) | Web never touches Stripe directly; always proxies to witness |
| Publishable key | Witness `/api/stripe-config` | Frontend fetches this to load Stripe Elements |
| Create PaymentIntent | `POST /api/stripe/payment-intent` → `witness/api/create-payment-intent` | Uses **bare** projectId (NOT `sw:<userId>:<id>` — that was a bug; namespacing broke the anti-tamper check on the round-trip) |
| Confirm (browser) | Stripe Elements with `pm_card_visa` | Standard Stripe sandbox flow |
| Confirm (CLI) | `/api/admin/confirm-pi` on witness (loopback-only) | Drives `stripe.paymentIntents.confirm(id, {payment_method:'pm_card_visa', return_url:'http://127.0.0.1:3001/api/stripe/return'})`. Mirrors what Elements does. |
| Verify + execute | `POST witness/api/confirm-and-execute` | Re-retrieves PI, checks status + amount + metadata, then executes the lock action |

**The CLI test harness** (`scripts/stripe-test-pay.mjs`) wraps create + confirm into one call. Returns `PAYMENT_INTENT=<id>` for shell capture.

---

## Common Operations

### Start the dev server

```bash
cd /data/scruple-web
PORT=3001 npm run dev   # foreground
# or background:
(setsid bash -c "PORT=3001 npm run dev" > /tmp/scruple-dev.log 2>&1 < /dev/null &)
```

Wait for HTTP 307 on `/`. First page load ~5s while Next compiles. **NEVER run on port 3000** — that's the shared ai-council dev server.

### Run the audit

```bash
python3 /data/scruple-web/scripts/audit-receipts.py
```

Should print `331/331` (or whatever the current total is) and exit 0. **Run this before any commit that touches the provenance pipeline.**

### Drive a full capture + lock cycle from CLI

```bash
TOK=$(sqlite3 /data/scruple-web/data/scruple.db \
  "SELECT session_token FROM sessions WHERE user_id='VFkUaqCs4qELs3HViFrPm' ORDER BY expires DESC LIMIT 1;")

# 1. Create a project
PID=$(curl -s -X POST http://127.0.0.1:3001/api/projects \
  -H "Content-Type: application/json" \
  -H "Cookie: __Secure-authjs.session-token=$TOK" \
  -d '{"name":"my-project","type":"image"}' | jq -r '.project.id')

# 2. Edit a run spec to point at this project
python3 -c "import json; s=json.load(open('/tmp/chain_txt2img.json')); s['projectId']=$PID; json.dump(s, open('/tmp/run.json','w'))"

# 3. Capture + paid checkpoint + paid local lock in one go
SCRUPLE_SESSION=$TOK SCRUPLE_RUN_TIMEOUT_MS=300000 \
  npx tsx /data/scruple-web/scripts/scruple-run.ts /tmp/run.json --lock local
```

### Restart the witness server

```bash
node --check /opt/scruple-witness/server.js    # syntax check BEFORE restart
sudo systemctl restart scruple-witness
sleep 1
curl -s http://127.0.0.1:5799/health
```

**Always** `.bak` before editing: `cp server.js server.js.bak.$(date +%s)`. Append a `PATCH_NOTES.md` entry describing the diff.

### Redeploy the Modal runner

```bash
cd /data/scruple-web
python3 -c "import ast; ast.parse(open('modal/scruple_runner.py').read())"   # syntax check
SCRUPLE_MODAL_RUN_GPU=A10G python3 -m modal deploy modal/scruple_runner.py
```

The deploy is fast (~2s if image is cached). The new function is hot-swapped on Modal; existing FunctionCalls on the old version continue until they finish.

### Inspect what's in the DBs

```bash
# Web DB
sqlite3 /data/scruple-web/data/scruple.db "SELECT id, name, type, status FROM projects ORDER BY id DESC LIMIT 10;"

# Witness DB
sqlite3 /opt/scruple-witness/witness.db "SELECT project_id, run_sequence, witness_id, leaf_scheme FROM witnesses ORDER BY id DESC LIMIT 10;"
```

### View a receipt

```
https://scruple.stooges.ai/receipt/<SCR_ID>
```

Public, unauthenticated. Renders all v2.1 fields per iteration + verification recipe + lock countersignature + on-chain refs.

---

## Known Issues & Gotchas

| | |
|---|---|
| **Port 3000** | Shared with the `ai-council` dev server. Scruple Web is **3001**. Don't run `next dev` on 3000 or you'll 404 the public ai-council site. |
| **Migration warnings on startup** | `[auth] migrations failed at import: SqliteError: duplicate column name: workflow_hash` is harmless. The raw `sqlite3` CLI applied the migration; the in-app migrator retries. Wrapped in try/catch. |
| **SD1.5 hash mismatch** | The `v1-5-pruned-emaonly.safetensors` on the Modal volume hashes to `6ce0161689b3…`, NOT HuggingFace's official `cc6cb27103…`. Provenance is honest about exactly that — but a canonical-hash registry to flag it at upload time is still TODO (M-2). Don't claim "canonical SD1.5" without verifying. |
| **UTF-8 canonicalization** | Python's `json.dumps` defaults to `ensure_ascii=True`, escapes non-ASCII as `\uXXXX`. **This breaks the leaf hash reproduction** for any prompt containing a non-ASCII char (em-dash, em-quote, etc.). Always pass `ensure_ascii=False`. The receipt's verification recipe documents this. |
| **Shared Modal volume** | `scruple-models` is single-tenant — all users hit the same volume. Per-user namespacing is a future hardening (paired with M-2 hash-on-upload). Today, the at-load fingerprint (v2.1) catches any swap; the manifest is part of the leaf. |
| **TEE deferred (T1/T2)** | We don't yet have hardware attestation that the runner is honest. A compromised container could substitute output bytes; the pipeline would faithfully hash + witness the substitute. Closes with H100 CC deploy. Not blocking beta. |
| **Stripe-paid chain lock was silently broken pre-`6fe2571`** | `/api/stripe/payment-intent` was namespacing project IDs as `sw:<userId>:<id>` while every other caller used bare IDs. Witness's anti-tamper check failed on round-trip. Fixed; chain-paid path now works. Only wallet-mode chain locks worked before. |
| **Dev server crashes silently sometimes** | If `pkill -f "next dev"` is interrupted, the relaunch may not detach properly. Use `setsid bash -c "PORT=3001 npm run dev" > /tmp/scruple-dev.log 2>&1 < /dev/null &` or `run_in_background: true` from a tool. |
| **Sign-in button does nothing** | Almost always a stale `.next` cache in the browser. Hard refresh (`Ctrl+Shift+R`). If that fails, clear `.next/` and restart the dev server. |

---

## Files / Components to Never Touch Casually

- **`/opt/scruple-witness/server.js`** — live service, not in git. ALWAYS `.bak` before editing. Restart cleanly.
- **`/opt/scruple-witness/witness.db`** — independent state. Don't delete; don't write to without understanding the witness contract.
- **`modal/scruple_runner.py` canonicalRecord / hash logic** — protocol-level. Bumping the leaf scheme requires a migration + audit-script version fallback + receipt update + PATCH_NOTES.
- **`scripts/audit-receipts.py` `record_hash_v2x` functions** — these define the canonical record format byte-for-byte. Editing them changes how we verify; coordinate with the witness server's `canonicalRecord()` in lockstep.
- **`lib/db/migrations/`** — never edit a migration after it's applied anywhere. Add a new one.
- **`.env.local`** — secrets. Never commit. Each deployment has its own.

---

## Open Follow-ups (priority order)

1. **M-2: hash-on-upload** for `fetch_to_volume`. Closes the window where a malicious model is uploaded AND used before any verifier looks. Pairs with a canonical-hash registry (HF/Civitai published hashes) so mismatches are flagged at upload.
2. **Volume hygiene** — investigate why our SD1.5 hash differs from HF official. Replace or document.
3. **Desktop reconciliation** — v2.x leaf scheme is web-only by user direction. Desktop verifier will need the leaf-scheme switch when desktop is next touched. See `project_scruple_v2_leaf` memory note for the decision context.
4. **TEE attestation (T1/T2)** — H100 CC deploy. Real product spend. Defer until a buyer/customer needs it.
5. **Login gate tiers** — single allowed-emails whitelist today. Add a policy layer (free / paying / admin) when product needs it.
6. **Per-user volume namespacing** — paired with M-2. Each user gets a subdirectory; canonical bases live read-only. Defense-in-depth on top of the at-load fingerprint.
7. **Periodic batch anchor (T6)** — pre-lock projects have no external anchor. A cheap periodic Merkle anchor of recent iterations would give pre-lock state an external floor.

---

## Reference Docs

- **`docs/END_TO_END_FLOW.md`** — companion to this doc. Linear narrative trace of one user journey through every system in the order it happens (browser → web → Modal/ComfyUI → witness → RVN/IPFS/Arweave → receipt → third-party verify). Read this when you need to *follow* a request, not just look up where things live.
- **`CHANGELOG.md`** — versioned release log. v2.1.0 entry has the full technical change set.
- **`docs/sessions/2026-05-22.md`** — narrative dev log preserving the diagnostic arc that led to v2.1.
- **`/opt/scruple-witness/PATCH_NOTES.md`** — witness server patch history.
- **Memory (`~/.claude/projects/-data-ai-council-ai-council/memory/`):**
  - `project_scruple_web_status.md` — primary reference; current state summary
  - `project_scruple_v2_leaf.md` — v2 leaf design details
  - `project_scruple_checkpoint_capture.md` — the CAP-6 poll-loop bug
  - `project_scruple_witness_merkle.md` — canonical Merkle history
  - `project_scruple_web_shipped.md` — prior shipped baseline
  - `feedback_shared_dev_server_warning.md` — port 3000 hazard

---

## Quick reference card

```
repo            /data/scruple-web
branch          feature/pivot          (NOT main)
dev URL         https://scruple.stooges.ai  → 127.0.0.1:3001
witness         /opt/scruple-witness/       → 127.0.0.1:5799  (not in git)
Modal app       scruple-runner              (deploy from modal/scruple_runner.py)
volume          scruple-models @ /opt/ComfyUI/models/ (shared)
leaf protocol   v2.1
audit           python3 scripts/audit-receipts.py    (must be 100%)
dev user        aquanomous@gmail.com  →  VFkUaqCs4qELs3HViFrPm
receipt         /receipt/<SCR_ID>     (public, unauthenticated)
```
