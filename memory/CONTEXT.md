# Current Context
_Updated: 2026-05-11T22:30:00Z_

## Status
IN PROGRESS — Electron parity overnight (WO-31..47 of PARITY_PLAN.md)

## What I am doing right now
Starting WO-31 — active-project sidebar banner + status pills row.

## Active file(s)
- components/Sidebar.tsx (read for shape)
- components/ActiveProjectBanner.tsx (new — the TRACKING banner)
- components/StatusPills.tsx (new — Witness/RVN/Stripe heartbeat pills)
- lib/projects/actions.ts (may add getActiveProject if missing)

## Where I stopped
Just committed three pre-parity progress commits to feature/electron-parity:
  c2f7700 — gear icon
  (next) — ComfyDeploy bridge + workflow field
  (next) — Canvas tab Scruple Shell + parity plan

## Next immediate step
Read components/Sidebar.tsx + components/AppShell.tsx to see where the
active-project banner belongs in the existing layout. Then drop in the
banner component + the status pills row. Match the desktop's:

  TRACKING
  [thumbnails]
  Project name
  Status: <state>
  Iterations: N
  SCR-ID: SCR_XXXXXX
  [Stop Tracking]
