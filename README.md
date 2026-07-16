# Scruple for Blender

Provenance capture, checkpoints, C2PA signing, and chain-lock anchoring for
Blender renders, saves, and exports. Ships as an installable Blender addon
that talks to the Scruple witness service at [scruple.ai](https://scruple.ai).

Publisher: **Docent LLC (dba Docent Technologies)**
Contact: `scruple@docentechs.com`

## Supported Blender versions

- Blender 4.2 LTS+ (native Extensions install via `blender_manifest.toml`)
- Blender 3.x / 4.0 / 4.1 (classic `bl_info` addon install)

## Install

Drag-drop `dist/scruple-blender-<version>.zip` into Blender, or:

1. Edit → Preferences → Add-ons → Install from Disk
2. Pick the zip
3. Enable "Scruple"
4. Sign in via the addon preferences

Full quickstart: [docs/install-quickstart.md](docs/install-quickstart.md).

## What it does

- Every render (still and animation frames) is hashed and sent to Scruple
  as a witnessed leaf.
- Every `.blend` save is hashed and witnessed.
- glTF / FBX / OBJ / USD exports are wrapped and witnessed.
- Manual actions available from the N-panel in the 3D Viewport:
  - `Witness Now` — free, re-witness the current output.
  - `Checkpoint · $5` — soft-lock without sealing.
  - `C2PA · $10` — permanent local finalize + C2PA sidecar.
  - `Chain-lock · $100` — chain anchor with public receipt.
- Paid actions confirm with an in-Blender dialog before charging the card
  on file. Payment setup happens on scruple.ai — Blender never sees card
  details.

## Documentation

- [Install quickstart](docs/install-quickstart.md)
- [Architecture notes](docs/architecture.md)
- [Developer guide](docs/developer.md)

## License

Proprietary. Copyright (c) 2026 Docent LLC.
