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
   `operators/witness.py` (free) or `operators/checkpoint.py` (paid).
2. Register the class in the module's `register()` function.
3. Add the import + `register()` / `unregister()` calls to
   `_load_modules()` in `__init__.py`.
4. Add an integration test in `tests/test_operators.py`.

## Adding a scruple-web endpoint

1. Extend `lib/scruple_client.py` with a thin method matching the
   signature pattern of the existing methods.
2. Add a request-shape test in `tests/test_client.py`.
3. Add or extend a payment/lock/flow test as needed.

Never bake business logic into the client. The client is dumb about
what the server does; higher-level modules compose the calls.

## Coding rules

- No em dashes anywhere.
- No emojis unless required by an API.
- Comments describe the *why*, not the *what*.
- Import bpy defensively so tests without bpy still import each module.
- Register/unregister every bpy class both ways. Idempotent handlers.

## Publisher

Docent LLC (dba Docent Technologies).
Contact: `scruple@docentechs.com`.
