# WO-7 · Per-user Machine + Modal build pipeline

**Scope:** Users default to `default-scruple-canvas-v1`. Opt-in "Custom Machine" → user's own pinned manifest → personal Modal image built on demand.

**Reference:** `docs/architecture/canvas-v2.md` decisions 3, 4.

## Files

- `lib/canvas/machineBuild.ts` — `buildMachineImage(machineId): Promise<void>` — calls Modal API, polls build status, updates `machines.build_status` and `modal_image_digest`
- `scripts/machine-build-worker.mjs` — pm2 worker that polls `machines WHERE build_status='pending'` every 30s, runs builds (concurrency=1)
- `app/api/machines/route.ts` — POST: create/update user's custom machine (manifest editor saves here); GET: list user's machines + default
- `app/api/machines/[id]/build/route.ts` — POST: kick off build (charges user via Stripe one-time per PaymentMode)
- `lib/canvas/buildModalImage.ts` — programmatic image build (generates a `.py` ad-hoc with the manifest, modal-builds it, captures resulting image digest)
- `modal/canvas_app.py` — extend with one `@modal.cls` per machine id (or dynamic lookup); the container image is selected by the proxy when minting the session

## Build flow

1. User clicks "Custom Machine" + edits manifest in Settings → save → POST `/api/machines`
2. Server creates `machines` row with `build_status='pending'` + Stripe one-time charge (~$0.50 for the build minutes; capture flow per PaymentMode)
3. Worker picks up row → calls `buildMachineImage`:
   - generates ad-hoc Python file: `modal_image_<machine_id>.py` with `modal.Image.debian_slim(...).run_commands(...)` per manifest
   - `modal deploy modal_image_<machine_id>.py` (or `modal app run` for the lookup)
   - poll status; on success → `build_status='ready'`, `modal_image_digest=<sha>`
   - on failure → `build_status='failed'`, `build_error=<stderr>`, refund the Stripe charge
4. Subsequent canvas sessions for this user select the new image (machines.modal_image_digest)

## Verify

- Default machine starts in `build_status='pending'`; worker builds it on first deploy; flips to `'ready'`
- New custom machine: insert row → worker picks up → image builds → flip to 'ready' within 15 min
- Failure case: insert manifest with bad ref → fails → row marked, error stored
- Canvas session for user with custom machine uses that image (Modal logs show distinct image digest)

## Out of scope

- Manifest editor UI (WO-11)
- Workflow validity pre-check (WO-11)
