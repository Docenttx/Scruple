# Scruple Web — Work Orders

Phased build plan that ports SCRUPLE Studio v3 (Electron desktop) into a
Next.js web app. Source-of-truth for the existing UI is
`research/electron-source/renderer/`. Source-of-truth for the IPC API
surface is `research/electron-source/scruple-studio/preload.js`.

Execute top to bottom. Each WO has acceptance criteria and references
the desktop source files it ports from.

### Phase legend
- **P0 — Scaffold** (1 WO): empty Next.js shell that boots
- **P1 — Foundation** (4 WOs): DB, types, auth, layout
- **P2 — Project surface** (5 WOs): list, create, view, archive, activate
- **P3 — Iteration capture** (5 WOs): provider adapters + ingest endpoint
- **P4 — Lock pipeline** (4 WOs): merkle, local lock, chain lock, package
- **P5 — Witness + Stripe** (3 WOs): witness client, Stripe checkout, lock execution
- **P6 — Verification + receipts** (3 WOs): verify chain, public receipt, export
- **P7 — Polish** (5 WOs): error states, search, pagination, toasts, settings
- **DEFERRED** (open list): wallet UIs, training capture, IPFS/Arweave native

---

## P0 — Scaffold

### WO-01 · Scaffold the Next.js project
**Goal:** Empty Next.js 14 (App Router) + TypeScript app that boots at
`localhost:3001` (3000 is ai-council).

**Steps:**
1. `cd /data/scruple-web && npx create-next-app@latest . --ts --app --no-src-dir --tailwind --eslint --import-alias "@/*"`
2. Install runtime deps: `better-sqlite3`, `next-auth@beta`, `zod`,
   `zustand`, `nanoid`, `clsx`
3. Install dev deps: `@types/better-sqlite3`
4. Edit `package.json` → `"dev": "next dev -p 3001"`
5. Initialize git: `git init && git add . && git commit -m "WO-01: scaffold"`
6. Verify `npm run dev` serves the default page at :3001

**Acceptance:** Browser hits `http://localhost:3001/` and sees the
default Next page. `npm run build` succeeds. Repo committed.

---

## P1 — Foundation

### WO-02 · Database schema + migrations
**Goal:** Port the SQLite schema from desktop, set up a migrations runner.

**Source:** `research/electron-source/scruple-studio/database.js`
(6 tables: `projects`, `iterations`, `merkle_nodes`, `training_runs`,
`checkpoints`, `files_registry`).

**Steps:**
1. Create `lib/db/sqlite.ts` — singleton better-sqlite3 instance, opens
   `data/scruple.db`. Mirror `ai-council/lib/db/sqlite.ts`.
2. Create `lib/db/migrate.ts` — reads `lib/db/migrations/*.sql` in order,
   tracks applied migrations in `_migrations` table.
3. Write `lib/db/migrations/001_core.sql` — copy 6 tables as-is from
   desktop. Web-specific additions: add `user_id TEXT NOT NULL` to
   `projects` (multi-tenant from day one).
4. Write `lib/db/migrations/002_auth.sql` — `users`, `sessions`,
   `accounts` tables for NextAuth (copy from
   `research/prior-art-ai-council/canvas/migration-022.sql` and trim).
5. Add `npm run db:migrate` script that calls a small CLI in
   `scripts/migrate.ts`.

**Acceptance:** `npm run db:migrate` creates `data/scruple.db` with all
tables. Re-running is a no-op. `sqlite3 data/scruple.db .schema` shows
expected tables.

**Notes:** Drop the desktop's `vault_path` column from `projects` —
that's a local-FS concept. Keep all hash columns (`merkle_root`,
`scr_id`, `package_hash`, `rvn_txid`, `arweave_uri`, `ipfs_cid`,
`pre_scr_id`, `witness_signature`).

---

### WO-03 · Shared types
**Goal:** Single `lib/types.ts` with Project, Iteration, MerkleNode,
LockState, GenerationProvider unions. No business logic.

**Source:** `research/electron-source/renderer/api.js` reveals the shapes
that the renderer expects. `database.js` reveals the row shapes.

**Acceptance:** `tsc --noEmit` clean. Types are imported by at least one
other file (so they're visible to the build).

---

### WO-04 · Auth (NextAuth)
**Goal:** Working sign-in / sign-out with Google provider. Sessions
persist. Server actions can resolve `userId`.

**Source:** Copy `auth.ts` and `app/api/auth/[...nextauth]/route.ts`
from ai-council, trim to Google + email-link.

**Acceptance:** Visiting `/` while signed out redirects to `/login`. Sign
in with a Google account. The user row is created in `users`. Sign out
returns to `/login`.

**Env vars required:**
`AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_URL`.

---

### WO-05 · App shell + nav layout
**Goal:** Top-level layout with sidebar (projects list placeholder),
header (user menu, witness status pill), main content area. No business
logic — just frame.

**Source:** `research/electron-source/renderer/render-main.js`
(`renderMainApp` function — sidebar + workspace split).

**Acceptance:** Signed-in user sees: left rail with "+ New Project"
button and empty list, top bar with their email + sign-out, main area
with "No project selected" empty state. Tailwind only — no custom CSS
yet. Looks acceptable on desktop widths (mobile deferred).

---

## P2 — Project surface

### WO-06 · Project model server actions
**Goal:** Typed server actions for CRUD: `createProject`, `getProjects`,
`getProject`, `archiveProject`, `activateProject`, `deactivateProject`.
All scoped by `userId` from the session.

**Source:** `research/electron-source/ipc/ipc-project-handlers.js`
defines the desktop's IPC handlers for the same operations.

**Acceptance:** From a Next.js Server Component, `await getProjects()`
returns rows for the signed-in user only. Cross-user access is rejected.
Unit-test-equivalent: a quick Postman / curl pass through `/api/projects`
GET/POST/DELETE.

**Project shape:** `{ id, name, type ('txt2img' | 'training'),
status (Lock state enum), iteration_count, merkle_root, scr_id, ... }`

---

### WO-07 · Project list (sidebar)
**Goal:** Sidebar lists the signed-in user's projects with status badge
and active indicator. Click selects; click "Archive" hides; click
"Activate" makes it the active capture target.

**Source:** `render-main.js` has the sidebar markup;
`render-workspace.js` `statusLabels` defines the status badges.

**Acceptance:** Creates / lists / archives / activates round-trip
through the server. Active project has a visual indicator (pill or dot).
Only one active project at a time per user (server-enforced).

---

### WO-08 · Create-project modal
**Goal:** "+ New Project" opens a modal with `name` text input and
`type` toggle (txt2img | training, training disabled with tooltip
"deferred to v2"). Submit calls `createProject` and selects the new row.

**Source:** Desktop creates projects via `ipcRenderer.invoke('create-project', name, type)`
— port that surface to a server action.

**Acceptance:** Submit closes the modal, sidebar shows the new project,
workspace shows the new project's empty state.

---

### WO-09 · Workspace view (project detail)
**Goal:** Selecting a project renders the workspace: header (name +
status badge + active indicator + Activate/Stop button), stats row
(iteration_count, merkle_root, scr_id), iteration grid (empty state
for now), lock buttons (disabled until iterations exist).

**Source:** `research/electron-source/renderer/render-workspace.js`
(the entire `renderWorkspace` function — that is the spec).

**Acceptance:** All the above renders correctly for a project with zero
iterations. Status badges use the desktop's exact label strings
(Unlocked / Checkpointed / Finalized / Chain Locked / Persistent Locked
/ Permanent Locked).

---

### WO-10 · Activate-project flow + interlock
**Goal:** "Start Tracking" sets `is_active = 1` on the project (and
clears it on every other project for that user — server-enforced one-at-a-time).
"Stop Tracking" clears it. Interlock state (UI disabled while a lock op
is in flight) lives in client Zustand store; mirrors `set-interlock`
from desktop.

**Source:** `ipc-project-handlers.js` has `activate-project` /
`deactivate-project`; `ipc-lock-handlers.js` has `set-interlock`.

**Acceptance:** Activate flips the badge. Activating project B while A is
active deactivates A first (server-side transaction). Disabled buttons
go grey while interlocked.

---

## P3 — Iteration capture

### WO-11 · Generation provider interface
**Goal:** `lib/providers/types.ts` defines a `GenerationProvider`
interface with `generate(spec)` and `getResult(jobId)` methods. Two
implementations stubbed: `falProvider`, `comfyDeployProvider`.

**Source:** `research/api-research/01-provider-strategy.md` and
`research/prior-art-ai-council/fal/lib-fal.ts`.

**Acceptance:** `tsc --noEmit` clean. Both providers throw "not
implemented" on call but expose the right method signatures.

---

### WO-12 · fal.ai adapter
**Goal:** `lib/providers/fal.ts` calls fal.ai's HTTP API for prompt-only
generation. Returns `{ jobId }` from submit, then polls for completion
and returns image bytes. **Does not** witness — that's WO-15.

**Source:** Lift from `research/prior-art-ai-council/fal/{generate,status,result}-route.ts`
and `lib-fal.ts` (already production-tested).

**Acceptance:** `npm run dev` + a /test route that calls
`falProvider.generate({prompt: 'a cat'})`. Image bytes returned. Verify
shape matches what the iteration ingest endpoint will need.

**Env vars required:** `FAL_KEY`.

---

### WO-13 · ComfyDeploy adapter
**Goal:** `lib/providers/comfydeploy.ts` accepts user's ComfyDeploy API
key + workflow ID, fires the workflow, polls for completion. User's API
key stored encrypted in `users.provider_keys` JSON column (add via
migration 003).

**Source:** ComfyDeploy public API — research and document URLs in this
WO when implementing. No prior art in ai-council.

**Acceptance:** Settings page accepts a ComfyDeploy API key. Calling
`comfyDeployProvider.generate({...})` with that key returns image bytes.

**Migration:** `lib/db/migrations/003_provider_keys.sql` adds
`provider_keys TEXT DEFAULT '{}'` to `users`.

---

### WO-14 · Iteration ingest endpoint
**Goal:** `POST /api/iterations` — server-side endpoint that takes a
`{projectId, providerJobId, providerName, prompt, params, outputBytes (or downloadUrl)}`
payload, computes leaf hash (SHA-256 over canonical input + output),
inserts an `iterations` row, increments `projects.iteration_count`,
persists output bytes to `artifacts/<sha-prefix>/<sha>`.

**Source:** `research/electron-source/ipc/ipc-project-handlers.js` shows
the desktop pattern — it captures iterations from the local Express
server fed by Python ComfyUI nodes. Web replaces that with this HTTP
ingest endpoint.

**Acceptance:** Calling fal.ai end-to-end (UI → /api/generate → fal.ai
→ /api/iterations) results in: image saved to artifacts/, row in
iterations, iteration_count incremented, leaf_hash matches sha256 of
the canonical input+output.

**Hash format (must match desktop):** see
`research/electron-source/lock/merkle.js` and
`research/electron-source/nodes/studio_terminal.py._hash_image_file()`.

---

### WO-15 · Iteration grid render
**Goal:** Workspace iteration grid populates from the iterations table.
Each card shows: image thumbnail (served from
`/api/artifact/[hash]`), `#run_sequence`, truncated leaf_hash,
created_at. Click opens a side drawer with full prompt + params + full
hash. Live-updates after a new iteration is captured (poll every 3s
while the project is active; switch to SSE in P7).

**Source:** `research/electron-source/renderer/render-workspace.js` —
the iteration card markup (line search for `iteration-card`).

**Acceptance:** Generate 3 images. Grid shows 3 cards in order. Click
card → drawer shows full prompt. Refresh page → still there.

---

## P4 — Lock pipeline

### WO-16 · Merkle tree library (server-side)
**Goal:** `lib/scruple/merkle.ts` — pure function `buildMerkle(leafHashes: string[])`
returns `{ root, nodes: MerkleNode[] }`. **Algorithm must match desktop
byte-for-byte:** alphabetical pair sort before hashing, level-by-level
construction, all intermediate nodes captured.

**Source:** `research/electron-source/lock/merkle.js`. This file is the
spec — port it line-by-line into TypeScript with tests.

**Acceptance:** Unit test with 1, 2, 3, 5, 8 leaves. For each,
recompute manually and assert root matches. Cross-test: take a real
project from the desktop's `projects.merkle_root`, feed its
`iterations.leaf_hash` set in, verify same root.

---

### WO-17 · Local-disc lock
**Goal:** `POST /api/lock/local` (free, no Stripe) — runs Merkle on all
project iterations, derives SCR-ID (first 6 hex chars of root with
`SCR_` prefix), updates `projects.{merkle_root, scr_id, status='local_locked', locked_at}`,
inserts merkle_nodes rows. Atomic (single transaction).

**Source:** `research/electron-source/lock/lock-local-lock.js`.

**Acceptance:** Click "Finalize Project" with 5 iterations → 200 OK,
project status flips to "Finalized", SCR-ID badge appears in header,
merkle_nodes table populated.

---

### WO-18 · Lock-package builder
**Goal:** `lib/scruple/lock-package.ts` builds the canonical lock
package (a JSON manifest containing project metadata, all leaf hashes
in order, all merkle nodes, root, SCR-ID, witness signatures).
Hashable, deterministic. Stored in `projects.package_hash`.

**Source:** `research/electron-source/lock/lock-package-builder.js`.

**Acceptance:** Building twice on the same locked project produces
identical bytes (deterministic). `package_hash` column populated.

---

### WO-19 · Chain-lock pipeline (stub Stripe + witness)
**Goal:** `POST /api/lock/chain` — calls the (stubbed) Stripe and
witness server hooks in sequence: payment → witness signature →
Ravencoin asset mint (mocked) → IPFS pin (mocked) → Arweave upload
(mocked). Updates project status through the lock-state lifecycle.

**Source:** `research/electron-source/lock/lock-chain-lock.js` and the
three executors in `research/electron-source/executors/`.

**Acceptance:** End-to-end UI click on "Chain Lock" with a finalized
project → status flips to `chain_locked`, mock txid stored in
`rvn_txid`, mock CID in `ipfs_cid`. No real money or network.

---

## P5 — Witness + Stripe

### WO-20 · Witness server client
**Goal:** `lib/scruple/witness.ts` thin wrapper around the existing
`http://localhost:5799` API (`POST /api/witness`, `GET /api/witness/:projectId`,
`POST /api/lock/:projectId`, `POST /api/verify`).

**Source:** `research/electron-source/Scruple Server/witness-client.js`
and `witness-index.js`. The witness server itself is at
`/opt/scruple-witness/` — read its current routes there if behavior is
unclear.

**Acceptance:** `await witness.witnessIteration({projectId, runSequence, contentHash})`
returns a real `{witnessId, serverTimestamp, signature}` from the live
:5799 service. Iterations table `witnessed=1` and witness fields
populated after capture (wire into WO-14).

---

### WO-21 · Stripe checkout (real)
**Goal:** Replace the stubbed Stripe in WO-19 with real
`POST /api/stripe/payment-intent` and `POST /api/stripe/confirm`.
Pricing comes from `research/sessions/04-market-pricing.md` ($X per
checkpoint, $Y per chain-lock — pick conservative numbers and document).

**Source:** `research/electron-source/Scruple Server/stripe-client.js`
and `research/electron-source/ipc/ipc-lock-handlers.js`
(`stripe-create-payment-intent` / `stripe-confirm-and-execute`).

**Env vars required:** `STRIPE_SECRET_KEY`,
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.

**Acceptance:** Stripe test-mode payment goes through; `lock-chain` runs
only after payment confirms.

---

### WO-22 · Lock executor orchestration
**Goal:** Replace the mocked executor calls in WO-19 with the real
sequence: witness signature → Ravencoin asset mint (via witness server's
RVN module) → IPFS pin (via witness server) → Arweave commit (via
witness server). Surface progress as SSE events to the workspace.

**Source:** `research/electron-source/lock/lock-chain-lock.js` +
`executors/lock-executor-{server,blockchain,fiat}.js`.

**Acceptance:** Real chain-lock on a test project completes; receipts
return real txids / CIDs; UI shows incremental progress.

---

## P6 — Verification + receipts

### WO-23 · Public receipt page
**Goal:** `app/receipt/[scrId]/page.tsx` — public, unauthenticated.
Renders a project's full provenance receipt: SCR-ID, root, Merkle proof
visualization, witness signatures, on-chain refs (links to Ravencoin
explorer + IPFS gateway + Arweave gateway).

**Source:** `research/specs/scruple-studio-overview.md` describes what a
receipt should communicate. No direct desktop UI to copy.

**Acceptance:** A locked project's receipt loads at
`/receipt/SCR_ABC123` for any visitor. Verifies: hashes recompute
correctly, witness signatures validate against the witness server
public key.

---

### WO-24 · Verify-from-package
**Goal:** `POST /api/verify` — accepts a lock-package JSON file (the
output of WO-18), recomputes Merkle root, returns
`{valid: boolean, computedRoot, expectedRoot, mismatches?}`.

**Source:** Witness server's `POST /api/verify` is the cross-tier
verification; this is the local recompute.

**Acceptance:** Round-trip: build package (WO-18) → upload to /api/verify
→ valid=true. Tamper with one byte in the package → valid=false with
the right mismatch identified.

---

### WO-25 · Export project as ZIP
**Goal:** `GET /api/projects/[id]/export` returns a ZIP containing:
lock-package.json, all artifact images, merkle-tree.json, witness
signatures. Compatible with what the desktop SCRUPLE Studio's import
flow expects (so a project can move between web and desktop).

**Source:** `research/electron-source/lock/lock-package-builder.js`
shows the bundle layout.

**Acceptance:** Export → unzip → desktop SCRUPLE Studio import →
project appears with same SCR-ID and identical hashes. (Desktop import
testing requires a Windows VM; flag if not available.)

---

## P7 — Polish

### WO-26 · Settings page
**Goal:** `/settings` for: provider API keys (fal, ComfyDeploy), Stripe
test/prod toggle, account email, sign-out. Form validation via Zod.
Provider keys encrypted at rest (use Node's `crypto.scrypt` with
`AUTH_SECRET` as the KDF input).

**Acceptance:** Save → reload → values persist. Bad keys (e.g., wrong
fal key) return a 401 from the provider call and surface a useful error.

---

### WO-27 · Search + pagination
**Goal:** Sidebar gets a search box that filters by project name. If a
user has >50 projects the sidebar paginates (load more on scroll).

**Acceptance:** 100 seeded projects, search "cat" returns only those
matching, scroll triggers next page.

---

### WO-28 · Toast / error surface
**Goal:** Single global toast component. All API failures route through
it. Replace any `alert()` or `console.error` left from earlier WOs.

**Acceptance:** Trigger a known error (e.g., generate without a
provider key configured) → toast appears with actionable message and a
"Settings" link.

---

### WO-29 · SSE for live iteration updates
**Goal:** Replace the WO-15 polling with `GET /api/iterations/stream?projectId=...`
SSE. Client subscribes when project is active; auto-disconnects on
deactivate.

**Acceptance:** Generate an image while looking at the workspace →
iteration card appears within 1s of the iteration row being inserted,
without a full page reload.

---

### WO-30 · Telemetry + spend tracking
**Goal:** Insert one `telemetry` row per generation (provider, prompt,
params, cost cents, duration ms). Surface monthly per-user spend in
settings.

**Acceptance:** Generate 5 images → 5 telemetry rows; settings shows
sum.

**Migration:** `lib/db/migrations/004_telemetry.sql`.

---

## DEFERRED (not in v1)

These are referenced in the desktop source but explicitly out-of-scope
for the web port. Open WOs when business case justifies them.

| Concern | Why deferred | Open when… |
|---|---|---|
| RVN wallet UI | Witness server holds the RVN key; users don't need to manage one | Self-hosted Scruple Web tier |
| ArConnect integration | Witness server uploads to Arweave on user's behalf | If users want to pay Arweave fees directly |
| IPFS config UI | Witness server pins via Pinata; users don't choose | Same |
| Training run capture (Kohya_ss) | Requires either a desktop bridge or a hosted Kohya — neither is in scope for the web product | When we build a Scruple-bridged training cloud |
| Pre-flight checklist (training) | Same — training-only feature | Same |
| Folder-browse / setup wizard with paths | Electron-only concept | Never (the web setup is provider connect, not folder pick) |
| Persistent chain-lock | Long-tail; same as chain-lock plus periodic re-anchoring | After v1 ships and users ask |
| TSD micropayment | Witness server already implements; Stripe covers the user-facing pricing | When we go to $X/lock-action volume that micropayments matter |

---

## Conventions

**Per WO commit pattern:**
```
git add .
git commit -m "WO-XX: <short title> — <one line of what changed>"
```

**Update memory after each WO:**
- `memory/STATE.md` — overwrite
- `memory/WO_LOG.md` — append one line: `[ts] WO-XX | <action> | <result>`
- `memory/DECISIONS.md` — append D-NNN if you made an architectural choice
- `memory/DISCOVERIES.md` — append if you found something worth remembering

**Reading order before any WO:**
1. `cat memory/STATE.md memory/CONTEXT.md memory/DECISIONS.md`
2. `git log --oneline -10`
3. Then read the WO and the desktop source files it references.
