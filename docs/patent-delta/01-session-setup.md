# Patent Delta — 01 — Session Setup

**Scruple canonical flow, segment 1 of 5.**

Source: `/data/scruple-web` (feature/pivot)

## Purpose

Trace everything between "user opens canvas" and "session ready for first iteration." Establishes the per-user rented compute, the cryptographic proxy gate, the manifest pinning that makes the toolchain provenance-bearing, and the non-custodial Stripe hold.

## Canonical flow (numbered)

1. **User loads `/canvas`** — `[app/canvas/page.tsx:33-40]` — server component runs `auth()` to verify NextAuth session.

2. **◇ DECISION** — authenticated?
   - NO → redirect to `/login`
   - YES → continue

3. **Resolve user's active Machine** — `[app/canvas/page.tsx:38, lib/compute/getActiveMachine.ts:28-41]` — read `user_settings.compute.machine_id`; fallback to `DEFAULT_MACHINE_ID = 't4-free'`. Machine carries: id, hourlyRateCents, gpuClass, endpointEnvVar, trustTier.

4. **◇ DECISION** — active `canvas_sessions` row exists for this user? `[app/canvas/page.tsx:41, lib/canvas/session.ts:236-245]`
   - YES → skip mint; iframe existing `/canvas-proxy/{sessionId}/`
   - NO → proceed to mint

5. **mintCanvasSessionWithBilling(userId, machineId)** — `[lib/canvas/session.ts:199-234]` — orchestrates session creation + Stripe hold; rolls back the session row if the hold fails.

6. **mintCanvasSession — session row + signed token** — `[lib/canvas/session.ts:129-168]`
   - Look up `MODAL_CANVAS_APP_URL_{MACHINE}` env var ◇ — throw `CanvasMintError('not_deployed')` if unset.
   - Revoke prior active session for this user.
   - Generate `sessionId = cs_{nanoid(10)}`.
   - `expiresAt = now + 3600s` (matches Modal `scaledown_window`).
   - Sign token (HMAC-SHA256) over `{sessionId, userId, machineId, expiresAt}` with `AUTH_SECRET`.
   - INSERT `canvas_sessions` row (id, user_id, machine_id, modal_url, signed_token, expires_at).

7. **ensureStripeCustomer(userId)** — `[lib/stripe/customer.ts:43-66]` — lazily create Stripe Customer; persist `stripe_customer_id` on users row.

8. **createCanvasHold — non-custodial pre-auth** — `[lib/stripe/canvas.ts:44-107]`
   - `holdCents = 1h × machine.hourlyRateCents` (e.g. A100 = 309¢).
   - Resolve default payment method ◇ — throw if no card on file.
   - `paymentIntents.create({ amount: holdCents, capture_method: 'manual', confirm: true, off_session: true, metadata: {...} })` — **KEY: hold placed, NOT auto-captured**.
   - UPDATE `canvas_sessions` SET payment_intent_id, payment_status='held', hold_cents.

9. **Modal container readiness** — `[modal/canvas_app.py:46-118, 195-239]` — per-GPU-class Modal class (ComfyUIT4 / A10G / A100 / H100-CC):
   - Image baked once with ComfyUI v0.18.5 + custom node packs.
   - `@modal.cls(concurrency_limit=1, timeout=3600, scaledown_window=300)`.
   - `@modal.web_server(port=8188)` exposes ComfyUI behind Modal's HTTPS gateway.
   - Container boots on first proxy request (cold-start latency lives here).

10. **Proxy gate activated** — `[app/canvas-proxy/[sessionId]/[...path]/route.ts:81-191]` — browser iframes `/canvas-proxy/{sessionId}/`. **Modal URL is NEVER exposed to the browser.**

11. **End — session ready** — every byte both ways flows through the proxy gate from this point forward.

## Decision diamonds (for flowchart)

| ID | Where | Condition | Branches |
|---|---|---|---|
| D1 | `app/canvas/page.tsx:34-36` | Authenticated? | YES → continue \| NO → `/login` |
| D2 | `app/canvas/page.tsx:41` | Active session exists? | YES → reuse \| NO → mint |
| D3 | `lib/canvas/session.ts:132-138` | Modal deployed for this machine? | YES → continue \| NO → error card |
| D4 | `lib/stripe/canvas.ts:64-74` | Card on file? | YES → place hold \| NO → add-card prompt |
| D5 | `lib/canvas/session.ts:212-234` | Hold placed successfully? | YES → continue \| NO → rollback session row |
| D6 | `app/canvas-proxy/.../route.ts:92-98` | Per-request: session_id owned by caller? | YES → forward \| NO → 403 |

## State writes

| Step | Table | Columns | File:Line |
|---|---|---|---|
| 7 | users | stripe_customer_id | `lib/stripe/customer.ts:62-63` |
| 6 | canvas_sessions | id, user_id, machine_id, modal_url, signed_token, expires_at, status | `lib/canvas/session.ts:159-165` |
| 8 | canvas_sessions | payment_intent_id, payment_status='held', hold_cents, last_heartbeat | `lib/stripe/canvas.ts:95-104` |

## External calls

- **Stripe** — `customers.create`, `paymentIntents.create({ capture_method: 'manual', confirm: true, off_session: true })`
- **Modal** — function endpoint env vars; `web_server` proxies port 8188 of per-user container
- **Google** — NextAuth Google provider (on signin)

## Patent-bearing observations

**Proxy-as-cryptographic-gate (G-2 candidate)** — HTTP+WS reverse proxy at `/canvas-proxy/{sessionId}/[...path]`. Modal URL never exposed to browser. Every request authenticated against `canvas_sessions` row (user_id match + `expires_at > now`). Shared-secret header `X-Scruple-Shared-Secret` forwarded to Modal as defense-in-depth. `[app/canvas-proxy/[sessionId]/[...path]/route.ts:81-109]`

**Non-custodial Stripe pre-auth (G-3 candidate)** — `capture_method='manual'` + `confirm=true` places a hold on the user's card without capturing funds. Hold sits on the card; if uncaptured, the issuer releases after 7-10 days. Scruple never custodies the funds. `[lib/stripe/canvas.ts:76-93]`

**Manifest binding deferred (G-1 boundary)** — Machine manifest is hashed once during the Modal image build (worker) and stored in `machines.manifest_hash`. The hash is NOT bound at session setup; binding happens at output capture in Segment 2. This is the cleanest binding point because the canonical execution is the Modal image's pinned version. `[lib/canvas/manifest.ts:15-72, lib/canvas/witness.ts:110-144]`

## Sub-flowchart candidates

- **Stripe hold lifecycle** (mint → tick → end → capture/cancel) — deserves its own diagram if billing is the audience.
- **Modal class topology** (4 GPU classes, env-var routing) — deserves its own diagram if the compute architecture is the audience.
