# Scruple for Blender — developer guide

## Repo layout

See [architecture.md](architecture.md) for the module map.

## Running tests

```
pytest -q
```

Requires Python 3.10+ and `pytest` on `PATH`. No `bpy` or `blender`
required — the mock harness in `tests/mocks/bpy_mock.py` stands in.

## Building the zip

```
build/build_addon.sh
```

Produces `dist/scruple-blender-<version>.zip`. The archive is drop-in
for the Extensions install flow (Blender 4.2+) and for legacy classic-
addon install (Blender 3.6 through 4.1).

`build/build_addon.sh --publish` runs a dry-run of the Extensions
submission. The real submission needs a Blender ID and the extensions
CLI, both outside this script.

## Live-reload during development

The fastest inner loop is:

1. Symlink the working tree into Blender's addon directory:
   ```
   ln -sf /data/scruple-blender ~/.config/blender/4.2/scripts/addons_core/scruple_blender
   ```
2. Enable the addon once in Blender preferences.
3. On any edit, `F3 -> Reload Scripts` (or the "Reload Scripts"
   operator) picks up the changes.

## Adding an operator

1. Create `operators/<name>.py`. Follow the pattern in
   `operators/witness.py` (free) or `operators/c2pa.py` (paid).
2. Register the class in the module's `register()` function.
3. Add the import + `register()` / `unregister()` calls to
   `_load_modules()` in `__init__.py`.
4. Add an integration test in `tests/test_operators.py`.

## Adding a scruple-web endpoint

Not here. `CANON_SKELETON.md` §5 lists what an adapter may not do —
construct HTTP requests, handle payment, decide MIME, decide
applicability, write its own retry — and every one of them is a method
on `scruple_host_sdk.Client` instead. There is deliberately no
`client.request(...)` escape hatch.

So a new endpoint is a change to `packages/scruple-host-sdk` in
`/data/scruple-web`, followed by:

1. `build/vendor_sdk.sh` to refresh `vendor/` and re-record the source
   commit in `VENDOR.json`.
2. A test in `tests/test_client.py` for the shape the addon depends on.
3. If the addon needs to reach it from Blender, a function in
   `adapter/flow.py` that maps Blender's vocabulary onto it — and
   nothing else.

`tests/test_sdk_adoption.py` fails if any of that is bypassed: it AST-scans
every source file for a direct network call, and greps for the class and
function definitions the SDK owns coming back under a new name.

## Refreshing the vendored SDK

```
build/vendor_sdk.sh              # refresh from $SCRUPLE_WEB_ROOT
build/vendor_sdk.sh --verify     # check vendor/ against VENDOR.json
build/build_addon.sh             # refreshes-or-verifies, then zips
```

Never edit anything under `vendor/` in place. `verify_vendor.py`
compares every file against the sha256 recorded when it was vendored and
fails the build if one has moved.

## Coding rules

- No em dashes anywhere.
- No emojis unless required by an API.
- Comments describe the *why*, not the *what*.
- Import bpy defensively so tests without bpy still import each module.
- Register/unregister every bpy class both ways. Idempotent handlers.

## Publisher

Docent LLC (dba Docent Technologies).
Contact: `scruple@docentechs.com`.
