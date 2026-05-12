# Scruple Web Pivot — Work Orders

_Authored 2026-05-12. The branch containing the parity overnight
(`feature/electron-parity`) gets folded into this pivot as the
foundation. Subsequent work happens on a fresh `feature/pivot` branch._

## TL;DR

Scruple becomes **one product, one execution backend, zero
custodial storage**:

- **One cloud backend**: TEE-attested NVIDIA H100 (Modal CC mode or
  Phala — picked after compat smoke). No non-attested middle tier.
- **Zero Python custom nodes** maintained by Scruple. JS Queue intercept
  captures everything the chain needs.
- **Zero user-content storage** on scruple-web. Everything goes to the
  user's own Drive / OneDrive / GitHub. Scruple-web is stateless wrt
  user artifacts; it holds hashes + pointers + chain metadata only.
- **Local GPU tunnel** ("Scruple Agent") is **deferred** to a future
  phase.
- **ComfyDeploy adapter** survives only as an opt-in BYO option for
  the small subset of users who already have a CD machine configured.

The product matrix collapses to **one backend with one trust ceiling**
(TEE-attested cloud), accessed by **one UI** (Scruple Web). Privacy
comes from BYOS, not from local execution. Provenance integrity comes
from architectural capture isolation (chain on scruple-web) +
cryptographic execution proof (TEE on the GPU).

---

## Decisions to log first

These get appended to `memory/DECISIONS.md` before any WO ships.

### D-014 · Scruple Python custom nodes deprecated for the cloud product
**Decision:** The four Scruple ComfyUI nodes
(ScrupleTap / ScrupleOutputCapture / ScrupleStudioTerminal /
ScrupleTrainingTerminal) are removed from the Scruple-managed cloud
backend. Capture happens at the JS Queue intercept; output bytes come
from the GPU response. Optional cosmetic JS-only "SCRUPLE" badge nodes
may exist in the canvas menu for visual reassurance but do nothing
functional.
**Rationale:** Python nodes were a desktop-era pattern. They don't fit
TEE-attested execution (we don't control the runtime), they add
ComfyDeploy machine-build complexity, and they're invasive (users had
to drop them in workflows). Everything they did is now done
server-side in `/api/generate` + `ingestIteration()`.
**Implication:** No node maintenance, no version-locking, simpler
machine recipes. The existing `scruple_nodes` Python package remains
deployed on local canvas.stooges.ai for development purposes only.

### D-015 · One product, one execution backend (for v1 pivot)
**Decision:** Scruple Web is the only product. The execution backend
is TEE-attested NVIDIA H100. Local GPU tunnel (Scruple Agent) is a
planned future capability but out of scope for this pivot.
**Rationale:** Two products fork the codebase. The local tunnel adds a
second compute path with a different trust ceiling, which we'd have
to document, market, and price separately. Punt until after the
single-product launch.
**Implication:** Scruple Desktop becomes archive code. No new Desktop
releases. The existing Desktop installer page (if any) gets a
"deprecated — use Scruple Web" notice. Future "Scruple Agent" for
local GPU is a v2 deliverable.

### D-016 · TEE-attested only — no non-attested cloud tier
**Decision:** The cloud execution backend runs exclusively in
TEE-attested mode (NVIDIA H100 CC). There is no "Standard" non-attested
fallback.
**Rationale:** Every cloud run is on the patentable path. Pricing and
positioning don't have to explain the difference between two cloud
tiers. The premium for CC mode is ~10–20% over plain H100 — small
enough that the per-lock pricing absorbs it.
**Implication:** Any ComfyUI workflow that uses custom nodes
incompatible with CC mode either gets fixed (CC-compatible build) or
documented as unsupported. The compatibility envelope becomes part of
the trust story, not a bug.

### D-017 · BYOS (Bring Your Own Storage) — no scruple-web content store
**Decision:** Scruple Web does not store user images, workflow JSONs,
or any other content beyond ephemeral working storage for an
in-progress ComfyUI run. The persistent home for every artifact is
the user's own Drive / OneDrive / GitHub. Mirrors the Stooges
"no user data on Stooges" architecture (D-046–D-054 in
ai-council/memory).
**Rationale:** Privacy by architecture, not by promise. Users own
their content end to end. Scruple-web is reduced to the
provenance-computation layer + the orchestration UI. Same legal /
compliance posture as Stooges.
**Implication:** New `storage` subsystem mirrors
`ai-council/lib/storage/`. Iteration ingest writes to user storage,
records pointer + hash on scruple-web, then purges the ephemeral
local copy. Lock-package builder fetches from user storage at lock
time. Project export bundles by reading from user storage.

---

## Phase P — Position the pivot _(0.5 day)_

Decision documents + repo cleanup. No code changes to existing
features.

### WO-P1 · Append D-014..D-017 to memory/DECISIONS.md
Direct edit. Sequential numbering from D-013.

### WO-P2 · PRODUCT_MATRIX.md positioning doc
Single source of truth for marketing, patent drafting, and engineering
scope. Captures:
- The collapse to one product / one backend / zero storage
- Trust ladder definition (L1/L2/L3 with which layer comes from where)
- Audience for the product (no GPU + studios + commercial + legal)
- What the receipt page can honestly claim
- Patent claim mapping (L1 = architectural isolation; L2 = witness
  chain, already filed; L3 = TEE attestation, next provisional)
- What's out of scope (local GPU tunnel, multi-backend selector)

### WO-P3 · PARITY_PLAN.md revision
Strike-through every WO that no longer makes sense under the new
direction. Specifically:
- Drop "match Desktop UX" framing — Web is its own thing
- Drop multi-backend wallet selector references
- Annotate WO-43 (wallet modals) as: the wallet UI ships, the
  per-user wallet creation handler is wired via TEE-cloud account
  binding (next pivot phase, not parity)
- Update memory/STATE.md to reference PIVOT_WORK_ORDERS.md as the
  forward-looking plan

---

## Phase E — Execution backend (Modal H100 CC) _(3–4 days)_

Replace ComfyDeploy as the default with TEE-attested H100 on Modal.
Keep ComfyDeploy adapter as a BYO option.

### WO-E1 · Provider abstraction `lib/compute/backends.ts`
Typed interface that all compute backends implement:

```ts
interface ComputeBackend {
  readonly name: 'modal-tee' | 'comfydeploy' | 'local-tunnel';
  readonly trustTier: 'L1+L2' | 'L1+L2+L3';
  submitWorkflow(workflowApiJson, ctx): Promise<{jobId}>;
  poll(jobId, ctx): Promise<PollResult & {attestation?}>;
}
```

The existing `comfyDeployProvider` collapses behind this interface.
Future Modal + local-tunnel providers slot in cleanly.

### WO-E2 · Migration 006 — execution backend + attestation slots
Adds to `iterations`:
- `execution_backend TEXT` — `'modal-tee' | 'comfydeploy' | 'local-tunnel'`
- `execution_attestation TEXT` — JSON, null for non-attested runs, populated
  with TEE attestation payload for attested runs
- `storage_pointer TEXT` — JSON `{provider, path, url?}`, null until the
  storage subsystem lands (Phase S); replaces direct artifact-path
  dependence after migration

### WO-E3 · Modal function — `modal/scruple_runner.py`
Lives in a new top-level dir `/data/scruple-web/modal/`. Python
function decorated with `@stub.function(gpu=modal.gpu.H100(cc=True))`
that:
1. Mounts an image with ComfyUI + chosen custom nodes pre-built
2. Accepts `workflow_api_json` over the function call
3. Runs ComfyUI's `/prompt` against itself, polls `/history` for completion
4. Returns image bytes + Modal attestation receipt

Deployed via `modal deploy modal/scruple_runner.py`. Endpoint URL
captured in env var `MODAL_RUNNER_ENDPOINT`.

### WO-E4 · `lib/compute/modal.ts` — Modal backend adapter
Calls the deployed Modal function. Implements `ComputeBackend`.
Submits workflow + polls + extracts attestation receipt from Modal's
response. Maps to the unified PollResult shape.

### WO-E5 · `/api/generate` swap to Modal as default
- Workflow-mode requests default to Modal
- ComfyDeploy adapter remains for explicit BYO calls (`?backend=comfydeploy`)
- Records `execution_backend` + `execution_attestation` on iterations

### WO-E6 · Receipt page renders attestation when present
`/receipt/[scrId]` adds an "Execution Attestation" panel — shows
GPU model, attestation hash, the signed payload, and a verify link
that uses NVIDIA's attestation verification SDK (or Phala's, depending
on backend pick) to confirm.

### WO-E7 · Compat smoke test
Pick three representative workflows (basic SD 1.5, Flux 1, an SDXL +
ControlNet) and run them on Modal H100 CC. Document which custom
nodes work and which don't. If any common node breaks, decide:
patch / replace / declare unsupported. Result: a
`docs/cc-compat-2026-XX.md` matrix.

---

## Phase S — Storage abstraction (BYOS) _(5–7 days)_

Mirrors `ai-council/lib/storage/`. Scruple-web becomes stateless wrt
user artifacts.

### WO-S1 · Storage provider interface `lib/storage/types.ts`
Typed interface:

```ts
interface StorageProvider {
  readonly name: 'gdrive' | 'onedrive' | 'github' | 'local-dev';
  uploadFile(path, bytes, contentType): Promise<{providerPath, url?}>;
  readFile(providerPath): Promise<Buffer>;
  deleteFile(providerPath): Promise<void>;
  signedUrl?(providerPath, ttlSeconds): Promise<string>;
  listFolder?(path): Promise<FileEntry[]>;
}
```

### WO-S2 · Migration 007 — storage subsystem schema
- `storage_providers` table: per-user provider config (provider name,
  encrypted OAuth tokens, root folder pointer)
- `iterations.storage_pointer` becomes the canonical artifact home
  (already added in WO-E2 as a null slot)
- New `gdrive_sync_log` style table for retry/audit

### WO-S3 · Google Drive provider `lib/storage/gdrive.ts`
Port the relevant patterns from `ai-council/lib/gdrive/`. OAuth via
`drive.file` scope (writes only files this app created), so Scruple
never has read access to the user's broader Drive. Upload to
`Scruple Projects/<project_name>/iterations/`.

### WO-S4 · OneDrive provider `lib/storage/onedrive.ts`
Microsoft Graph API. OAuth via `Files.ReadWrite.AppFolder` scope
(app-folder-only, parallel to Drive's drive.file).

### WO-S5 · GitHub provider `lib/storage/github.ts`
GitHub Contents API — base64-encoded blobs committed to a user-chosen
private repo. Useful for users who already have a "personal vault" repo
pattern. PAT-based auth (no full OAuth needed).

### WO-S6 · Storage dispatcher `lib/storage/dispatch.ts`
Account-level provider routing (per Stooges D-053). One provider per
user; all writes go through it. The dispatch layer is the only thing
that calls a provider directly.

### WO-S7 · Settings page — Storage section
`/settings` gains a Storage tab:
- "Bring your own storage" explanation
- Provider selector (Drive / OneDrive / GitHub)
- Connect button (kicks off OAuth or token entry)
- Status display: connected / disconnected, last sync, error
- Switch provider warning: future writes go to the new provider;
  existing pointers stay valid

### WO-S8 · Iteration ingest writes to user storage
`ingestIteration()` (lib/iterations/ingest.ts) updated:
1. Hash bytes (computes leaf_hash) — same as today
2. Write to user's storage via dispatcher; capture `storage_pointer`
3. Record `storage_pointer` on the iteration row instead of (or
   alongside, transitionally) the local artifact path
4. Schedule local artifact purge — N minutes after upload (default
   15) the local copy is deleted; the hash + pointer remain on
   scruple-web

### WO-S9 · Iteration grid fetches from storage
`/api/artifact/[hash]` becomes a thin proxy:
- Look up iteration by hash
- Resolve storage pointer
- Stream bytes via signed URL OR proxy the read
- Cache aggressively (max-age long; the content is content-addressed)

### WO-S10 · Lock-package builder reads from storage
At lock time, the package builder fetches every iteration's bytes
from storage (for re-hashing + bundling). Slow path (network reads);
parallelize across iterations with bounded concurrency.

### WO-S11 · Project export ZIP reads from storage
`/api/projects/[id]/export` streams the ZIP by pulling each artifact
from storage on the fly. Memory-bounded.

### WO-S12 · Local artifact retention policy
Cron-style purger (or on-write trigger): any local artifact older
than N minutes that has been successfully uploaded gets deleted.
Default N = 15. Add a `LOCAL_RETAIN_MINUTES` env var.

### WO-S13 · Migration helper for existing iterations
For accounts that already have iterations stored on scruple-web
(beta data), provide an opt-in migration: walk every iteration,
upload its bytes to the user's chosen storage, update the row's
`storage_pointer`. Idempotent. CLI: `npm run migrate:storage`.

### WO-S14 · Privacy & policy doc
`docs/PRIVACY.md` — concrete statement of what scruple-web stores and
does not store, retention windows, what flows through TEE GPU
provider, what the witness server records. Becomes a publicly-linkable
artifact from the marketing site.

---

## Phase R — Receipts and verification _(2 days)_

Public receipts get updated to reflect BYOS + TEE.

### WO-R1 · Receipt page tagging
- "Stored at <provider>" instead of "Stored on scruple"
- Optional: if user has opted their storage path public, embed a
  small preview from their public Drive/OneDrive/GitHub URL
- Execution Attestation panel (lands in Phase E, just rendered here)

### WO-R2 · Verify endpoint accepts external bytes
`/api/verify` already accepts a lock-package manifest. Add a second
mode: receive a content-hash and a fetch URL (the user's storage URL),
fetch + re-hash, compare. Useful for third-party verifiers who don't
have the bytes locally.

### WO-R3 · Attestation verify (NVIDIA / Phala SDK)
JS + server library that re-validates the TEE attestation embedded
in the receipt against the GPU vendor's public PKI. Anyone with the
receipt can press "Verify" and see green-check (or not).

---

## Phase D — Docs + handoff _(0.5 day)_

### WO-D1 · STATE.md + HANDOFF_PIVOT.md
Mid-pivot snapshot. What works, what doesn't, what's next.

### WO-D2 · Update README.md + the public-facing scruple.ai story
The pitch becomes:
- "AI provenance with hardware-verified execution"
- "Your content. Your storage. Our cryptographic chain."
- "No middlemen between your GPU and your provenance — we don't
  store, we don't see."

---

## What gets deferred (intentionally, post-pivot)

| Item | Why deferred | Pick up when |
|---|---|---|
| Scruple Agent (local GPU tunnel) | One backend = simpler shipping story | After v1 of the pivot is live + users ask for it |
| Multi-backend selector UI | Only one backend in v1 | When the tunnel agent ships |
| ComfyDeploy as a Scruple-recommended path | Replaced by Modal | Never — stays as BYO |
| Setup wizard / Kohya / training | D-006, unchanged | If/when a training v2 is in scope |
| Stripe Element work on lock flow | Survives the pivot intact | Already done in `feature/electron-parity`; lands when that branch merges |

---

## Sequence + dependencies

```
P1 ── P2 ── P3
              ↓
              E1 ── E2 ── E3 ── E4 ── E5 ── E6
                                              ↓
                                              E7 (compat smoke)
                                              ↓
              S1 ── S2 ── S3 │   S6 ── S7 ── S8 ── S9 ── S10 ── S11
                          ├───┤                                 ↓
                          S4 │                                 S12 ── S13 ── S14
                          ├───┤
                          S5 │
                              ↓
                              R1 ── R2 ── R3
                                          ↓
                                          D1 ── D2
```

**Critical path:** P-phase → E1..E5 (Modal swap is non-negotiable
foundation) → E7 (compat smoke determines if Modal H100 CC is viable
or if we need Phala fallback) → S1..S2 (storage abstraction
foundation) → S3 (Drive first, the most-used provider) → S8 (ingest
through storage) → S12 (cleanup the local copies) → public ready.

OneDrive (S4), GitHub (S5), R1..R3, D1..D2 can ship after the
critical path lands. Drive-only is a valid public v1.

**Total estimate:** ~3 weeks of focused work for the critical path.
Add ~1 week for S4/S5/R/D. Total ~4 weeks to a polished v1.

---

## Branch strategy

- `feature/electron-parity` — current overnight branch. Merges into
  `main` once the parity work is stable. Captures the wallet UI +
  Stripe Element + sidebar pills + view-toggle + lock modals.
- `feature/pivot` — new branch off `main` after the parity merge.
  All WOs in this doc land here. Long-running.
- Per-WO commits as usual.

---

## What this doc replaces

- The original 30 WOs in `WORK_ORDERS.md` are largely already shipped
  (covered by the pre-parity work + the overnight)
- `PARITY_PLAN.md` is still relevant for the *current branch* but
  several of its WOs are voided by this pivot (notably WO-43a wallet
  handler wiring — replaced by the simpler "Scruple is the custodian
  of nothing" approach)

This doc is the forward-looking source of truth for everything after
the parity branch merges.
