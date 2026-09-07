# WO-B1 — The gap, measured

_2026-09-07. Inventory only; nothing here is a fix._
_Addon at `aa889a2`, server at `f1dcba6`. Machine-readable twin: `gap.json`._

---

## The baseline, observed

```
$ cd /data/scruple-blender && python3 -m pytest tests/ -q
........................................................................ [ 88%]
.........                                                                [100%]
81 passed in 4.79s
```

**81 passed, 0 failed, at `aa889a2`.** That is what WO-B1 expected and what
was observed, so there is no finding here. It is the number WO-B2's gate
("the baseline suite still passes") is measured against.

WO-B1 itself adds `tests/test_gap_inventory.py`, so the suite is larger
after this commit. The 81 above is the figure that carries forward.

## What is being measured

Three things are true of this addon that were not true when it shipped on
2026-07-17, and each is a table below.

1. **There is an SDK,** and the addon has its own hand-rolled twin of nearly
   every module in it.
2. **There is a v2/L2 surface** of sixteen routes, and the addon calls
   **none** of them — `grep -rn "api/v2" lib/ operators/ panels/ __init__.py`
   returns zero hits.
3. **The floor binds the client,** settled as `Client-binding. H-4 is
   mandatory.` (`web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:30`), and the
   addon *is* the client.

## The three findings that are not just "it is on v1"

Moving path strings is the small part. Three things in this inventory are
defects on their own terms, independent of which API version the addon
targets:

**1 · The offline queue has never been connected to anything.**
`lib/queue_store.py` is 87 lines, has its own test file, and is imported by
exactly one thing in the repository: that test file. Nothing in `lib/`,
`operators/`, `panels/` or `__init__.py` ever constructs a `QueueStore`. The
actual failure path is four lines in `lib/handlers.py:90-95` — log a warning,
set `state.last_error`, drop the capture. **If scruple.ai is unreachable when
a render finishes, that render is not witnessed and never will be.** The SDK
names this as the shared defect of all six forks
(`web:packages/scruple-host-sdk/scruple_host_sdk/queue.py:9`) and fixes it by
construction: enqueue-on-failure is inline in `http.submit()`, the one
function that can fail, so no caller can skip it.

**2 · Every Blender artifact is uploaded as `application/octet-stream`.**
No `capture_*` function sets `content_type`, so the `.get()` default at
`lib/witness_flow.py:57` fires on every leaf without exception. This is not
cosmetic. The scratch server, asked live on 2026-09-07, declares `c2pa` and
`watermark` **available** for `host=blender, mime=image/png` — so the addon's
own MIME defect is exactly what would gate the image modalities shut. It is
canon property 1 (`web:packages/scruple-api/scruple_api/capture.py:3`) and it
is violated on 100% of leaves.

**3 · The addon has one success state where the server has three.**
`witness_flow._post_leaf` records a receipt whenever the POST does not raise.
It cannot represent *queued* (no queue is in the path) and it cannot represent
*delivered but not witnessed* — it never reads a `witnessed` field, because
`/api/witness/cad` does not return one. The v2 route is explicit that
`201 means CAPTURED. It has never meant witnessed`
(`web:app/api/v2/witness/route.ts:563`). The panel's `Status: unlocked`
(`panels/main.py:64`) is the visible end of this.

---

## Table 1 — Every endpoint the addon calls → its v2 replacement

Fourteen rows: ten `ScrupleClient` methods, three browser hand-offs, and one
row for the absence that matters most (`/api/v2/verify`, never called).

Eight of the fourteen have **no v2 equivalent**, and they split into two very
different kinds. Four are *by design* — payment has no `/v2` surface at all,
and the SDK says so in its own header rather than stubbing it. Four are not:
projects (list / get / create) and `checkpoint` are concepts v2 simply does
not have. `POST /api/projects` is the load-bearing one — every witness in the
addon is gated on creating a v1 project first, and a v2 witness wants a
`baseline_ref` instead. That is what makes the v1→v2 move a rewrite of
`witness_flow` rather than a change of strings.

<!-- BEGIN GENERATED: endpoints -->

| # | Addon calls | cited at | v2 replacement | status | what changes |
|---|---|---|---|---|---|
| 1 | `GET /api/projects` | `lib/scruple_client.py:108` | **no equivalent** | `no_equivalent` | There is no /api/v2/projects. v2 keeps project as an optional integer on the leaf (`project_id`), not as a resource with a list/create surface. A v2 addon has no route to enumerate projects, which is the first thing WO-B5's project switcher would need. |
| 2 | `GET /api/projects/{id}` | `lib/scruple_client.py:116` | **no equivalent** | `no_equivalent` | Same as above. Nothing under /api/v2 reads a project. |
| 3 | `POST /api/projects` | `lib/scruple_client.py:128` | **no equivalent** | `no_equivalent` | Load-bearing and unreplaceable as written. Every witness in the addon is gated on having created a v1 project first; a v2 witness needs a baseline_ref, not a project id. This is the single call that makes the v1→v2 move a rewrite of witness_flow rather than a change of path string. |
| 4 | `POST /api/witness/cad` | `lib/scruple_client.py:158` | `POST /api/v2/witness` | `replaced_with_material_differences` | Four differences, each of them work. (1) /witness/cad is bytes-in — the addon base64s the whole file and the server hashes it; /v2/witness is zero-content and takes `content_hash` only. (2) /v2/witness requires `baseline_ref`, a 64-hex tamper-surface hash the addon has never computed. (3) `kind` is a closed enum on v2 — the addon's trigger labels ('render_complete', 'save_post') are not members of it. (4) v2 returns witnessed / leaf_scheme / attestation / canonicalization_profile; the cad route returns none of those, so the addon has never had anything to record honestly. |
| 5 | `GET /api/stripe/config` | `lib/scruple_client.py:162` | **no equivalent** | `no_equivalent_by_design` | /v2 exposes no payment surface at all. The SDK keeps calling this same v1 route and says so in its own docstring — moving to v2 does NOT move payment. Note also that this route authenticates with a browser session, so a bearer-key plugin gets 401. |
| 6 | `POST /api/stripe/payment-intent` | `lib/scruple_client.py:171` | **no equivalent** | `no_equivalent_by_design` | The SDK's payment.py states the gap in full: /v2/mark accepts a payment_intent_id but /v2 exposes no route to create one, and the v1 routes that do call auth() rather than accepting a bearer key. A headless plugin session cannot pay today. The addon has the same defect and does not say so anywhere. |
| 7 | `POST /api/stripe/confirm` | `lib/scruple_client.py:185` | **no equivalent** | `no_equivalent_by_design` | Same as payment-intent. The SDK has no confirm() at all, so an SDK-consuming addon loses the resume-payment operator unless the addon keeps a v1 call of its own or the SDK grows one. |
| 8 | `POST /api/lock/checkpoint` | `lib/scruple_client.py:194` | **no equivalent** | `no_equivalent` | 'checkpoint' is not one of v2's four modalities (c2pa, watermark, chain, local). /v2/mark has no notion of a paid soft-lock that preserves progress without sealing. Either the concept dies in the v2 addon or the server grows it; this is a founder-shaped question, not an engineering one. |
| 9 | `POST /api/lock/local` | `lib/scruple_client.py:203` | `POST /api/v2/mark with modalities: []` | `replaced` | Direct replacement: a local lock is always performed server-side regardless of what is requested, so modalities:[] is the v2 spelling of lock_local. What changes is honesty — /v2/mark returns modalities_applied and `outstanding`, so the addon would stop reporting a flat success. Separately: the server declares c2pa AVAILABLE for host=blender, mime=image/png (observed live on the scratch app, 2026-09-07), so this button could be a real C2PA mark under v2 and today is not. |
| 10 | `POST /api/lock/chain` | `lib/scruple_client.py:217` | `POST /api/v2/mark with modalities: ["chain"], chain_tier` | `replaced` | Direct replacement, with one addition v2 enforces and the addon does not: mark() checks every requested modality against GET /capabilities BEFORE sending, and an unavailable modality raises rather than downgrading. The addon sends the chain-lock request unconditionally. |
| 11 | `browser: GET {base}/projects/{id}  (the 'Open receipt' button)` | `operators/open_receipt.py:33` | `GET /api/v2/receipt/{leaf_id}` | `replaced_and_upgraded` | Today 'Open receipt' opens a web page for the PROJECT and shows the user nothing in Blender. /api/v2/receipt/{leaf_id} is public, unauthenticated, per-LEAF, and returns witnessed / outstanding / attestation status — a receipt the addon could render in the N-panel. It is also, per its own header comment, 'deliberately unflattering', which is the point. |
| 12 | `browser: GET {base}/settings/payment` | `operators/payment_setup.py:24` | **no equivalent** | `no_equivalent_by_design` | Card entry stays on scruple.ai in every host — the SDK agrees. Unchanged by the v2 move. |
| 13 | `browser: GET {base}/settings/keys/desktop  (sign-in handshake)` | `lib/auth.py:189` | **no equivalent** | `unchanged` | The SDK ports this handshake almost verbatim, parametrized by host. Its docstring notes the alternative — POST /v2/session/handoff — does not exist on the server, so nothing here changes under v2. |
| 14 | `GET /api/v2/verify/{content_hash}  — NOT CALLED` | `lib/scruple_client.py:36` | `GET /api/v2/verify/{content_hash}` | `absent` | The addon has no verify path of any kind — grep for 'api/v2' across lib/, operators/, panels/ and __init__.py returns 0 hits. It cannot tell a user whether the leaf it just produced is independently verifiable, which under H-5 is the one thing a receipt must not be vague about. |

<!-- END GENERATED: endpoints -->

## Table 2 — Every `lib/` module → the SDK module that supersedes it

Twelve modules, 1,706 lines. Seven should be deleted outright and the SDK
adopted. Two split — the hashing half of `capture.py` and the value-holding
half of `preferences.py` go to the SDK, while the `bpy` introspection and the
`AddonPreferences` subclass are genuinely Blender-specific and must survive
WO-B2. Two stay whole (`handlers.py`, `logging.py`). One (`state.py`) is
adopted with a thin Blender-side bag alongside it, because the SDK's
`SessionState` holds v2 nouns (`baseline_ref`, `capabilities_cache`) and the
addon's holds v1 ones (`active_project_id`) and neither holds the other's.

Eight SDK modules have **no addon counterpart at all**: `capabilities`,
`ratchet`, `envelope`, `model_write`, `server_library`, `provider`,
`surface`, `errors`. `ratchet` and `capabilities` are the two that matter —
they are H-4 and canon property 2 respectively.

`lib/logging.py` is the only addon module with no SDK twin in either
direction; the SDK's own inventory of what it owns
(`web:packages/scruple-host-sdk/scruple_host_sdk/__init__.py:46`) does not
list logging.

<!-- BEGIN GENERATED: modules -->

| # | `scruple_blender/lib/` | LOC | superseded by | differs? | verdict | why |
|---|---|---|---|---|---|---|
| 1 | `lib/scruple_client.py` `lib/scruple_client.py:36` | 239 | scruple_host_sdk/client.py + http.py `web:packages/scruple-host-sdk/scruple_host_sdk/client.py:41` | **yes** | `delete_and_adopt` | The addon's client is its own transport: _request() builds and sends every call itself, and each caller decides what to do when it raises. The SDK splits this — client.py holds no socket, http.submit() is the single gateway, and enqueue-on-failure is inline in that one function's control flow so no caller can skip it. |
| 2 | `lib/queue_store.py` `lib/queue_store.py:20` | 87 | scruple_host_sdk/queue.py `web:packages/scruple-host-sdk/scruple_host_sdk/queue.py:25` | **yes** | `delete_and_adopt` | THE HEADLINE FINDING OF THIS INVENTORY. lib/queue_store.py is imported by exactly one file in the repository and that file is its own test. Nothing in lib/, operators/, panels/ or __init__.py ever constructs a QueueStore or calls enqueue(). The failure path in handlers._dispatch logs a warning, sets state.last_error, and drops the capture on the floor. The SDK's own header names this defect and says it was true in all six forks. Two mechanical differences follow: the SDK keys entries by a uuid `id` (the addon keys by float `queued_at`, which collides), and the SDK has drain(), which the addon has no equivalent of. |
| 3 | `lib/capture.py` `lib/capture.py:157` | 264 | scruple_api/capture.py (re-exported as scruple_host_sdk.capture) `web:packages/scruple-api/scruple_api/capture.py:76` | **yes** | `split — hashing to the SDK, bpy introspection stays in the adapter` | Two differences and only one of them is a deletion. (1) MIME: the addon never declares one — capture_* returns no content_type key, so witness_flow's .get() default fires on every single leaf and every Blender artifact is uploaded as application/octet-stream. scruple_api refuses to proceed without an explicit mime and has no mimetypes import anywhere. (2) Host introspection: the addon's capture reads scene.render, bpy.data.materials and bpy.app.version inline; scruple_api says flatly that this belongs in the adapter and takes `workflow` as data. So the hashing half of this module is superseded; the bpy-reading half must SURVIVE as adapter code, and WO-B2 must not delete it. |
| 4 | `lib/witness_flow.py` `lib/witness_flow.py:42` | 116 | scruple_host_sdk/witness_flow.py `web:packages/scruple-host-sdk/scruple_host_sdk/witness_flow.py:31` | **yes** | `delete_and_adopt` | Same name, opposite discipline. The addon infers success from the absence of an exception and records whatever leaf hash it can find under either spelling; it has no concept of `witnessed`, no baseline gate, and no `outstanding`. The SDK reads every field out by name, refuses client-side with NoBaselineError before making any network call, and treats witnessed=False on a delivered request as different from queued=True on an undelivered one — the three measurement-honesty states WO-B3 is about. |
| 5 | `lib/manifest.py` `lib/manifest.py:23` | 123 | scruple_api/manifest.py (re-exported as scruple_host_sdk.manifest) `web:packages/scruple-api/scruple_api/manifest.py:23` | **yes** | `delete_and_adopt` | canonicalize() and sha256_hex() are textually identical — the SDK's own comment says it is a near-verbatim port of this file. build_machine_manifest is NOT: the addon's is hardcoded to blender_version/addon/addon_version, the SDK's is host-agnostic and expects scene-specific fields in the adapter's workflow dict. And the SDK has compute_tamper_surface_hash(), which has no counterpart here at all — that function is the baseline_ref /api/v2/witness requires, so its absence is why the addon cannot reach v2 at all. |
| 6 | `lib/auth.py` `lib/auth.py:137` | 231 | scruple_host_sdk/auth.py `web:packages/scruple-host-sdk/scruple_host_sdk/auth.py:92` | **yes** | `delete_and_adopt` | The SDK's auth.py is a direct port of THIS file — its docstring says so and calls this 'the healthiest of the six forks'. The only functional difference is parametrization: the addon hardcodes ~/.scruple/blender-auth.json, the SDK takes `host` and a cache_dir override (which is what makes it testable without touching a real home directory). Both write 0600, both keep the key in plaintext. Neither meets H-4. |
| 7 | `lib/state.py` `lib/state.py:11` | 40 | scruple_host_sdk/state.py `web:packages/scruple-host-sdk/scruple_host_sdk/state.py:19` | **yes** | `adopt SDK, keep a thin Blender-side project bag` | Same shape (recent_receipts deque, MAX 5, last_error) with different contents. The addon's fields are v1 nouns — active_project_id / active_project_name / active_project_status. The SDK's are v2 nouns — baseline_ref, tamper_surface_hash, capabilities_cache. Neither holds the other's, so WO-B2 needs both: the SDK's SessionState plus a small Blender-side bag for the project the panel shows. |
| 8 | `lib/payment.py` `lib/payment.py:104` | 151 | scruple_host_sdk/payment.py `web:packages/scruple-host-sdk/scruple_host_sdk/payment.py:113` | no | `delete_and_adopt` | Functionally the same module — same four action constants, same DEFAULT_PRICE_CENTS, same four-step confirm-then-charge, same v1 stripe routes. The one difference is honesty of documentation: the SDK's header states in full that a bearer-key plugin gets 401 from /api/stripe/payment-intent and that /v2/mark ignores payment_intent_id entirely, so priced modalities cannot work headless today. The addon's header describes the flow as if it worked. |
| 9 | `lib/preferences.py` `lib/preferences.py:71` | 149 | scruple_host_sdk/preferences.py `web:packages/scruple-host-sdk/scruple_host_sdk/preferences.py:20` | **yes** | `split — value holding to the SDK, the AddonPreferences class stays` | Only partly superseded, and the SDK says so: 'Rendering a settings panel is the adapter's job'. The SDK's Preferences is a 26-line dataclass holding base_url/timeout/verbose. The addon's file is 149 lines of which the bpy.types.AddonPreferences subclass and its draw() are genuinely Blender-specific and must stay. What can go is get_api_key/get_base_url/sync_from_cache, which duplicate the SDK's auth cache read. |
| 10 | `lib/paid_action.py` `lib/paid_action.py:30` | 70 | scruple_host_sdk/client.py charge() + witness_flow.mark() `web:packages/scruple-host-sdk/scruple_host_sdk/client.py:250` | **yes** | `delete_and_adopt` | The addon's spine is charge-then-POST-a-lock-endpoint, parametrized by a submit_lock callable per operator. The SDK's is charge-then-mark, with one mark() that takes modalities. The callable seam disappears — three operators collapse into three different modality lists. |
| 11 | `lib/handlers.py` `lib/handlers.py:35` | 192 | none — bpy.app.handlers registration is genuinely Blender-specific `web:packages/scruple-host-sdk/scruple_host_sdk/preferences.py:4` | **yes** | `keep — adapter code` | This module KEEPS. It is the adapter: bpy.app.handlers install/uninstall, idempotent re-registration, and a worker thread so the UI does not stall. What must change is the four lines inside _dispatch's except: today they are the whole failure path. Under the SDK, http.submit() enqueues before the exception ever reaches here, and detach() drains — so this module stops being the place where captures are lost. |
| 12 | `lib/logging.py` `lib/logging.py:14` | 44 | none — the SDK has no logging module `web:packages/scruple-host-sdk/scruple_host_sdk/__init__.py:46` | **yes** | `keep — adapter code` | The one lib/ module with no SDK twin. The SDK's inventory of what it owns does not include logging. This module stays as adapter code; it is 44 lines and prints to stderr. |

<!-- END GENERATED: modules -->

## Table 3 — Every L2 floor item → what the addon does about it today

Nineteen rows drawn from `L2_FLOOR.md` (H-1 … H-5) and
`L2_AS_THE_VENDOR_FLOOR.md` (the six banking mechanisms, the two "what is
actually missing" items, and the eight-step end-to-end shape), plus four
floor properties the v2 route and the SDK enforce directly.

**Nothing is met. Two are partial, one is violated, one is not applicable,
and fifteen are absent.**

Two of the absences are worth separating out, because they are *client-side
only*: H-1 and two-tier assurance are **implemented on the server**. The
leaf signature fields are on the wire, `/api/v2/verify` reports
`independently_verifiable` per leaf, and the witness route computes
`'verified' | 'passthrough' | null`. The addon is the reason none of it
reaches a user. That is a smaller job than it looks and it is WO-B3/B5.

H-4 is the opposite. The addon writes a plaintext API key to
`~/.scruple/blender-auth.json` at 0600 and reads it back — precisely the
"plaintext API keys" the item names. There is no ratchet, no per-event
derived key, no component id, no MAC. `grep` for `ratchet`, `component_id`
and `attestation` across the addon source returns **0 hits for all three**.
The SDK ships a complete forward-secure ratchet
(`web:packages/scruple-host-sdk/scruple_host_sdk/ratchet.py:231`) that the
addon does not import. **H-4 is not scheduled in this WO series** and should
be flagged to the founder as the item this whole structure rests on.

One caution that applies to every row below and to every WO after this one:
the CVM surrogate on `:8799` reports `protectionMode: SOFTWARE` truthfully.
Every leaf signed against it this week is `passthrough`. Recording it as
anything else would be the exact dishonesty the floor exists to prevent.

<!-- BEGIN GENERATED: floor_items -->

| # | Floor item | cited at | status | what the addon does about it today | closes in |
|---|---|---|---|---|---|
| 1 | H-1 — the witness stops signing; leaves are ECDSA-signed by the HSM-resident key, and are third-party verifiable | `web:docs/canon/L2_FLOOR.md:91` | **`absent_client_side`** | Nothing. The addon posts to /api/witness/cad, which returns no signature fields, and the addon reads none — grep for leaf_signature, leaf_signer_key_id or leaf_signature_alg across the addon source returns 0 hits. Server-side H-1 IS implemented (the fields exist on the wire and /api/v2/verify reports independently_verifiable per leaf), so this is purely a client-side gap: the evidence is being produced and the addon is not collecting it. | WO-B3 |
| 2 | H-2 — HMAC demoted to transport integrity; nothing in a receipt derives trust from it | `web:docs/canon/L2_FLOOR.md:97` | **`not_applicable`** | Not applicable to the addon and not violated by it: the addon holds no HMAC secret of any kind. It authenticates with a bearer API key only. | — |
| 3 | H-3 — the code that captures is in git and under measurement; un-measured code cannot compute a baseline | `web:docs/canon/L2_FLOOR.md:102` | **`partial`** | Half met by accident. The addon IS in git and IS the thing that captures — but nothing computes a measurement over it. There is no compute_tamper_surface_hash call, no baseline POST, and the addon's build script records no source commit into the zip, so a shipped copy cannot be traced back to what produced it. | WO-B2 (commit stamping) + WO-B3 (baseline) |
| 4 | H-4 — client-side key custody rises to the same bar. MANDATORY, per the founder answer in L2_AS_THE_VENDOR_FLOOR.md | `web:docs/canon/L2_FLOOR.md:106` | **`absent`** | The addon writes a plaintext API key to ~/.scruple/blender-auth.json at 0600 and reads it back. That is precisely the 'plaintext API keys' H-4 names. There is no ratchet, no per-event derived key, no component id and no MAC — grep for ratchet, component_id and mac across the addon source returns 0 hits for all three. The SDK ships a full forward-secure ratchet the addon does not touch. | not scheduled in this WO series — flagged for the founder |
| 5 | H-5 — verifiers chain to a vendor root or say they did not; verified vs passthrough, honest per leaf | `web:docs/canon/L2_FLOOR.md:111` | **`absent`** | Absent, and worse than absent — the addon actively asserts. panels/main.py shows 'Status: unlocked' and a receipt line with a truncated hash, with no assurance field at all; witness_flow records a receipt on any non-throwing response. The server computes 'verified' \| 'passthrough' \| null per leaf and the addon has never read it. Note the sandbox constraint this WO series runs under: the CVM surrogate reports protectionMode SOFTWARE truthfully, so every leaf signed here is passthrough, and recording it otherwise would be the exact dishonesty H-5 exists to prevent. | WO-B3 (record it) + WO-B5 (show it) |
| 6 | Vendor floor 1 (PCI PTS) — the trust boundary is a component, not a site | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:15` | **`absent`** | Absent. /api/v2/witness accepts a component envelope (component_id, build_measurement, counter, attestation) with a MAC; the addon sends no component block, so every leaf it could produce would be component_verified: false. | — |
| 7 | Vendor floor 2 (P2PE scope reduction) — the untrusted middle becomes irrelevant | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:16` | **`absent`** | Absent, and the doc itself records the rule as 'not currently stated' server-side either. For Blender the question is sharp and unanswered: Blender's own process is the untrusted middle, and an addon running inside it cannot put itself out of scope. Nothing in the addon addresses this. | — |
| 8 | Vendor floor 3 (DUKPT) — per-event derived keys; the terminal never holds the base key | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:17` | **`absent`** | Absent. The addon holds one long-lived bearer key and sends it on every request. The SDK's ratchet.py implements the full HKDF chain against a shared vector file; the addon does not import it. | — |
| 9 | Vendor floor 4 (store-and-forward) — local nodes run disconnected and the work survives | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:18` | **`absent`** | Written and unwired — the doc's exact diagnosis, confirmed here by import graph. lib/queue_store.py is 87 lines with 100% test coverage of its own behaviour and zero callers outside tests. If scruple.ai is unreachable when a render finishes, that render is not witnessed and never will be. | WO-B4 |
| 10 | Vendor floor 5 (settlement reconciliation) — divergence and silence are DETECTED, not merely absent | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:83` | **`absent`** | Absent on both sides of the wire for this host. The addon has no sequence counter, no heartbeat and no settlement step; a Blender session that stops witnessing produces the same observable as a quiet afternoon. The server side DOES now have per-component gap accounting, but it keys off the component envelope the addon never sends, so it can never fire for a Blender leaf. | WO-B4 |
| 11 | Vendor floor 6 (EMV L3) — the configuration is certified, re-run on material change | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:19` | **`absent`** | Absent. packages/scruple-conformance exists and grades an integration; the addon has never been run through it. WO-B6 is the first time it will be. | WO-B6 |
| 12 | Vendor floor 7 (two-tier assurance) — attested → verified, otherwise passthrough, declared per leaf | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:20` | **`absent_client_side`** | Implemented server-side, absent client-side. This is the one floor item the estate already has, and the addon is the reason it does not reach the user: nothing in panels/main.py has a place to put it. | WO-B5 |
| 13 | Vendor floor — the capture component ships from us with a published measurement, and every leaf carries which build produced it | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:61` | **`absent`** | Absent. The addon reports addon_version as a hardcoded string constant with nothing binding it to a build. /api/v2/builds exists to answer 'did we publish this measurement'; a Blender leaf carries no measurement to ask about. | — |
| 14 | Vendor floor — hash local, sign central; the vendor never holds signing authority over evidence | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:115` | **`partial`** | Half met, by accident rather than design. The addon hashes locally (sha256_file over the render output) and holds no signing key — so it satisfies the shape. But it then ALSO ships the whole file body base64-inline to the server, which is the opposite of the zero-content property /api/v2/witness is built on. Moving to v2 makes this item true on purpose and stops sending the user's bytes. | WO-B3 |
| 15 | Baseline / deployment seal — a leaf declares which sealed deployment produced it | `web:docs/canon/L2_AS_THE_VENDOR_FLOOR.md:127` | **`absent`** | Absent. /api/v2/witness takes an optional deployment_id and records `undeclared` when none is sent. The addon has no notion of a deployment, so every Blender leaf would be undeclared — which is at least honest, and is the correct starting state. | — |
| 16 | Canonicalization profile recorded on the leaf | `web:app/api/v2/witness/route.ts:556` | **`absent`** | Absent, and the addon has its own second implementation of canonical JSON to go with it — lib/manifest.py:canonicalize() duplicates scruple_api's byte for byte. Two canonicalizers and no recorded profile is the shape of a divergence nobody will notice until a hash disagrees. | WO-B3 |
| 17 | Measurement honesty — witnessed, queued and delivered-but-not-witnessed are three different states | `web:app/api/v2/witness/route.ts:563` | **`absent`** | Absent. The addon has one state: the POST did not raise, so a receipt is recorded. It cannot represent queued (there is no queue in the path) and it cannot represent delivered-but-not-witnessed (it never reads a `witnessed` field, because /api/witness/cad does not return one). | WO-B3 |
| 18 | MIME is declared, never guessed (canon property 1) | `web:packages/scruple-api/scruple_api/capture.py:3` | **`violated`** | Violated on every leaf. No capture_* function sets content_type, so witness_flow's default fires unconditionally and every render, save and export is uploaded as application/octet-stream. The server declares c2pa and watermark AVAILABLE for host=blender + mime=image/png (observed live, 2026-09-07) — so the addon's own MIME defect is what would gate the image modalities shut. | WO-B2/B3 |
| 19 | Modality applicability is checked before requesting, and fails closed (canon property 2) | `web:packages/scruple-host-sdk/scruple_host_sdk/capabilities.py:85` | **`absent`** | Absent. The addon never calls /api/v2/capabilities. Its three paid buttons post their lock request unconditionally, and its 'C2PA sign' button does not request the c2pa modality at all — it calls lock_local. Every price shown in the panel comes from a hardcoded dict, not from the server. | WO-B3/B5 |

<!-- END GENERATED: floor_items -->

---

## How to check this document

The line numbers above are not decoration. Every one of the 136 citations in
`gap.json` carries the text it expects to find, and the verifier opens the
file and checks:

```
$ python3 tools/verify_gap.py
OK  docs/canon/blender-l2/gap.json
    endpoints     14 rows
    modules       12 rows
    floor_items   19 rows
    TOTAL         45 rows, 136 citations, all resolved to a line that contains their quote
```

Slide any citation by one line and it fails, which is what makes the green
worth something:

```
$ python3 -m pytest tests/test_gap_inventory.py -q      # after nudging one line
E  'endpoints[3] POST /api/witness/cad.cite: quote not on lib/scruple_client.py:157
E     wanted: '"/api/witness/cad"'
E     line is: 'body["prompt"] = prompt''
1 failed, 10 passed
```

`tests/test_gap_inventory.py` carries that as six controls — a wrong line, a
wrong quote, a missing file, a row citing nothing, a missing table, a missing
baseline count — each asserted to make the verifier fail. The tables in this
file are generated from `gap.json` by `tools/render_gap_md.py`, and a test
fails if what is on disk has drifted from what the JSON says, so the prose
and the machine-readable inventory cannot disagree.

Citations marked `web:` are relative to `/data/scruple-web`; the rest are
relative to this repository. Override with `SCRUPLE_WEB_ROOT`.
