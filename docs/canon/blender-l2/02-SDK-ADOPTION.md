# WO-B2 — The addon consumes the SDK

_2026-09-07. Follows WO-B1's inventory (`01-GAP.md`, `gap.json`)._

WO-B1 measured the distance: twelve modules in `lib/`, nine of them a
second implementation of something `scruple_host_sdk` already owns, and
not one of the sixteen `/api/v2` routes called from anywhere in the
addon. This WO closes that by deletion, not by adaptation.

## What is gone

`lib/` no longer exists. Per `gap.json`'s twelve module verdicts:

| old module | verdict in gap.json | what happened |
|---|---|---|
| `lib/scruple_client.py` | delete_and_adopt | deleted → `scruple_host_sdk.Client` + `http.submit()` |
| `lib/queue_store.py` | delete_and_adopt | deleted → `scruple_host_sdk.queue.QueueStore`, now reached from the failure path |
| `lib/witness_flow.py` | delete_and_adopt | deleted → `scruple_host_sdk.witness_flow` |
| `lib/manifest.py` | delete_and_adopt | deleted → `scruple_api.manifest` (incl. `compute_tamper_surface_hash`, which had no counterpart) |
| `lib/auth.py` | delete_and_adopt | deleted → `scruple_host_sdk.auth`, parametrized by host |
| `lib/payment.py` | delete_and_adopt | deleted → `scruple_host_sdk.payment` |
| `lib/paid_action.py` | delete_and_adopt | deleted → `Client.charge()` + `Client.mark()`; the `submit_lock` callable seam is gone |
| `lib/capture.py` | split | hashing → `scruple_api.capture`; bpy introspection → `adapter/scene.py` |
| `lib/preferences.py` | split | value reads → SDK auth cache; the `AddonPreferences` class → `adapter/preferences.py` |
| `lib/state.py` | adopt + thin bag | SDK `SessionState` on the Client; `adapter/state.py` holds only what the panel shows |
| `lib/handlers.py` | keep — adapter | → `adapter/handlers.py`, unchanged except the failure path |
| `lib/logging.py` | keep — adapter | → `adapter/log.py`, renamed so it cannot shadow stdlib `logging` |

What remains in the addon is `adapter/` (bpy introspection, handlers,
preferences, the state the panel shows, and the composition that maps
Blender's vocabulary onto SDK calls), `operators/`, `panels/`, and
`vendor/`.

## Vendoring, and how a copy is traced back

A Blender addon cannot `pip install`: Blender ships its own interpreter
and users install a zip. So `scruple_host_sdk` and the `scruple_api` it
depends on live in `vendor/`, and `build/build_addon.sh` stages that
directory into the archive.

Both packages are pure standard library, so this is `cp -r` twice with
no resolver. `vendor/VENDOR.json` records the source repo, the source
commit and its subject, whether that tree was dirty in the vendored
paths at copy time, and **a sha256 per vendored file**.
`build/verify_vendor.py` checks the three ways a vendored copy rots —
edited in place, deleted, or a file that appeared and was never
vendored — plus drift against the source tree when that tree is on the
same machine. `build_addon.sh` runs it before cutting a zip.

`adapter/__init__.py` puts `vendor/` on `sys.path` ahead of
site-packages, so `import scruple_host_sdk` resolves to the copy in the
zip and not to whatever else the host interpreter has. `vendor/` is also
inside the measured tamper surface (`adapter/sdk.py::TAMPER_SURFACE_PATHS`):
a different SDK build is a different integration and must produce a
different baseline.

## Four behaviour changes, stated rather than buried

1. **No project is created.** `ensure_project()` POSTed `/api/projects`
   for every `.blend`. There is no `/api/v2/projects` (gap.json,
   endpoints 1–3); v2 carries `project_id` as an optional integer on the
   leaf. The addon no longer mints projects.
2. **Checkpoint refuses.** `/api/lock/checkpoint` has no v2 equivalent
   and v2's closed modality vocabulary (`c2pa`, `watermark`, `chain`,
   `local`) has no member for it. The operator stays registered with its
   `bl_idname` intact, explains itself in one sentence, and charges
   nothing. Mapping it onto `local` so the button still "worked" would
   be a paid button that charges for one thing and performs another.
3. **Paid actions mark a leaf, not a project.** `/api/v2/mark` takes a
   `leaf_id`, so the gate is "has anything been witnessed yet" rather
   than "is there an active project".
4. **MIME is declared.** `adapter/scene.py` resolves the type from
   `scene.render.image_settings.file_format` — Blender's own enum for
   what it encoded — and **refuses** a format with no table row rather
   than falling back. Previously every Blender artifact went up as
   `application/octet-stream`.

## A defect this WO surfaced

The path resolution inherited from `lib/capture.py` never appended
Blender's file extension. Run against real Blender 3.0.1 headless,
`filepath = "/x/out"` with PNG produces `/x/out.png` and the addon
looked for `/x/out` — found nothing, returned `None`, and the render was
never witnessed. It was invisible for as long as the addon was only ever
exercised against a mock scene.

`adapter/scene.py` now resolves against the behaviour measured from
Blender rather than assumed:

```
filepath="/x/still",  write_still  -> /x/still.png     (extension appended)
filepath="/x/w.png",  write_still  -> /x/w.png         (not doubled)
filepath="/x/h####",  write_still  -> /x/h####.png     (#### NOT substituted)
filepath="/x/anim",   animation    -> /x/anim0003.png  (frame appended)
filepath="/x/a####",  animation    -> /x/a0005.png     (#### substituted)
filepath="/x/a_##",   animation    -> /x/a_12.png      (padded to width)
use_file_extension=False           -> no extension at all
JPEG                               -> ".jpg", not ".jpeg"
```

A still render and an animation frame land at different paths from the
same `filepath`, and the handler that fires cannot say which — so the
module builds the candidates and returns the one that is on disk.

## The gate

**"The baseline suite still passes."** The 81 baseline tests were tests
of `lib/`, and `lib/` is gone; ten of the eleven files had to be
retargeted at the module that took each subject over. The behaviours
were carried across, not the imports. Per file, old → new:

| file | baseline | now | note |
|---|---:|---:|---|
| `test_auth.py` | 11 | 12 | same behaviours, host-parametrized; +1 asserting the cache file is still `blender-auth.json` |
| `test_capture.py` → `test_scene_capture.py` | 11 | 24 | split into the SDK half and `adapter/scene.py`; + the MIME table and the measured path rules |
| `test_client.py` | 8 | 12 | subject replaced: v1 `ScrupleClient` → SDK `Client` on v2 routes |
| `test_handlers.py` | 8 | 11 | unchanged plus the queue-on-failure observable |
| `test_manifest.py` | 8 | 10 | golden vectors unchanged; + tamper-surface hash |
| `test_operators.py` | 7 | 16 | absorbed `test_paid_action.py` |
| `test_paid_action.py` | 4 | 0 | subject deleted; its four behaviours are tests in `test_operators.py` |
| `test_payment.py` | 10 | 11 | same module, driven by a Client |
| `test_preferences.py` | 4 | 7 | + session-client lifecycle |
| `test_queue_store.py` | 5 | 7 | SDK store; + uuid keying and `drain()` |
| `test_witness_flow.py` → `test_flow.py` | 5 | 18 | + the three measurement-honesty states |
| `test_gap_inventory.py` (WO-B1) | 13 | 13 | unchanged |
| `test_sdk_adoption.py` (new) | — | 27 | this WO's gate |
| **total** | **94** | **176** | |

`176 passed`.

**"A new test asserts the SDK module is the one actually imported at
runtime (not the old `lib` twin)."**
`tests/test_sdk_adoption.py` — asserts `scruple_host_sdk.__file__` is
inside `vendor/`, that it is not the `/data/scruple-web/packages` source
tree, that `adapter.sdk.Client is scruple_host_sdk.Client`, that the
session client's queue and state are the SDK's classes, and that a
witness call passes through `scruple_host_sdk.http.submit` — the SDK's
only network gateway.

**"The old duplicate modules are deleted, not left orphaned."**
`lib/` is gone from the tree and from the zip (62 files, `0` matching
`scruple_blender/lib/`).

**"Control: a test that fails if both implementations are importable."**
Four controls, each demonstrated red by breaking the thing it covers and
then reverting:

| control broken | tests that went red |
|---|---|
| restored `lib/queue_store.py` with a `QueueStore` | 4: `test_the_old_lib_package_is_deleted`, `test_both_implementations_cannot_be_importable`, `test_no_module_of_the_old_lib_is_importable[lib.queue_store]`, `test_no_second_implementation_of_an_sdk_module_exists_in_the_tree` |
| appended a line to `vendor/scruple_host_sdk/http.py` | 1: `test_every_vendored_file_hashes_to_what_the_manifest_says` |
| made the MIME table default to `application/octet-stream` | 2: `test_mime_for_render_refuses_an_unmapped_format`, `test_an_unmappable_mime_refuses_instead_of_defaulting` |
| disabled `http.submit()`'s enqueue-on-failure | 5: across `test_client.py`, `test_handlers.py`, `test_flow.py` |

## Verified inside Blender, not only inside pytest

`tests/live/verify_sdk_in_blender.py` installs the **built zip** into a
scratch addons directory and runs under Blender 3.0.1's own interpreter.
Evidence: `02-in-blender-evidence.json`.

- `scruple_host_sdk` imported from
  `…/addons/scruple_blender/vendor/scruple_host_sdk/__init__.py` —
  vendored copy, source commit `4683e0a65158`
- real Cycles render, 160×120, 4 samples → `render.png`, 10 496 bytes
- `content_hash` `64a6a7f0…65c7a` == `sha256sum render.png`, checked
  from the shell independently of the addon
- MIME `image/png` from Blender's own enum; `image/x-exr` after
  switching the format
- real `.blend` saved (802 308 bytes), declared `application/x-blender`,
  hash matches
- `register()` installs 1 owned handler on `render_complete`;
  `unregister()` leaves 0; `bpy.ops.scruple.witness_now` and
  `bpy.ops.scruple.chain_lock` both resolve
- an undeclared export format raises `MimeRequiredError` in real Blender

## What WO-B2 did NOT do

- No leaf has been posted to a witness server. Every `/api/v2/witness`
  call in this WO went to an in-memory mock or to Blender's own
  interpreter with no server. **WO-B3** lands a leaf in the scratch
  witness and verifies it.
- `canonicalization_profile` is read by the mock and ignored by the
  adapter. **WO-B3.**
- The queue is filled by the SDK and drained on `unregister()` only.
  Reconciliation — a missing leaf **detected** rather than silently
  absent — is **WO-B4**.
- The panel is repointed, not rebuilt. **WO-B5.**
- H-4 client-binding is not closed. The API key is still plaintext at
  0600 in `~/.scruple/blender-auth.json`; the SDK's `auth.py` says so in
  its own header, and adopting it neither improves nor worsens that.
