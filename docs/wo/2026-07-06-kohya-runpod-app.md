# WO-KOHYA — Kohya as scruple-web Studio app 3, backed by RunPod

## Status
- **Started:** 2026-07-06 (overnight autonomous run, session paused for user travel)
- **Owner:** claude (autonomous)
- **Blocker for full E2E:** user must provide RunPod API key

## Context
- Studio apps live: **Canvas** (ComfyUI on Modal), **Fusion** (Autodesk plug-in phones home)
- Kohya = app 3. Later, Forge = app 4 (parallel structure)
- Kohya = long-running training. RunPod is ~3× cheaper per GPU hour than Modal for
  hours-long jobs. Modal remains the right pick for interactive Canvas.
- Existing electron Studio at `research/electron-source/scruple-studio/` already had
  Kohya IPC handlers, port detection, `training_runs` schema, `detect-kohya-port`,
  `kohya-log`, `kohya-connected`. That code targeted a LOCAL Kohya install; never
  wired to scruple-web. Reuse the *shapes* (hashing surface, table schema, ipc
  contracts) but rewrite for server-side RunPod-hosted flow.
- Kohya's own README ships a RunPod one-click template with a `--share` /
  Cloudflare tunnel option, which likely simplifies pod setup.
- **Stripe:** existing subscription plans must transparently cover jobs on both
  Modal and RunPod. Design a `ComputeBackend` interface with per-provider price
  math; user-facing plan stays one entitlement.

## Phase map

### Phase 0 — Discovery + Design docs

- [ ] Fetch Kohya README + RunPod one-click docs. Confirm the pod comes up with
      the Gradio UI on a known port, and how RunPod exposes it (public HTTP
      endpoint URL vs Cloudflare Tunnel token).
- [ ] Read `research/electron-source/scruple-studio/scruple-studio/ipc/ipc-training-handlers.js`
      and `main-modular.js` lines 33+ (training provenance section) to lift the
      capture shape.
- [ ] Design doc `docs/architecture/apps-abstraction.md`: pattern for adding an
      app to Studio (canvas, fusion, kohya, forge). Nav entry + proxy route +
      session table + intercept.

### Phase 1 — Compute backend abstraction

- [ ] `lib/compute/backends.ts` — new `ComputeBackend` interface:
    ```
    interface ComputeBackend {
      id: 'modal' | 'runpod'
      spawnEndpoint(userId, machineId, appId): Promise<Endpoint>  // returns URL
      terminateEndpoint(endpointId): Promise<void>
      priceCents(endpointId): { holdCents, actualCents }  // per-second capture
    }
    ```
- [ ] `lib/compute/backend-modal.ts` — wrap the existing Modal canvas mint
      logic behind the interface.
- [ ] `lib/compute/backend-runpod.ts` — RunPod SDK client. Env: `RUNPOD_API_KEY`,
      `RUNPOD_KOHYA_TEMPLATE_ID`. Spawn a pod from a template, wait for the
      Gradio port to answer, return the public URL.
- [ ] Refactor canvas mint (`lib/canvas/session.ts`) to call
      `getBackend('modal').spawnEndpoint(...)` instead of inlining Modal URL
      construction. **Non-breaking** — same output, cleaner internals.

### Phase 2 — Studio app-registry + Kohya nav

- [ ] `lib/apps/registry.ts` — declare the app catalog:
    ```
    export const APPS = {
      canvas:    { name: 'ComfyUI', href: '/canvas',       backend: 'modal',  route: '/canvas-proxy' },
      kohya:     { name: 'Kohya',   href: '/apps/kohya',   backend: 'runpod', route: '/kohya-proxy' },
      fusion:    { name: 'Fusion',  href: '/embed/fusion', backend: 'local',  route: null },
      // forge:  … app 4
    }
    ```
- [ ] Left-nav in `components/AppShell.tsx` reads registry, renders one link per
      app, adds a "New app…" ghost tile.
- [ ] `app/apps/kohya/page.tsx` — the same pattern canvas uses: mint a
      `kohya_sessions` row, hand off to iframe against `/kohya-proxy/<sid>/`.
- [ ] Migration `023_kohya_sessions.sql` — parallels `canvas_sessions`. Columns:
      `id, user_id, backend, endpoint_url, status, started_at, expires_at,
      hourly_rate_cents, machine_id`.

### Phase 3 — HTTP proxy + WS bridge for Kohya

- [ ] `app/kohya-proxy/[sessionId]/[[...path]]/route.ts` — copy the canvas-proxy
      route almost verbatim. Same auth + shared secret + `<base href>` injection
      + fetch/XHR/WS shim + cold-start shell. Differences:
    - subPath intercept: Kohya uses Gradio's `/gradio_api/run/predict` (or
      similar). Identify the actual endpoints that mark "training started" and
      "checkpoint saved" from Kohya. May need a Gradio middleware.
    - WS shim: Kohya doesn't need `?clientId=X` routing (Gradio's WS is per-
      queue). Shim can pass through the query as-is.
- [ ] Generalize `canvas-ws-proxy.mjs` → `apps-ws-proxy.mjs` — takes any app id,
      looks up the correct sessions table. Or keep them separate to reduce
      blast radius; parallel `kohya-ws-proxy.mjs` on :8191.
- [ ] Cloudflare tunnel: add `scruple-kohya-ws.stooges.ai` → :8191 (level-2
      subdomain for Universal SSL; same lesson from canvas).

### Phase 4 — Provenance capture

- [ ] `lib/apps/kohya/capture.ts` — port `training-hasher` from electron Studio.
      Server-side hashers for base model (chunked, progress), dataset (per-image
      + merkle), checkpoint safetensors. Reuse the safetensors header parser
      already at `lib/scruple/safetensors.ts`.
- [ ] Kohya-side capture surface: hook into Kohya's `save_state` /
      `save_model_weights` writer. Options:
    - Add a small monkey-patch shim into the RunPod pod's start command that
      wraps `kohya_ss.train_network.save_state` and POSTs to our
      `/api/apps/kohya/witness` on each save
    - Or use a Kohya extension/callback if available
- [ ] `/api/apps/kohya/witness` POST endpoint. Body: `{sessionId, event, hashes,
      structural_summary}`. Server:
    - looks up the user's active project (or auto-create one)
    - inserts into `training_runs` with `source='kohya_ss'` (existing schema
      already supports this — CAP-6 shipped it)
    - calls the existing `startWorkflow` / `captureOutput` flow for leaf
      hashing + witness server signature

### Phase 5 — Stripe billing bifurcation

- [ ] `lib/compute/pricing.ts` — one table per backend per machine class. When
      minting a session, we know backend + machine, so we know per-second rate.
- [ ] `lib/stripe/pay.ts` — `createHold({ backend, hourlyRateCents })` is
      backend-neutral. Metadata: `backend`, `machineId`, `sessionId`.
- [ ] Capture flow (existing) already takes actual elapsed time; unchanged.
- [ ] Subscription plans: the existing `pro` / `enterprise` plans give a monthly
      GPU-credit pool. Each session decrements the pool by
      `actual_seconds * per_second_rate`. Backend agnostic.

### Phase 6 — Kohya-specific UI/UX

- [ ] `components/apps/kohya/KohyaLaunchCard.tsx` — pick base model, dataset
      (Drive picker → download to pod), rank/steps/lr, machine class. Similar
      shape to the CanvasBridge preflight.
- [ ] `components/apps/kohya/TrainingProgressPill.tsx` — polls `/api/apps/kohya/
      training/<sessionId>/status` every 5s. Shows step count, ETA, loss.
- [ ] On completion: pull the final safetensors, upload to user's Drive under
      `Scruple Projects/training/<scr_id>/`. Same pattern as the overnight LoRA
      driver from 2026-07-06.

### Phase 7 — E2E smoke (BLOCKED on RunPod API key)

- [ ] User provides `RUNPOD_API_KEY` in `.env.local`
- [ ] Build the Kohya container image on RunPod and register the template ID
- [ ] Real training run through Studio: pick model, kick off, watch progress,
      see safetensors delivered to Drive with witnessed leaf + optional chain
      lock
- [ ] Full receipt for the training run

### Follow-ups (post-blocker)

- [ ] Move canvas to the same registry pattern (currently hardcoded)
- [ ] Forge as app 4 — same structure, different capture surface (Gradio image
      save)
- [ ] Modal-backed Kohya as fallback for users without a RunPod plan

## Files touched (planned)

- `lib/compute/backends.ts` (new)
- `lib/compute/backend-modal.ts` (new)
- `lib/compute/backend-runpod.ts` (new)
- `lib/compute/pricing.ts` (new)
- `lib/apps/registry.ts` (new)
- `lib/apps/kohya/capture.ts` (new)
- `app/apps/kohya/page.tsx` (new)
- `app/kohya-proxy/[sessionId]/[[...path]]/route.ts` (new)
- `app/api/apps/kohya/session/route.ts` (new)
- `app/api/apps/kohya/witness/route.ts` (new)
- `scripts/kohya-ws-proxy.mjs` (new, or generalized)
- `data/migrations/023_kohya_sessions.sql` (new)
- `components/AppShell.tsx` (edit — nav from registry)
- `lib/canvas/session.ts` (edit — go through backend interface)
- `.env.local` (add `RUNPOD_API_KEY`, `RUNPOD_KOHYA_TEMPLATE_ID`)
- `/etc/cloudflared/config.yml` (add scruple-kohya-ws hostname)

## Sequencing note

Phases 0–5 can be built and merged without the RunPod key. Phase 7 needs it.
Phase 6 UI can be built stubbed against a fake endpoint. Progress until blocked.
