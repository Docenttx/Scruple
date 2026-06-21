# WO 2026-06-21 — Compute Stage 3: Per-workflow machine override (canvas UI)

**Predecessors:** Stage 1 (tier-gated catalog picker in Settings), Stage 2 (user-created machines). Stage 3 closes the ComfyDeploy "deploy same workflow to multiple machines" pattern: from the canvas, override the **active machine** for one Queue. Lets a user test on T4 cheap then run on H100 for production, same workflow JSON.

Don't build Stage 3 until you have signal that users genuinely need it. The vast majority will be happy with their settings-level default machine.

## Goal

In the on-host ComfyUI canvas (`canvas.stooges.ai`), the user can pick a machine for the current Queue without leaving the canvas. Default = their Settings active machine. The choice is per-Queue, not persisted.

## Architecture additions to Stages 1 & 2

```
Scruple Queue Intercept extension (JS in scruple_nodes/js/)
  - Inject machine picker dropdown next to the existing Queue button
  - Populates from /api/settings/compute (GET) — uses the same allowed list
  - Stores last-picked in localStorage (session memory, not server-side)
  - On Queue click, posts { workflow, machine_id_override } via postMessage
    to the parent CanvasBridge

CanvasBridge.tsx
  - Reads machine_id_override from the postMessage
  - POSTs { workflowApiJson, machine_id_override } to /api/generate

/api/generate
  - If machine_id_override is present AND tier-permitted, use it instead of
    getActiveMachine. Logged as "override" in the iteration row.
  - If machine_id_override is present BUT tier-forbidden, return 403 with a
    clear error the canvas can toast.
```

## Scope (in detail)

1. **`custom_nodes/scruple_nodes/js/scruple-queue-intercept.js`** — extend the existing Queue interceptor:
   - Fetch the user's allowed machines from `/api/settings/compute` (parent → child via postMessage handshake)
   - Render a `<select>` next to the Queue button labeled "Run on:"
   - Inject the selection into the `scruple:queue-prompt` postMessage payload
   - Persist last choice in `localStorage` keyed by `scruple-active-machine-override`
2. **`components/CanvasBridge.tsx`** — accept `machine_id_override` in the postMessage payload; include it in the `/api/generate` request body.
3. **`app/api/generate/route.ts`** — accept `machine_id_override` in the body. If present, validate against user's tier (same check as PATCH on `/api/settings/compute`); if valid, use it; otherwise 403.
4. **Iteration record** — store `machine_id_override` (TEXT NULL) so the receipt distinguishes "user override" from "settings default". Add a sub-field to the receipt's Hardware block.
5. **Audit script** — when `machine_id_override` is set on a row, validate it was tier-permitted at iteration time. Requires a historical tier lookup — punt to Stage-3.5 if not feasible.
6. **Cost preview in canvas** — optional but nice: render expected duration × GPU rate as a tooltip on the picker. Pulls from the catalog.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| User can override to a tier they don't have, via DevTools | medium | Backend validates EVERY request (the override is just a hint, not the truth); 403 on mismatch |
| canvas iframe origin issues with postMessage | low | Already solved by CanvasBridge in Stage 0 |
| User accidentally runs an expensive job by leaving H100 selected | medium | Show confirmation prompt when picker is set to a machine costing >5× the user's settings default for this Queue |
| Receipt provenance unclear about which machine ran | low | Render BOTH `machine_id` (used) and `machine_id_default` (user's setting at the time) on the receipt |

## Success criteria

- [ ] Picker UI in canvas
- [ ] Override path through CanvasBridge
- [ ] Backend tier-validation
- [ ] Iteration row + receipt reflect override
- [ ] No regression for users who don't use the picker (their default machine still runs)

## Why this isn't Stage 1 or 2

Stage 1: ships transparency + tier-gated default. 95% of users never want more.
Stage 2: ships user-created machines. The power users have THEIR machine, run everything on it.
Stage 3: ships per-run choice. Only matters if a power user has multiple machines AND wants to test-on-cheap-then-prod-on-expensive within a single canvas session.

Realistic order: build Stages 1+2 → see if 5+ users with multiple machines emerge in usage logs → build Stage 3 with their actual feedback. If nobody creates multiple machines, Stage 3 was speculative work and we saved the time.
