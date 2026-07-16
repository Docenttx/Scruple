# WO-FUS-STRIPE — Scruple Fusion in-palette Stripe payment

## Status
- **Started:** 2026-07-16
- **Owner:** claude
- **Prereq:** none (all backend already exists in scruple-web)
- **Out of scope:** install fee. That is license-based at download and lives outside the palette.

## Context

The Fusion palette is a Qt WebEngine (Chromium) webview that loads
`scruple-web`'s `/embed/fusion` React page. Today, the lock/checkpoint/C2PA
buttons fire actions to the Python bridge, which hits scruple-web APIs,
and — for paid actions — opens the system browser to Stripe Checkout.
This WO removes that browser handoff: the user adds a payment method
inside the palette once, then every paid action confirms in-palette
via Stripe.js Elements.

**All Stripe backend already exists** — see `/data/scruple-web/app/api/stripe/*`
and `/data/scruple-web/components/wallet/StripePaymentModal.tsx` +
`/data/scruple-web/components/settings/AddPaymentMethodModal.tsx`. This WO
is 100% wiring on top of existing infrastructure.

## Pricing (subject to product confirmation)

| Action | Price | Description |
|---|---|---|
| Checkpoint | $5 | Publish a per-iteration receipt page |
| C2PA sign | $10 | Emit a C2PA v2.x signed manifest for the export |
| Chain-lock | $100 | Merkle root anchored to a public ledger with pinned tier |

These live in a single catalog module and are surfaced to the palette via
`/api/stripe/config`.

## Phase map

### Phase 1 — Price catalog + config API

- [ ] Create `lib/pricing/actions.ts` exporting a typed catalog:
      `{ checkpoint: 500, c2pa: 1000, chain_lock_pinned: 10000 }` (cents).
- [ ] Extend `/api/stripe/config` response with an `actions` object mirroring
      the catalog. Publishable key + prices returned in one round-trip.
- [ ] Server-side: every existing paid route
      (`/api/lock/checkpoint`, `/api/lock/local`, `/api/lock/chain`)
      reads its amount from the catalog rather than a route-local constant.
      Single source of truth.

### Phase 2 — Palette settings tab

- [ ] Add a "Settings" tab in `FusionPalette.tsx` with a Payment section.
      Two subviews:
      - "No payment method on file" — CTA button "Add card" that mounts
        the existing `AddPaymentMethodModal`.
      - "Payment methods (N)" — list of cards from
        `GET /api/stripe/payment-methods`, each with brand + last4 +
        default badge + [Set default] [Remove] actions using the existing
        `/api/stripe/payment-method/:id` endpoints.
- [ ] On first mount, palette fetches methods once and caches in state.
      Refreshes after add/remove/set-default.

### Phase 3 — Fee gate on action buttons

- [ ] Palette derives `hasDefaultPaymentMethod` from the fetched methods.
- [ ] Every paid action button (`Checkpoint`, `C2PA`, `Chain-lock`) reads:
      - `hasDefaultPaymentMethod === false` → button greyed, tooltip
        "Set up a payment method to enable" + link to Settings tab.
      - `true` → label reads `Checkpoint · $5`, `C2PA · $10`,
        `Chain-lock · $100`. Prices sourced from the fetched config.

### Phase 4 — In-palette payment confirmation

- [ ] Create `components/fusion/InPalettePaymentModal.tsx` — a slim variant
      of `StripePaymentModal` for the palette dimensions. Behaviour:
      - Opens on paid-action click.
      - Shows: action name, price, card summary ("Visa ····4242"),
        `[Cancel]` `[Confirm charge]`.
      - `Confirm` → `POST /api/stripe/payment-intent` with `{action, projectId}`
        → returns `client_secret` → `stripe.confirmPayment({client_secret,
        payment_method: default_pm_id, return_url: undefined,
        confirmParams: {}, redirect: 'if_required'})`.
      - On `succeeded` → resolves with `pi_XXX`.
      - On `requires_action` (3DS) → attempt inline challenge via Stripe.js.
        If the webview rejects the iframe (Fusion may block cross-origin
        3DS frames), fall back to Phase 5.
- [ ] Wire the modal into each paid-action button in `FusionPalette.tsx`.
      Modal resolve → send action to Python bridge with the confirmed
      `pi_XXX` in payload → Python calls the lock/checkpoint route as
      today, no server-side change.

### Phase 5 — 3DS browser fallback

- [ ] If `confirmPayment` returns an unhandleable `requires_action`, palette
      shows a one-shot fallback: "This card requires an extra step. Continue
      in browser?" `[Continue]` opens system browser to a lightweight
      `/pay/3ds/<pi>` route on scruple.ai that finishes the 3DS challenge and
      redirects to `scruple://payment-complete?pi=pi_XXX`.
- [ ] Python URL-scheme handler (already exists at `lib/palette_host.py`
      `CallbackServer`) catches the callback and forwards the `pi_XXX`
      back to the palette via `sendInfoToHTML('payment_confirmed', ...)`.

### Phase 6 — Python bridge simplification

- [ ] Delete `run_dev_stripe_pay` from `lib/lock_flow.py` (headless dev
      helper) and the `paymentRequired`-branch browser open in
      `ScrupleFusion.py`. Python bridge for paid actions now assumes the
      palette hands it a confirmed `pi_XXX`; if the palette omits it, the
      bridge errors "payment_required — palette must confirm before dispatch."
- [ ] Update `test_lock_flow_live.py` to reflect the new contract.

### Phase 7 — Smoke + docs

- [ ] Manual smoke on live Fusion:
      - Fresh install, no PM → paid buttons greyed.
      - Add card → Elements mount → succeed.
      - Click Checkpoint → in-palette modal → confirm → receipt appears.
      - Click Chain-lock → in-palette modal → confirm → ledger anchor lands.
      - Trigger 3DS test card (`4000 0025 0000 3155`) → browser fallback
        completes → palette receives confirmation → action continues.
- [ ] Update `README.md` and `BUILD_PLAN.md`: single-payment flow, no
      browser handoff for the normal path.
- [ ] Add memory `project_fusion_stripe_in_palette_2026_07_16.md`.

## Non-goals

- **Install fee.** Handled by the download-license flow, not the palette.
- **Subscriptions.** Metered per-action only.
- **Server-side Stripe changes.** All existing routes are reusable as-is.
- **Photoshop UXP variant.** Ships separately once this pattern is proven;
  the components port over with minimal changes.

## Effort estimate

Phase 1–4 + 7 (main path): ~1 day.
Phase 5 (3DS fallback): +½ day.
Phase 6 (cleanup + tests): +½ day.
Total: **~2 days** for the shipping path with 3DS handled.
