# Canvas v2 Architecture — locked 2026-06-22

**Status:** decided, **not yet built**. Today's commit `1a850ca` (canvas-on-modal first pass) is partly wrong direction and needs targeted rebuild per this doc. Compute Stage 1 (`d7d3f6a`) needs the user-tier concept ripped out.

**Origin of the rethink:** seedvr2 workflow failed on Modal because the per-request runner image didn't have the node (today's bug). Walking back from that fix surfaced that the whole two-ComfyUI split (on-host CPU canvas + per-request Modal runner) is the wrong architecture for the paid product. Multiple rounds of stripping over-engineered solutions landed on the model below.

## One-paragraph summary

scruple-web is a paid-only SaaS. Every authenticated user pays per use; no recurring tiers, no Free plan, no allow-lists. Each user gets their own Modal-hosted ComfyUI session container reachable through a scruple-web HTTP+WS proxy — the proxy IS the provenance gate (sees every workflow in, every output out). Sessions are non-custodial billed via Stripe pre-auth + capture-actual. Each user shares a default Modal image with a curated 7-pack node catalog; users can opt in to a paid Custom Machine setting to get their own pinned manifest, in which case the manifest hash is committed into the v2.2 chain leaf as provenance-bearing creative input. Receipt publication is per-iteration: Full / Hash-only / Witness-only — pure presentation, no protocol change.

The free product is **Scruple Studio Desktop** — separate codebase, user's own GPU, localhost provenance. Not scruple-web's concern.

## Architecture diagram

```
Browser
   │  HTTPS + WSS to scruple.stooges.ai only
   ▼
scruple-web (Next.js on Oracle box)
   │  /canvas-proxy/[sessionId]/[...path]
   │  HTTP proxy (Next.js route)
   │  WS proxy (Node sidecar at :8190, behind CF tunnel)
   │  ──── on every /prompt POST: capture workflow JSON for ingest
   │  ──── on every /view GET: capture output bytes for ingest
   │
   │  HTTP+WS to Modal, with shared-secret header
   ▼
Modal (private endpoint per machine class)
   │  scruple-canvas app, one container per (user, machine) pair
   │  @modal.cls(gpu=…, scaledown_window=300, concurrency_limit=1, timeout=3600)
   │  @modal.web_server(port=8188) → ComfyUI server inside
   │  Image baked from user's manifest (default OR custom)
   ▼
ComfyUI runs normally (GPU local to its Python process)
```

## Locked decisions

### 1. No user tiers
- scruple-web is paid-only. Anyone signed in has (or is required to add) a Stripe payment method.
- All four machines (T4 / A10G / A100 / H100-CC) are available to anyone with a card on file.
- `lib/compute/userPlan.ts` → **delete entirely**.
- `lib/compute/machines.ts` → drop `allowedPlans`, `tierLabel`, `DEFAULT_MACHINE_BY_PLAN`, `getMachineCatalogForPlan`, `getDefaultMachineForPlan`.
- `getActiveMachine` → drop plan validation; fall back to global default (T4) for first-use.
- `/api/settings/compute` POST → drop tier-403 path.
- `/api/canvas/session` POST → only check is "has Stripe customer on file."
- `ComputeSection.tsx` → drop Free/Pro/Premium chrome; show all machines.
- `CanvasLauncher.tsx` → drop tier-gated Free upgrade CTA.
- `SCRUPLE_ENTERPRISE_EMAILS` env var → vestigial; remove from `.env.local`.

### 2. Canvas-on-Modal via server-side proxy as the gate
- Each paid user gets their own Modal container running ComfyUI via `@modal.web_server(port=8188)`.
- scruple-web is a transparent HTTP+WS proxy at `app/canvas-proxy/[sessionId]/[...path]/route.ts` (HTTP) + `scripts/canvas-ws-proxy.mjs` (Node ws sidecar at `:8190`, routed via CF tunnel).
- Modal endpoint URL never reaches the browser. Modal requires shared-secret header that only scruple-web's server sets.
- Provenance capture happens inside the proxy code (server-side), not in client-side JS or in-graph nodes.
- **Reverts from today's commit `1a850ca`:**
  - Delete `custom_nodes/scruple_nodes/js/scruple-canvas-witness.js` — bypassable; superseded by proxy
  - Delete `app/api/canvas/witness/start/route.ts` + `complete/route.ts` (POSTed by browser JS) — refactor into internal `lib/canvas/witness.ts` called by the proxy
  - Delete `components/CanvasLauncher.tsx` (button + tier-CTA) — `/canvas` auto-launches on visit
  - Refactor `app/canvas/page.tsx` to single render branch (no free / no-session / with-session conditionals)
  - Drop the `?t=<token>` URL pattern → session id lives in proxy path, Modal URL stays private
  - Drop the `CanvasBridge.tsx` witness-event handlers (lines ~169-235 of the file added today)
- On-host CPU canvas at `canvas.stooges.ai` retired from product surface. Free product is desktop Scruple Studio.

### 3. Per-user Machine with manifest-as-provenance
- Each user defaults to a shared `default-scruple-canvas-v1` machine (everyone gets the same image, same `manifest_hash`).
- Opt-in paid setting: **Custom Machine** — user gets a personal `machines` row, editable manifest, their own image built on Modal.
- Manifest format:
  ```json
  {
    "comfyui_version": "v0.18.5",
    "custom_nodes": [
      { "pack": "easy-use", "repo": "yolain/ComfyUI-Easy-Use", "ref": "v1.3.6", "commit_sha": "<pinned>" },
      …
    ]
  }
  ```
- `manifest_hash = sha256(canonical(manifest_json))` — pinned commit shas ensure byte-reproducibility.
- When the user changes their manifest: write new `machines` row with `build_status='pending'`, background worker calls Modal's image-build API, ~5–15 min build, then `build_status='ready'` with the resulting `image_digest`. Next session uses new image; current session unaffected.
- Image storage cost (~$0.025/GB/month × ~10GB per image) is modest; old machine rows retained forever for receipt back-references.

### 4. Default catalog (7 packs, baked into `default-scruple-canvas-v1`)
- `comfyanonymous/ComfyUI @ v0.18.5` — core
- `yolain/ComfyUI-Easy-Use @ v1.3.6`
- `Kosinkadink/ComfyUI-VideoHelperSuite @ pinned-commit`
- `Kosinkadink/ComfyUI-Advanced-ControlNet @ pinned-commit`
- `cubiq/ComfyUI_IPAdapter_plus @ pinned-commit`
- `Kosinkadink/ComfyUI-AnimateDiff-Evolved @ pinned-commit`
- our `scruple-canvas-fork/seedvr2_videoupscaler @ scruple-canvas-fork` branch
- **scruple_nodes is REMOVED.** All four classes (`ScrupleStudioTerminal`, `ScrupleTrainingTerminal`, `ScrupleTap`, `ScrupleOutputCapture`) are legacy from the desktop Electron Studio (target localhost:5742). Both JS bridges (`scruple-queue-intercept.js`, `scruple-canvas-witness.js`) are obsolete in the proxy model.

### 5. Leaf v2.2 — manifest hash in provenance preimage
```
sha256(canonical({
  run_sequence,
  output_hash,
  input_hash,
  workflow_hash,
  model_fingerprints_hash,
  machine_manifest_hash,        ← NEW
  server_timestamp,
  prev_record_hash,
}))
```
- Leaf scheme bump to `v2.2`. v2.1 fallback retained in the audit script for legacy iterations.
- Witness server canonical record gets a new field. Schema migration on `witnesses` table + `iterations` table.
- Audit script `scripts/audit-receipts.py` re-derives the v2.2 hash and verifies.

### 6. Three publication modes per iteration (presentation layer only)
- `iterations.workflow_publication TEXT NOT NULL DEFAULT 'full'` ∈ { `full`, `hash-only`, `witness-only` }
- **No protocol change**: leaf always commits to the full preimage; this column only controls what the public `/receipt/<SCR-ID>` renders.
- `full` — all hashes shown, verifier can byte-reproduce if artist shares workflow JSON
- `hash-only` — output_hash + manifest_hash + timestamp; workflow_hash withheld from receipt
- `witness-only` — only "this artist witnessed this output at this time"; everything else withheld
- Artist can upgrade publication later (redaction is reversible — once published, always public); cannot downgrade.

### 7. Stripe non-custodial per-session billing
- At session launch: `paymentIntent.create({ capture_method: 'manual', amount: 1h × machine.hourly_rate, customer: user.stripe_customer_id })` — Stripe places a HOLD on the user's card.
- Session runs. We track `accumulated_seconds × hourly_rate / 3600 = accumulated_cents`.
- At session end (user End / idle scaledown / 1h cap / browser disconnect heartbeat): `paymentIntent.capture({ amount_to_capture: accumulated_cents })` — Stripe moves only the actual amount from user → Scruple. Releases unused hold.
- If `accumulated_cents == 0`: `paymentIntent.cancel()` releases the hold entirely.
- Money never lives in Scruple's account. Card hold sits on user's card.
- Canvas sessions are **Stripe-only**. RVN can't do per-second billing on UTXO chains.

### 8. PaymentMode (existing) governs chain locks + machine builds
- Existing `lib/settings/user.ts` `payment_mode: 'fiat' | 'blockchain'` is unchanged.
- Controls chain-lock issuer:
  - `fiat` → Scruple wallet mints SCR-XXX, Stripe charges user. Cleaner third-party witness story.
  - `blockchain` → user's RVN wallet mints SCR-XXX directly. Stronger first-party identity claim on-chain.
- Same toggle applies to paid machine builds.
- Receipt UI should clearly show issuer mode (icon for "Scruple-issued" vs "user-issued") so verifiers know the chain-of-custody trail.

### 9. Asset semantics
- RVN assets are immutable by design — cannot be deleted; only transferred / burned to an unspendable address.
- Mint all assets with `reissuable=false` so metadata pointer is locked at creation.
- IPFS via pin (`pinned` tier) is persistent; Arweave is permanent by design.
- Sub-assets (`PARENT/CHILD`) parked until demand signal — fits use cases like children's books / film scenes naturally, no architectural blockers.

### 10. Settings surface (v1 final)
```
Settings → Payment
  Default for one-shot charges (chain locks, machine builds):
    ◉ Stripe (fiat)  ○ RVN wallet (non-custodial)
  Canvas sessions: Stripe required, billed per-second
    [Manage Stripe card]

Settings → Provenance Add-ons
  ☐ Custom Machine — your own pinned node manifest, hash committed to every iteration
       (Charge per image build, charged at the PaymentMode above.
        When off: shared default-scruple-canvas-v1 machine.)
  ☐ Triple-chain lock by default — RVN + IPFS + Arweave (vs RVN-only basic)
       (Override per-lock at the lock dialog.)

Settings → Compute
  Default machine for canvas sessions:
    ◉ T4 ($0.59/hr — default)
    ○ A10G ($1.10/hr)
    ○ A100 ($3.09/hr)
    ○ H100-CC ($4.56/hr — L1+L2+L3 trust tier, TEE attested)
  (Pre-auth per session = 1h × picked machine rate; capture = actual usage.)

Settings → Receipt Publication
  Default mode for new iterations:
    ◉ Full  ○ Hash-only  ○ Witness-only
  (Override per iteration in the workspace.)
```

## What stays from today's commits

| Commit | What's keepable | What needs rewrite |
|---|---|---|
| `d7d3f6a` (Compute Stage 1) | machines.ts as a base, Settings → Compute scaffold, migration 019 `iterations.compute_machine_id` | Strip the tier system (`userPlan`, `allowedPlans`, etc.); switch ComputeSection.tsx away from tier-filtered list |
| `1a850ca` (canvas-on-modal first pass) | `modal/canvas_app.py` is the right shape; migration 020 (`canvas_sessions`, `canvas_pending_iterations`); `lib/canvas/session.ts` HMAC helpers (the token concept can be repurposed as proxy-internal session id) | Drop `scruple-canvas-witness.js`; drop `/api/canvas/witness/*` browser-facing routes; drop `CanvasLauncher`; refactor `/canvas/page.tsx` to single-path; replace iframe-direct-to-Modal with proxy |
| Migration 019 + 020 | both stay | n/a |
| `1a850ca` WO doc | the architectural reasoning + Modal app code; mark explicitly that the JS-intercept pattern is superseded | Add an addendum or supersession note at top |
| scruple_nodes fork pattern | the fork in `external/scruple-nodes/` is good infrastructure | scruple_nodes itself is dead code; remove from default catalog; consider archiving or pruning the legacy custom-nodes path entirely |

## Build plan (NOT yet executed; for next session)

Order matters; each step is mostly independent.

1. **Tactical seedvr2 fix** — add VideoHelperSuite + seedvr2 to `modal/scruple_runner.py` + `modal deploy`. Unblocks today's existing /api/generate path immediately. ~10 min user-side. Independent of v2 architecture.
2. **Rip out user-tier concept.** Delete `lib/compute/userPlan.ts`. Simplify `machines.ts`. Update `getActiveMachine.ts`. Update `/api/settings/compute`. Update `ComputeSection.tsx`. Delete `SCRUPLE_PRO_EMAILS` / `SCRUPLE_ENTERPRISE_EMAILS` from `.env.local`.
3. **Schema for canvas v2.** Migration 021: `machines` table (per-user manifests, build_status, image_digest); `machine_versions` table (time-series snapshots); leaf v2.2 fields on iterations + witnesses.
4. **Default manifest config.** `config/default-machine-manifest.json` (or `lib/canvas/default-manifest.ts`) — the 7-pack canonical list with pinned commit shas.
5. **Modal build pipeline.** Programmatic image builds via Modal API. Background worker that polls build status. Updates `machines` rows.
6. **HTTP proxy.** `app/canvas-proxy/[sessionId]/[...path]/route.ts` — Next.js streaming proxy, validates session ownership, forwards to Modal with shared-secret header, captures `/prompt` POSTs and `/view` GETs into `lib/canvas/witness.ts` → `ingestIteration`.
7. **WS proxy.** `scripts/canvas-ws-proxy.mjs` — Node `ws` sidecar at `:8190`. Add CF tunnel hostname + route.
8. **Modal endpoint shared-secret auth.** `modal/canvas_app.py` adds an aiohttp middleware that rejects requests without the secret header.
9. **`/api/canvas/session` rewrite.** Mints session id (no token in URL anymore); creates Stripe PaymentIntent with manual capture; returns proxy URL.
10. **`/canvas/page.tsx` rewrite.** Single render branch — auto-mints (or reuses) session, renders `<iframe src={`/canvas-proxy/${sessionId}/`}>`.
11. **Session-end pipeline.** Heartbeat from canvas page (or Modal webhook on container scaledown) → finalize → `paymentIntent.capture()` → write `canvas_session_charges` row.
12. **Leaf v2.2 + witness server.** Update witness server to canonicalize new field; update `ingestIteration` to pass `machine_manifest_hash`; bump leaf_scheme.
13. **Three publication modes.** Add `workflow_publication` to iteration row; update receipt page to redact per mode; default-mode setting in Settings.
14. **Settings → Provenance Add-ons.** Custom Machine toggle (purchases an image build); Triple-chain default (existing chain-tier knob, relocate).
15. **Settings → Payment.** Restructure to be clear about Stripe-for-canvas vs Stripe/RVN-for-other-charges.
16. **Manifest editor UI** (under Custom Machine when toggled on). List nodes, add from search, pin versions, save → triggers build.
17. **Workflow validity pre-check.** At /prompt time (in proxy), check workflow's `class_type`s against machine's manifest; if mismatch → return 409 with "missing node X — add to your machine?" payload; canvas UI offers a one-click rebuild.
18. **Receipt UI updates.** Machine details block (manifest renderer + diff vs prior versions); publication-mode redaction; issuer-mode icon for chain lock.
19. **Audit script.** v2.2 hash re-derivation; new fields; publication-mode awareness.
20. **Smoke + commit + memory update.**

## Parked (won't build until demand signal)

- **Sub-assets** (`PARENT/CHILD` Ravencoin naming) for project hierarchies — fits children's-book / film-scene use cases naturally. Adding later doesn't restructure existing data; only adds new mint paths.
- **Per-workflow machine override** (Stage 3 of compute) — pick machine per-Queue inside the canvas, not at session start.
- **`ScrupleWebTerminal` in-graph witness node** — the proxy model makes it unnecessary at v1. Reserve as defense-in-depth for the case where someone obtains a Modal URL directly (which the shared-secret header already blocks at the proxy layer).
- **`min_containers` warm pools** — cold-start tolerance accepted per directive. Revisit if user-felt latency becomes a complaint.
- **Modal vendor migration** — RunPod / Lambda / etc. The proxy abstraction makes this a one-file change later if Modal pricing or reliability shifts. Don't pre-optimize.

## Open follow-ups (from earlier work, still standing)

These are unrelated to canvas v2 but live in the same `feature/pivot` branch:

- **M-2 hash-on-upload** for `fetch_to_volume` (Modal-side, model integrity at upload time)
- **Audit script log/data split** (from 2026-06-08 session — log-band checks expire after journalctl window)
- **Lock-signature unification** (four witness-server sites sign different tuples; unify so "action in tuple → no replay" property holds system-wide)

## Reversibility from current state

If the v2 build hits a wall and we need to back out:
- Today's commits are on `feature/pivot`; revert `1a850ca` and `d7d3f6a` if needed
- Migrations 019 and 020 are additive (new columns / tables); safe to leave
- The tactical seedvr2 fix (step 1 above) is independent of v2 and uses the existing /api/generate path → it's a no-regret immediate ship regardless of v2 status

## Next session pickup

1. Read this doc (`docs/architecture/canvas-v2.md`)
2. Read the relevant memory entry (`project_canvas_v2_architecture_2026_06_22`)
3. Confirm picture with user; tactical seedvr2 fix is independent — can ship first
4. Start at step 1 of build plan
