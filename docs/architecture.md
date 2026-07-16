# Scruple for Blender — architecture

## Shape

Scruple for Blender is a native Blender addon. Every user-facing surface
lives inside Blender's own UI toolkit — no webview, no bundled browser,
no Electron. Payment card entry happens on scruple.ai in the system
browser; the addon holds only an API key on disk.

The addon consumes scruple-web's public HTTP surface unchanged. It
never talks directly to the witness server — every call goes through
scruple.ai routes, which authenticate the user by bearer token and
forward to the witness backend as needed.

## Modules

```
scruple_blender/
  __init__.py               register / unregister; bl_info fallback
  blender_manifest.toml     Extensions manifest (4.2+)
  lib/
    auth.py                 URL scheme + local callback + disk cache
    preferences.py          AddonPreferences UI
    scruple_client.py       urllib HTTP client (bearer auth)
    manifest.py             canonical leaf preimage builders
    capture.py              hash + inventory + workflow snapshot
    handlers.py             bpy.app.handlers wiring + background worker
    witness_flow.py         capture -> POST -> receipt state
    payment.py              off-session charge orchestration
    paid_action.py          spine of every paid operator
    queue_store.py          offline retry queue (JSONL, backoff)
    state.py                cross-module in-memory state
    logging.py              verbosity toggle
  operators/
    auth.py                 sign in / sign out
    witness.py              free re-witness
    checkpoint.py           paid soft-lock
    c2pa.py                 paid C2PA sign
    chain_lock.py           paid chain anchor
    open_receipt.py         open scruple.ai receipt page
    payment_setup.py        open scruple.ai payment settings
  panels/
    main.py                 3D Viewport N-panel
```

## Event flow

1. User triggers a render / save / export.
2. Blender fires the matching `bpy.app.handlers` hook on the main thread.
3. The addon's handler enqueues a job on the background worker thread
   so the UI stays responsive.
4. The worker calls `capture.py` to hash the file and build the leaf
   payload, then POSTs to `/api/witness/cad`.
5. On success, the receipt is appended to the in-memory state and the
   N-panel picks it up on the next draw.

## Paid actions

1. Fetch `/api/stripe/config` for the payment method summary and the
   live price for this action.
2. Show a Blender-native `invoke_props_dialog` confirming the charge.
3. On OK, POST `/api/stripe/payment-intent` to charge the card off-
   session. The server returns a `pi_...` PaymentIntent ID.
4. POST the appropriate lock endpoint (`/api/lock/checkpoint`,
   `/api/lock/local`, `/api/lock/chain`) with the `pi_...`. The server
   verifies the payment then executes the lock.
5. Record the receipt.

Any `requires_action` (3DS) status surfaces as a message pointing the
user at `scruple.ai/pay/<pi>` to finish verification in the browser. A
URL-scheme callback resumes the pending operator on completion.

## Why not a bundled webview?

Blender does not ship a Chromium or a Qt WebEngine. Stuffing one in
would triple the addon size and open a permissions minefield with the
Extensions catalog. Instead, the addon runs entirely inside Blender's
Python and shells out to the system browser for anything that requires
HTML (card entry, receipt viewing, 3DS challenges). The result is a
smaller install, faster startup, and a cleaner review by the Blender
Extensions team.

## Testing

The bpy dependency is import-guarded in every module. When bpy is not
present (pytest), `tests/mocks/bpy_mock.py` supplies a minimal
compatible surface. `tests/mocks/http_mock.py` gives the `ScrupleClient`
an in-memory `urlopen` compatible object so every HTTP call is
recordable and hermetic.

Run `pytest` at the repo root. All 81 unit tests plus the operator
integration tests should pass in under 5 seconds.
