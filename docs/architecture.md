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

Since WO-B2 (2026-09-07) it does not implement that surface itself. The
client, the retry queue, canonical JSON, the tamper-surface hash, auth
storage, payment and the witness/mark calls are `scruple_host_sdk`,
vendored under `vendor/`. What is left in this repository is the part
that touches bpy. See `docs/canon/blender-l2/02-SDK-ADOPTION.md`.

## Modules

```
scruple_blender/
  __init__.py               register / unregister; bl_info fallback
  blender_manifest.toml     Extensions manifest (4.2+)
  adapter/                  the Blender half, and only that
    __init__.py             puts vendor/ on sys.path ahead of everything
    sdk.py                  one Client per session; reads VENDOR.json
    scene.py                paths, render settings, inventory, MIME
    flow.py                 Blender's vocabulary -> SDK witness/mark
    handlers.py             bpy.app.handlers wiring + background worker
    preferences.py          AddonPreferences UI
    state.py                what the panel shows (the SDK holds the rest)
    log.py                  verbosity toggle
  operators/
    auth.py                 sign in / sign out
    witness.py              free re-witness
    witness_export.py       witness an exported file
    checkpoint.py           refuses: no /api/v2 equivalent
    c2pa.py                 paid local lock (mark, modalities: [])
    chain_lock.py           paid chain anchor (mark, modalities: [chain])
    open_receipt.py         open scruple.ai receipt page
    payment_setup.py        open scruple.ai payment settings
    resume_payment.py       finish a mark after a 3DS challenge
  panels/
    main.py                 3D Viewport N-panel
  vendor/                   vendored at build time, never edited here
    VENDOR.json             source commit + sha256 per file
    scruple_host_sdk/       the SDK: http, queue, auth, payment, client
    scruple_api/            interfaces, capture, manifest, modality
```

`vendor/` is refreshed by `build/vendor_sdk.sh` and checked by
`build/verify_vendor.py`, which `build/build_addon.sh` runs before
cutting a zip. Nothing in this repository edits it by hand.

## Event flow

1. User triggers a render / save / export.
2. Blender fires the matching `bpy.app.handlers` hook on the main thread.
3. The addon's handler enqueues a job on the background worker thread
   so the UI stays responsive.
4. The worker calls `adapter/flow.py`, which resolves the path Blender
   wrote, declares the MIME from Blender's own format enum, builds the
   workflow snapshot, and hands all three to `Client.witness_file()`.
5. The SDK establishes or verifies the session baseline first (a leaf
   without one is refused client-side, D-3), then POSTs
   `/api/v2/witness`.
6. The outcome carries `witnessed` and `queued` as separate fields. A
   witnessed leaf is appended to the SDK's `SessionState.recent_receipts`
   and the N-panel picks it up on the next draw; an undelivered one is
   already spooled to `vendor`-independent JSONL on disk by
   `http.submit()` before the caller hears about it.

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
