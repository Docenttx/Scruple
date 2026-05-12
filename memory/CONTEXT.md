# Current Context
_Updated: 2026-05-12T00:30:00Z_

## Status
IN PROGRESS — Pivot overnight (PIVOT_WORK_ORDERS.md)

## What I am doing right now
Building the test-as-user CLI wrapper (`scrupel`) FIRST so I can
exercise every subsequent WO as it lands. Then sequencing through the
critical-path WOs in PIVOT_WORK_ORDERS.md.

## Plan for this overnight (rough order)
1. `scrupel` CLI wrapper + dev-mode auth endpoint
2. Modal function (E3) — deploy + smoke
3. Modal adapter (E4) — lib/compute/modal.ts
4. /api/generate Modal default (E5)
5. Migration 006 — execution_backend + attestation + storage_pointer
6. Migration 007 — storage_providers + sync log
7. Storage interface (S1) + dispatcher (S6)
8. Drive provider (S3) — port from ai-council/lib/gdrive
9. Iteration ingest writes to storage (S8)
10. Local artifact retention purge (S12)
11. Receipt page attestation panel (E6 + R1)
12. Settings storage tab (S7)
13. Smoke pass via `scrupel` CLI
14. Docs + STATE.md update

Stretch (if time allows): OneDrive (S4), GitHub (S5), R2, R3.

## Active file(s)
- scripts/scrupel.mjs (new — the CLI wrapper)
- app/api/dev/session/route.ts (new — dev auth bypass)
- modal/scruple_runner.py (new — Modal compute function)
- lib/compute/modal.ts (new — adapter)
- lib/storage/*.ts (new subsystem)
- lib/db/migrations/006_pivot_columns.sql (new)
- lib/db/migrations/007_storage.sql (new)

## Where I stopped
Branch `feature/pivot` cut from `feature/electron-parity` (commit
1251187 — PIVOT_WORK_ORDERS.md + D-014..D-017). Modal token set
on box (workspace=aquanomous). Free-tier T4 chosen as default GPU.

## Next immediate step
Build scripts/scrupel.mjs + the dev session route. Use the CLI to
smoke-test the existing endpoints before adding anything new.
