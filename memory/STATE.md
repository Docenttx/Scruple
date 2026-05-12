# Scruple Web — Current State
_Last updated: 2026-05-12T04:00:00Z_

## Phase: Pivot — substantial portion shipped, awaiting morning verification

Branch `feature/pivot` (cut from `feature/electron-parity` after the
parity overnight). 7 new commits on this branch. End-to-end pipeline
verified by `scrupel` CLI smoke test.

## What runs (live, smoke-verified)

- `scrupel` CLI authenticates against dev session route, drives the
  full pipeline server-side
- `/api/health` — all three pills green (Witness, RVN mainnet @ 4.3M
  blocks, Stripe sandbox config returns 200)
- Project create → iteration ingest → local lock → SCR-ID issued
- Modal endpoint `https://aquanomous--run.modal.run` responds to POST
  (422 to empty body, 500 for workflows needing an SD model not yet in
  the image)
- Drive OAuth routes wired and serve responses; real Drive connect
  flow untested in browser yet (Google client redirect-URI whitelist
  may need scruple.stooges.ai/api/auth/gdrive/callback added)
- Local artifact retention sweep script works (dry-run today reports 0
  stale entries, expected)

## Schema deltas (migrations 006+007+008)

- `iterations.execution_backend` TEXT (with `idx_iterations_backend`)
- `iterations.execution_attestation` TEXT (JSON)
- `iterations.storage_pointer` TEXT (JSON)
- `storage_providers (user_id PK, provider, encrypted_creds, ...)`
- `storage_sync_log (id, user_id, iteration_id, operation, provider, status, detail, size_bytes, ts)`
- `gdrive_tokens (user_id PK, access_token_enc, refresh_token_enc, expires_at, user_email, user_name, scope, connected_at)`

## What's deferred from this overnight

- SD 1.5 base model in the Modal image (so a real workflow runs end-to-end)
- OneDrive provider (S4)
- GitHub provider (S5)
- Lock-package builder pulls bytes from storage (S10/S11) — currently
  still reads from local FS, which works because purge only runs after
  storage_pointer is set

## Files in flux that morning-me should read first

- `HANDOFF_PIVOT.md` — this doc's longer cousin
- `PIVOT_WORK_ORDERS.md` — overall plan; tells you what each WO ID means
- `memory/DECISIONS.md` D-014..D-017 — the architectural decisions this overnight rests on

## Commits this session (in order)

1. Pivot tooling: scrupel CLI + dev-mode auth
2. Pivot E2+E3+E4+E5+S1+S2+S3+S6+S7+S8: Modal compute + BYOS storage
3. Pivot E6+S7+S12+S14: receipt attestation, settings storage tab, purge
4. (final) handoff doc
