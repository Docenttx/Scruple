# WO-6 · Stripe pre-auth + capture-actual session lifecycle

**Scope:** Non-custodial billing. Session opens → Stripe places 1h × machine.hourly_rate HOLD on user card. Session closes → capture actual elapsed cents. Money never lives in Scruple's account.

**Reference:** `docs/architecture/canvas-v2.md` decision 7.

## Files

- `lib/db/migrations/022_canvas_charges.sql` — `canvas_session_charges` table
- `lib/stripe.ts` — extend with `createCanvasHold(userId, machine)`, `captureCanvasCharge(sessionId, actualCents)`, `cancelCanvasHold(sessionId)`
- `app/api/canvas/session/route.ts` — POST creates PaymentIntent (manual capture), stores `payment_intent_id` on session row
- `app/api/canvas/session/heartbeat/route.ts` — NEW: client posts every 30s with `sessionId`; server updates `last_heartbeat`; if no heartbeat in 90s, background reaper finalizes
- `app/api/canvas/session/end/route.ts` — NEW: client posts on explicit End or beforeunload; finalize + capture
- `scripts/canvas-session-reaper.mjs` — background worker (cron or pm2): every 60s, find sessions with stale heartbeat OR Modal container scaledown signal, finalize
- `components/CanvasSessionHUD.tsx` — NEW: small overlay shows machine + elapsed minutes + estimated cost (rate × elapsed / 3600)
- `lib/db/migrations/020_canvas_sessions.sql` — already has `canvas_sessions` from prior WO; ALTER to add `payment_intent_id TEXT`, `last_heartbeat INTEGER`, `accumulated_seconds INTEGER DEFAULT 0`, `finalized_at INTEGER`, `captured_cents INTEGER`

(Use a follow-up migration 023_canvas_session_billing_columns.sql rather than editing 020 in place.)

## Lifecycle

1. POST `/api/canvas/session` (idempotent):
   - if user has open session not expired → return existing
   - else: machine = user's preferred machine; require `user.stripe_customer_id` (UI redirects to /settings/payment if missing)
   - `pi = stripe.paymentIntents.create({ amount: 100 * machine.hourly_rate * 1, currency: 'usd', customer: user.stripe_customer_id, capture_method: 'manual', confirm: true, payment_method: <user default> })`
   - INSERT canvas_sessions row with `payment_intent_id=pi.id`, `started_at=now`, `last_heartbeat=now`, `machine_id`
   - return `{ sessionId, proxyUrl }`

2. Every 30s while iframe alive: POST `/api/canvas/session/heartbeat { sessionId }` → update `last_heartbeat`, increment `accumulated_seconds` by delta

3. End conditions (any):
   - User End button → POST `/api/canvas/session/end { sessionId }`
   - Stale heartbeat → reaper detects, calls finalize internally
   - Modal scaledown webhook → finalize via webhook handler
4. Finalize:
   - `accumulated_cents = ceil(accumulated_seconds * machine.hourly_rate * 100 / 3600)`
   - if `accumulated_cents == 0`: `paymentIntents.cancel(pi.id)`
   - else: `paymentIntents.capture(pi.id, { amount_to_capture: accumulated_cents })`
   - UPDATE canvas_sessions: `finalized_at=now, captured_cents`
   - INSERT canvas_session_charges row (audit trail)

## Verify

- `/settings/payment` → "Add card" works (existing Stripe SetupIntent flow if present, else create)
- `/canvas` first visit while signed-in user has card → session creates, HUD shows machine + $0.00 elapsed
- Manually trigger /end → Stripe dashboard shows captured amount = elapsed × rate / 3600
- Manually expire heartbeat (stop posting) → reaper finalizes within 2 min

## Out of scope

- Custom Machine builds also charge (WO-7 references this lib)
- Refund flows on disputed iterations (parked, ad-hoc)
