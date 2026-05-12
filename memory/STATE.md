# Scruple Web — Current State
_Last updated: 2026-05-12T08:30:00Z_

## Phase: Pivot + UI clone phase 2 + non-Drive/Modal items

29 commits on `feature/pivot` since branch creation. Branch is healthy
+ ready to merge to main. Build green throughout.

## What runs (live, smoke-verified)

- Scruple-web on Oracle, served via Cloudflare Tunnel at scruple.stooges.ai
- Modal `scruple-runner` app deployed; SD 1.5 + VAE on the `scruple-models` Volume
- Canvas stub-sync mirrors Volume filenames into local ComfyUI; dropdowns populated
- Witness server `/api/lock/*` now mints real RVN testnet assets (3 minted this session)
- Stripe Customer `cus_UV9reZNDuInE4o` exists; SetupIntent endpoint returns live clientSecrets
- `/api/verify` accepts both manifest + external-bytes modes
- Tamper-audit table + manual audit endpoint shipped (cron pending Drive connection)
- Workflow validator catches missing models + structural problems with actionable hints

## Schema state (migrations applied)

001..010 all applied. Tables:
  projects, iterations, merkle_nodes (001 core)
  users, sessions, accounts, verification_tokens (002 auth)
  telemetry (003)
  projects.comfy_workflow_id (004)
  user_settings (005)
  iterations.execution_backend / execution_attestation / storage_pointer (006)
  storage_providers, storage_sync_log (007)
  gdrive_tokens (008 — per-user, AES-GCM)
  users.stripe_customer_id (009)
  tamper_audit_log (010)

## Decisions logged through D-021

See memory/DECISIONS.md. The big ones from this session:
  D-014..D-017 — Python nodes deprecated, one product, TEE-only, BYOS
  D-018 — Tiered warm-cache (free/pro/premium ↔ cold/warm/attested)
  D-019 — BYO Modal compute as escape hatch
  D-020 — 3-layer tamper-evidence policy
  D-021 — No scruple server content storage

## This session's deliverables

UI clone phase 1 (design tokens) — committed
UI clone phase 2 (components):
  - ActiveProjectBanner — TRACKING is RED per desktop
  - LockButtons — per-kind hover borders matching desktop
  - WorkspaceView — max-width 1200, proper padding, font-semibold
  - IterationGrid — CSS Grid auto-fill 280px minmax
  - ModalShell — modal-in animation, 480px max-w
  - StatusPills — flag-bg styling with glow on connected
  - SidebarList — tertiary bg, accent border, accent-tinted selected
  - ProvenanceTerminal — full terminal aesthetic, monospace

Non-Drive/Modal items:
  - lib/compute/backends.ts — ComputeBackend interface
  - /api/verify external-bytes mode with SSRF guards
  - Workflow validator + /api/workflow/validate + WorkflowUploader UI
  - Stripe SetupIntent + saved-card UX (add/detach/default)
  - Tamper-audit migration 010 + lib/audit/tamper.ts + /api/audit/iteration/:id
  - Modal `seed` entrypoint downloaded SD 1.5 base + VAE
  - Canvas stub-sync script

## What's left before merge to main

Critical path items (none of which block beta launch — all polish):
  - Cron scheduled for sync-canvas-stubs.mjs + storage-purge.mjs
  - Drive OAuth redirect URI verified in Google Cloud Console
  - Real Modal generation end-to-end smoke (haven't run a real workflow yet)
  - HANDOFF_PIVOT.md refresh (last update was at the parity overnight close)

Deferred per docs (next-session work):
  - BYO Modal compute UI in Settings (D-019 — endpoint typing already in place)
  - Lock-package builder pulling from BYOS (S10/S11)
  - PRIVACY.md doc
  - Nightly tamper-audit cron + Settings audit log tab + email notifications
  - Curated model catalog browsing in Settings
  - Drive-Lora picker (Pass-3 of model flow)
  - Video / training (per docs/video-training-tamper-evident-2026-05-12.md)

## Commit graph since main

```
0cfee4e clone-2 cont'd: sidebar list + provenance terminal
124b5c8 UI clone phase 2: spacing + radii + animations + key components
… see git log main..feature/pivot for the full 29
```

## Branch
`feature/pivot` — health: green, typecheck clean, hot-reload working.
